//! Reads one game aggregate from its stored rows and shares ordering across list APIs.

use super::game_query_rules::{
    GameQueryPlan, GameSortPlan, SortDirection, SortField, create_game_query_plan,
};
use super::games_repository::{GameType, SortOption, SortOrder};
use crate::database::dto::{FullGameData, GameSourceData};
use crate::entity::prelude::*;
use crate::entity::{game_sources, games};
use sea_orm::sea_query::{Alias, Expr, IntoCondition};
use sea_orm::*;
use serde_json::Value;
use std::collections::HashMap;

pub(crate) struct GameQueryRepository;

#[derive(FromQueryResult)]
struct StoredGameSource {
    game_id: i32,
    source: String,
    external_id: Option<String>,
    data: Option<Value>,
}

impl GameQueryRepository {
    /// The caller may already hold a write transaction. Read through that same connection.
    pub(super) async fn find_full_by_id<C>(db: &C, id: i32) -> Result<Option<FullGameData>, DbErr>
    where
        C: ConnectionTrait,
    {
        let Some(game) = Games::find_by_id(id).one(db).await? else {
            return Ok(None);
        };
        let sources = GameSources::find()
            .select_only()
            .columns([
                game_sources::Column::GameId,
                game_sources::Column::Source,
                game_sources::Column::ExternalId,
                game_sources::Column::Data,
            ])
            .filter(game_sources::Column::GameId.eq(id))
            .order_by_asc(game_sources::Column::Source)
            .into_model::<StoredGameSource>()
            .all(db)
            .await?;
        Ok(Some(Self::assemble_game(game, sources)))
    }

    pub(crate) async fn find_by_id(
        db: &DatabaseConnection,
        id: i32,
    ) -> Result<Option<FullGameData>, DbErr> {
        let snapshot = db.begin().await?;
        let game = Self::find_full_by_id(&snapshot, id).await?;
        snapshot.commit().await?;
        Ok(game)
    }

    pub(crate) async fn find_all(
        db: &DatabaseConnection,
        game_type: GameType,
        sort_option: SortOption,
        sort_order: SortOrder,
        language: Option<String>,
    ) -> Result<Vec<FullGameData>, DbErr> {
        let plan = create_game_query_plan(game_type, sort_option, sort_order, language.as_deref());
        let snapshot = db.begin().await?;
        let ordered_ids = Self::ordered_ids(&snapshot, &plan).await?;
        if ordered_ids.is_empty() {
            snapshot.commit().await?;
            return Ok(Vec::new());
        }

        // Scope subqueries avoid one bound parameter per game and SQLite's variable limit.
        let stored_games = plan.filter.games().all(&snapshot).await?;
        let scope_ids = plan
            .filter
            .games()
            .select_only()
            .column(games::Column::Id)
            .into_query();
        let stored_sources = GameSources::find()
            .select_only()
            .columns([
                game_sources::Column::GameId,
                game_sources::Column::Source,
                game_sources::Column::ExternalId,
                game_sources::Column::Data,
            ])
            .filter(game_sources::Column::GameId.in_subquery(scope_ids))
            .order_by_asc(game_sources::Column::Source)
            .into_model::<StoredGameSource>()
            .all(&snapshot)
            .await?;
        let mut sources_by_game: HashMap<i32, Vec<StoredGameSource>> = HashMap::new();
        for source in stored_sources {
            sources_by_game
                .entry(source.game_id)
                .or_default()
                .push(source);
        }
        let mut games_by_id: HashMap<i32, FullGameData> = stored_games
            .into_iter()
            .map(|game| {
                let sources = sources_by_game.remove(&game.id).unwrap_or_default();
                (game.id, Self::assemble_game(game, sources))
            })
            .collect();
        let games = ordered_ids
            .into_iter()
            .map(|id| {
                games_by_id
                    .remove(&id)
                    .ok_or_else(|| DbErr::Custom(format!("游戏列表快照缺少已排序的游戏 {id}")))
            })
            .collect::<Result<Vec<_>, _>>()?;
        snapshot.commit().await?;
        Ok(games)
    }

    pub(crate) async fn find_ids(
        db: &DatabaseConnection,
        game_type: GameType,
        sort_option: SortOption,
        sort_order: SortOrder,
        language: Option<String>,
    ) -> Result<Vec<i32>, DbErr> {
        let plan = create_game_query_plan(game_type, sort_option, sort_order, language.as_deref());
        let snapshot = db.begin().await?;
        let ids = Self::ordered_ids(&snapshot, &plan).await?;
        snapshot.commit().await?;
        Ok(ids)
    }

