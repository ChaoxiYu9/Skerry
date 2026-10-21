//! Loads the typed name projection used by the game-list ordering contract.

use super::game_name_sort_rules::{NameSortRecord, SourceNameFields, order_game_ids_by_name};
use super::game_query_rules::{GameFilter, SortDirection};
use crate::entity::prelude::GameSources;
use crate::entity::{game_sources, games};
use sea_orm::*;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};

#[derive(FromQueryResult)]
struct StoredGameNames {
    id: i32,
    id_type: String,
    custom_data: Option<Value>,
}

#[derive(FromQueryResult)]
struct StoredSourceNames {
    game_id: i32,
    source: String,
    data: Option<Value>,
}

pub(super) async fn find_name_sorted_ids<C>(
    db: &C,
    scope: GameFilter,
    direction: SortDirection,
    use_chinese_names: bool,
) -> Result<Vec<i32>, DbErr>
where
    C: ConnectionTrait,
{
    let games = scope
        .games()
        .select_only()
        .columns([
            games::Column::Id,
            games::Column::IdType,
            games::Column::CustomData,
        ])
        .into_model::<StoredGameNames>()
        .all(db)
        .await?;
    let mut records: BTreeMap<i32, NameSortRecord> = games
        .into_iter()
        .map(|game| {
            Ok((
                game.id,
                NameSortRecord {
                    id: game.id,
                    id_type: game.id_type,
                    custom_name: name_text(game.id, "custom", game.custom_data.as_ref(), "name")?,
                    custom_name_cn: name_text(
                        game.id,
                        "custom",
                        game.custom_data.as_ref(),
                        "name_cn",
                    )?,
                    sources: HashMap::new(),
                },
            ))
        })
        .collect::<Result<_, DbErr>>()?;
    if records.is_empty() {
        return Ok(Vec::new());
    }

    let game_ids = scope
        .games()
        .select_only()
        .column(games::Column::Id)
        .into_query();
    let sources = GameSources::find()
        .select_only()
        .columns([
            game_sources::Column::GameId,
            game_sources::Column::Source,
            game_sources::Column::Data,
        ])
        .filter(game_sources::Column::GameId.in_subquery(game_ids))
        .into_model::<StoredSourceNames>()
        .all(db)
        .await?;
    for source in sources {
        let names = SourceNameFields {
            name: name_text(source.game_id, &source.source, source.data.as_ref(), "name")?,
            name_cn: name_text(
                source.game_id,
                &source.source,
                source.data.as_ref(),
                "name_cn",
            )?,
        };
        let record = records.get_mut(&source.game_id).ok_or_else(|| {
            DbErr::Custom(format!("名称排序快照缺少来源所属游戏 {}", source.game_id))
        })?;
        record.sources.insert(source.source, names);
    }
    Ok(order_game_ids_by_name(
        records.into_values().collect(),
        use_chinese_names,
        direction,
    ))
}

fn name_text(
    game_id: i32,
    source: &str,
    data: Option<&Value>,
    field: &str,
) -> Result<Option<String>, DbErr> {
    match data.and_then(|data| data.get(field)) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(DbErr::Custom(format!(
            "游戏 {} 来源 {} 的 {field} 必须是字符串或 null",
            game_id, source,
        ))),
    }
}
