//! Skerry game-list scope and ordering contracts.

use super::games_repository::{GameType, SortOption, SortOrder};
use crate::entity::games;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, Select};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum GameFilter {
    All,
    Local,
    Online,
    Custom,
}

impl GameFilter {
    pub(super) fn games(self) -> Select<games::Entity> {
        let games = games::Entity::find();
        match self {
            Self::All => games,
            Self::Local => games.filter(games::Column::Localpath.is_not_null()),
            Self::Online => games.filter(games::Column::Localpath.is_null()),
            Self::Custom => games.filter(games::Column::IdType.is_in(["custom", "Whitecloud"])),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SortDirection {
    Asc,
    Desc,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SortField {
    ReleaseDate,
    LastPlayed,
    BgmScore,
    BgmRank,
    VndbScore,
    PositiveUserRating,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct SortKey {
    pub field: SortField,
    pub direction: SortDirection,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum GameSortPlan {
    ById(SortDirection),
    ByName {
        direction: SortDirection,
        use_chinese_names: bool,
    },
    ByFields(Vec<SortKey>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct GameQueryPlan {
    pub filter: GameFilter,
    pub sort: GameSortPlan,
}

fn direction(order: SortOrder) -> SortDirection {
    match order {
        SortOrder::Asc => SortDirection::Asc,
        SortOrder::Desc => SortDirection::Desc,
    }
}

fn reverse(direction: SortDirection) -> SortDirection {
    match direction {
        SortDirection::Asc => SortDirection::Desc,
        SortDirection::Desc => SortDirection::Asc,
    }
}

fn key(field: SortField, direction: SortDirection) -> SortKey {
    SortKey { field, direction }
}

pub(super) fn create_game_query_plan(
    game_type: GameType,
    sort_option: SortOption,
    sort_order: SortOrder,
    language: Option<&str>,
) -> GameQueryPlan {
    let filter = match game_type {
        GameType::All => GameFilter::All,
        GameType::Local => GameFilter::Local,
        GameType::Online => GameFilter::Online,
        GameType::IsCustom => GameFilter::Custom,
    };
    let requested_direction = direction(sort_order);

    let sort = match sort_option {
        SortOption::Addtime => GameSortPlan::ById(requested_direction),
        SortOption::Datetime => {
            GameSortPlan::ByFields(vec![key(SortField::ReleaseDate, requested_direction)])
        }
        SortOption::LastPlayed => {
            GameSortPlan::ByFields(vec![key(SortField::LastPlayed, requested_direction)])
        }
        SortOption::BGMRank => GameSortPlan::ByFields(vec![
            key(SortField::BgmScore, reverse(requested_direction)),
            key(SortField::BgmRank, requested_direction),
        ]),
        SortOption::VNDBRank => GameSortPlan::ByFields(vec![key(
            SortField::VndbScore,
            reverse(requested_direction),
        )]),
        SortOption::UserRatingRank => GameSortPlan::ByFields(vec![key(
            SortField::PositiveUserRating,
            reverse(requested_direction),
        )]),
        SortOption::Namesort => GameSortPlan::ByName {
            direction: requested_direction,
            use_chinese_names: language == Some("zh-CN"),
        },
    };

    GameQueryPlan { filter, sort }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scopes_map_to_the_existing_library_filters() {
        let cases = [
            (GameType::All, GameFilter::All),
            (GameType::Local, GameFilter::Local),
            (GameType::Online, GameFilter::Online),
            (GameType::IsCustom, GameFilter::Custom),
        ];

        for (game_type, expected) in cases {
            assert_eq!(
                create_game_query_plan(game_type, SortOption::Addtime, SortOrder::Asc, None,)
                    .filter,
                expected,
            );
        }
    }

    #[test]
    fn filters_render_the_existing_list_scope_predicates() {
        let cases = [
            (GameFilter::All, None),
            (
                GameFilter::Local,
                Some("\"games\".\"localpath\" IS NOT NULL"),
            ),
            (GameFilter::Online, Some("\"games\".\"localpath\" IS NULL")),
            (
                GameFilter::Custom,
                Some("\"games\".\"id_type\" IN ('custom', 'Whitecloud')"),
            ),
        ];

        for (filter, expected) in cases {
            use sea_orm::{DatabaseBackend, QueryTrait};
            let sql = filter.games().build(DatabaseBackend::Sqlite).to_string();
            assert_eq!(
                sql.split_once(" WHERE ").map(|(_, predicate)| predicate),
                expected
            );
        }
    }

    #[test]
    fn rating_sorts_keep_missing_values_last_and_reverse_score_direction() {
        let ascending =
            create_game_query_plan(GameType::All, SortOption::BGMRank, SortOrder::Asc, None);
        assert_eq!(
            ascending.sort,
            GameSortPlan::ByFields(vec![
                key(SortField::BgmScore, SortDirection::Desc),
                key(SortField::BgmRank, SortDirection::Asc),
            ]),
        );

        let descending =
            create_game_query_plan(GameType::All, SortOption::BGMRank, SortOrder::Desc, None);
        assert_eq!(
            descending.sort,
            GameSortPlan::ByFields(vec![
                key(SortField::BgmScore, SortDirection::Asc),
                key(SortField::BgmRank, SortDirection::Desc),
            ]),
        );
    }

    #[test]
    fn score_and_user_rating_ascending_keep_the_highest_first() {
        assert_eq!(
            create_game_query_plan(GameType::All, SortOption::VNDBRank, SortOrder::Asc, None,).sort,
            GameSortPlan::ByFields(vec![key(SortField::VndbScore, SortDirection::Desc,)]),
        );
        assert_eq!(
            create_game_query_plan(
                GameType::All,
                SortOption::UserRatingRank,
                SortOrder::Asc,
                None,
            )
            .sort,
            GameSortPlan::ByFields(vec![key(
                SortField::PositiveUserRating,
                SortDirection::Desc,
            )]),
        );
    }

    #[test]
    fn date_and_play_time_follow_the_requested_direction() {
        for (sort_option, field) in [
            (SortOption::Datetime, SortField::ReleaseDate),
            (SortOption::LastPlayed, SortField::LastPlayed),
        ] {
            assert_eq!(
                create_game_query_plan(GameType::All, sort_option, SortOrder::Asc, None,).sort,
                GameSortPlan::ByFields(vec![key(field, SortDirection::Asc)]),
            );
            assert_eq!(
                create_game_query_plan(GameType::All, sort_option, SortOrder::Desc, None,).sort,
                GameSortPlan::ByFields(vec![key(field, SortDirection::Desc)]),
            );
        }
    }

    #[test]
    fn name_language_uses_exact_chinese_locale() {
        let chinese = create_game_query_plan(
            GameType::All,
            SortOption::Namesort,
            SortOrder::Desc,
            Some("zh-CN"),
        );
        assert_eq!(
            chinese.sort,
            GameSortPlan::ByName {
                direction: SortDirection::Desc,
                use_chinese_names: true,
            },
        );
        let other_chinese_locale = create_game_query_plan(
            GameType::All,
            SortOption::Namesort,
            SortOrder::Asc,
            Some("zh-TW"),
        );
        assert!(matches!(
            other_chinese_locale.sort,
            GameSortPlan::ByName {
                use_chinese_names: false,
                ..
            }
        ));
    }
}
