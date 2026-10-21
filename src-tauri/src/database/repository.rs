pub(crate) mod collection_listing_rules;
mod collections_membership;
pub mod collections_repository;
pub mod game_import_repository;
mod game_name_sort;
mod game_name_sort_rules;
pub(crate) mod game_query_repository;
mod game_query_rules;
mod game_source_priorities;
pub(crate) mod game_sources_repository;
mod game_stats_calculation;
pub mod game_stats_repository;
pub mod games_repository;
pub mod settings_repository;

pub mod savedata_repository;

pub(crate) fn current_database_timestamp() -> Result<i32, sea_orm::DbErr> {
    database_timestamp_from_unix_seconds(chrono::Utc::now().timestamp())
}

pub(crate) fn to_database_game_id(game_id: i64) -> Option<i32> {
    i32::try_from(game_id).ok()
}

fn database_timestamp_from_unix_seconds(seconds: i64) -> Result<i32, sea_orm::DbErr> {
    i32::try_from(seconds)
        .map_err(|_| sea_orm::DbErr::Custom("当前时间超出数据库整数范围".to_string()))
}

#[cfg(test)]
mod timestamp_tests {
    use super::database_timestamp_from_unix_seconds;

    #[test]
    fn database_timestamp_accepts_signed_i32_boundaries() {
        assert_eq!(
            database_timestamp_from_unix_seconds(i64::from(i32::MIN)).unwrap(),
            i32::MIN
        );
        assert_eq!(
            database_timestamp_from_unix_seconds(i64::from(i32::MAX)).unwrap(),
            i32::MAX
        );
    }

    #[test]
    fn database_timestamp_rejects_values_outside_signed_i32_boundaries() {
        let first_out_of_range_positive = i64::from(i32::MAX) + 1;
        let first_out_of_range_negative = i64::from(i32::MIN) - 1;

        assert!(database_timestamp_from_unix_seconds(first_out_of_range_positive).is_err());
        assert!(database_timestamp_from_unix_seconds(first_out_of_range_negative).is_err());
    }
}

#[cfg(test)]
mod game_id_tests {
    use super::to_database_game_id;

    #[test]
    fn database_game_id_accepts_signed_i32_boundaries() {
        assert_eq!(to_database_game_id(i64::from(i32::MIN)), Some(i32::MIN));
        assert_eq!(to_database_game_id(i64::from(i32::MAX)), Some(i32::MAX));
    }

    #[test]
    fn database_game_id_rejects_values_outside_signed_i32_boundaries() {
        let first_out_of_range_positive = i64::from(i32::MAX) + 1;
        let first_out_of_range_negative = i64::from(i32::MIN) - 1;

        assert_eq!(to_database_game_id(first_out_of_range_positive), None);
        assert_eq!(to_database_game_id(first_out_of_range_negative), None);
    }
}
