use super::games_repository::SortOrder;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CollectionBackendSortField {
    CreatedAt,
    UpdatedAt,
    GameCount,
}

pub(crate) fn validate_collection_sort(
    sort_field: Option<CollectionBackendSortField>,
    sort_order: Option<SortOrder>,
) -> Result<Option<(CollectionBackendSortField, SortOrder)>, String> {
    match (sort_field, sort_order) {
        (None, None) => Ok(None),
        (Some(field), Some(order)) => Ok(Some((field, order))),
        _ => Err("排序字段和排序方向必须同时提供".to_string()),
    }
}

/// Only enum-selected SQL is returned; caller strings never become identifiers.
/// Nullable dates always follow known dates, and IDs stabilize every tie.
pub(super) fn collection_order_clause(
    sort: Option<(CollectionBackendSortField, SortOrder)>,
) -> &'static str {
    use CollectionBackendSortField::{CreatedAt, GameCount, UpdatedAt};
    use SortOrder::{Asc, Desc};
    match sort {
        None => "sort_order ASC, id ASC",
        Some((CreatedAt, Asc)) => "created_at IS NULL ASC, created_at ASC, id ASC",
        Some((CreatedAt, Desc)) => "created_at IS NULL ASC, created_at DESC, id ASC",
        Some((UpdatedAt, Asc)) => "updated_at IS NULL ASC, updated_at ASC, id ASC",
        Some((UpdatedAt, Desc)) => "updated_at IS NULL ASC, updated_at DESC, id ASC",
        Some((GameCount, Asc)) => "game_count ASC, id ASC",
        Some((GameCount, Desc)) => "game_count DESC, id ASC",
    }
}

#[cfg(test)]
mod tests {
    use super::{CollectionBackendSortField, collection_order_clause, validate_collection_sort};
    use crate::database::repository::games_repository::SortOrder;
    use sea_orm::{ConnectionTrait, Database, DatabaseConnection, Statement};

    #[test]
    fn collection_sort_arguments_must_be_both_absent_or_both_present() {
        assert!(validate_collection_sort(None, None).unwrap().is_none());
        assert!(matches!(
            validate_collection_sort(
                Some(CollectionBackendSortField::GameCount),
                Some(SortOrder::Desc)
            ),
            Ok(Some((
                CollectionBackendSortField::GameCount,
                SortOrder::Desc
            )))
        ));
        assert_eq!(
            validate_collection_sort(Some(CollectionBackendSortField::GameCount), None)
                .unwrap_err(),
            "排序字段和排序方向必须同时提供"
        );
        assert_eq!(
            validate_collection_sort(None, Some(SortOrder::Asc)).unwrap_err(),
            "排序字段和排序方向必须同时提供"
        );
    }

    async fn sort_database() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("排序数据库应连接成功");
        db.execute_unprepared("CREATE TABLE listing (id INTEGER, sort_order INTEGER, created_at INTEGER, updated_at INTEGER, game_count INTEGER)").await.expect("应创建排序样本表");
        db.execute_unprepared("INSERT INTO listing VALUES (4, 0, NULL, NULL, 7), (3, 0, 10, 20, 2), (2, 0, 20, 30, 1), (5, 0, 10, 20, 2), (1, 0, NULL, NULL, 0)").await.expect("应写入排序样本");
        db
    }

    async fn sorted_ids(
        db: &DatabaseConnection,
        sort: Option<(CollectionBackendSortField, SortOrder)>,
    ) -> Vec<i32> {
        let sql = format!(
            "SELECT id FROM listing ORDER BY {}",
            collection_order_clause(sort)
        );
        db.query_all(Statement::from_string(db.get_database_backend(), sql))
            .await
            .expect("排序查询应成功")
            .into_iter()
            .map(|row| row.try_get("", "id").expect("ID 应为 i32"))
            .collect()
    }

    #[tokio::test]
    async fn missing_dates_stay_last_in_both_directions_and_ties_use_id_ascending() {
        let db = sort_database().await;
        for field in [
            CollectionBackendSortField::CreatedAt,
            CollectionBackendSortField::UpdatedAt,
        ] {
            assert_eq!(
                sorted_ids(&db, Some((field, SortOrder::Desc))).await,
                [2, 3, 5, 1, 4]
            );
            assert_eq!(
                sorted_ids(&db, Some((field, SortOrder::Asc))).await,
                [3, 5, 2, 1, 4]
            );
        }
    }

    #[tokio::test]
    async fn game_count_sort_respects_direction_but_keeps_id_ties_ascending() {
        let db = sort_database().await;
        assert_eq!(
            sorted_ids(
                &db,
                Some((CollectionBackendSortField::GameCount, SortOrder::Desc))
            )
            .await,
            [4, 3, 5, 2, 1]
        );
        assert_eq!(
            sorted_ids(
                &db,
                Some((CollectionBackendSortField::GameCount, SortOrder::Asc))
            )
            .await,
            [1, 2, 3, 5, 4]
        );
        assert_eq!(sorted_ids(&db, None).await, [1, 2, 3, 4, 5]);
    }
}