    pub(crate) async fn count(db: &DatabaseConnection) -> Result<u64, DbErr> {
        Games::find().count(db).await
    }

    async fn ordered_ids<C>(db: &C, plan: &GameQueryPlan) -> Result<Vec<i32>, DbErr>
    where
        C: ConnectionTrait,
    {
        if let GameSortPlan::ByName {
            direction,
            use_chinese_names,
        } = plan.sort
        {
            return super::game_name_sort::find_name_sorted_ids(
                db,
                plan.filter,
                direction,
                use_chinese_names,
            )
            .await;
        }

        let mut query = plan.filter.games().select_only().column(games::Column::Id);
        match &plan.sort {
            GameSortPlan::ById(direction) => {
                query = query.order_by(games::Column::Id, database_order(*direction));
            }
            GameSortPlan::ByFields(keys) => {
                if keys.iter().any(|key| key.field == SortField::LastPlayed) {
                    query = query.join(JoinType::LeftJoin, games::Relation::GameStatistics.def());
                }
                if keys
                    .iter()
                    .any(|key| matches!(key.field, SortField::BgmScore | SortField::BgmRank))
                {
                    query = query.join_as(
                        JoinType::LeftJoin,
                        games::Relation::GameSources
                            .def()
                            .on_condition(|_, source_table| {
                                Expr::col((source_table, game_sources::Column::Source))
                                    .eq("bgm")
                                    .into_condition()
                            }),
                        Alias::new("bgm_source"),
                    );
                }
                if keys.iter().any(|key| key.field == SortField::VndbScore) {
                    query = query.join_as(
                        JoinType::LeftJoin,
                        games::Relation::GameSources
                            .def()
                            .on_condition(|_, source_table| {
                                Expr::col((source_table, game_sources::Column::Source))
                                    .eq("vndb")
                                    .into_condition()
                            }),
                        Alias::new("vndb_source"),
                    );
                }
                for key in keys {
                    let (missing, value) = ordering_expressions(key.field);
                    query = query
                        .order_by(Expr::cust(missing), Order::Asc)
                        .order_by(Expr::cust(value), database_order(key.direction));
                }
                query = query.order_by_asc(games::Column::Id);
            }
            GameSortPlan::ByName { .. } => unreachable!("name ordering returned above"),
        }
        query.into_tuple::<i32>().all(db).await
    }

    fn assemble_game(game: games::Model, sources: Vec<StoredGameSource>) -> FullGameData {
        FullGameData {
            id: game.id,
            id_type: game.id_type,
            date: game.date,
            localpath: game.localpath,
            executable: game.executable,
            launch_type: game.launch_type,
            steam_launch_id: game.steam_launch_id,
            savepath: game.savepath,
            autosave: game.autosave,
            maxbackups: game.maxbackups,
            clear: game.clear,
            le_launch: game.le_launch,
            magpie: game.magpie,
            custom_data: game.custom_data,
            sources: sources
                .into_iter()
                .map(|source| GameSourceData {
                    source: source.source,
                    external_id: source.external_id,
                    data: source.data,
                })
                .collect(),
            created_at: game.created_at,
            updated_at: game.updated_at,
        }
    }
}

fn database_order(direction: SortDirection) -> Order {
    match direction {
        SortDirection::Asc => Order::Asc,
        SortDirection::Desc => Order::Desc,
    }
}

fn ordering_expressions(field: SortField) -> (&'static str, &'static str) {
    match field {
        SortField::ReleaseDate => ("games.date IS NULL", "games.date"),
        SortField::LastPlayed => (
            "game_statistics.last_played IS NULL",
            "game_statistics.last_played",
        ),
        SortField::BgmScore => (
            "NULLIF(bgm_source.score, 0) IS NULL",
            "NULLIF(bgm_source.score, 0)",
        ),
        SortField::BgmRank => (
            "NULLIF(bgm_source.rank, 0) IS NULL",
            "NULLIF(bgm_source.rank, 0)",
        ),
        SortField::VndbScore => (
            "NULLIF(vndb_source.score, 0) IS NULL",
            "NULLIF(vndb_source.score, 0)",
        ),
        SortField::PositiveUserRating => (
            "(games.user_rating IS NULL OR games.user_rating <= 0)",
            "games.user_rating",
        ),
    }
}
