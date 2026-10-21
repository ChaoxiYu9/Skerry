use super::collection_listing_rules::collection_order_clause;
use super::collections_membership::{
    GameCollectionInsert, GameCollectionPair, MembershipLink, MembershipPlanError,
    build_category_games_diff, diff_membership_request, plan_membership_request,
    unique_ids_in_order,
};
use super::current_database_timestamp;
use crate::database::dto::{InsertCollectionData, UpdateCollectionData};
use crate::database::repository::games_repository::SortOrder;
use crate::entity::prelude::*;
use crate::entity::{collections, game_collection_link};
use sea_orm::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

pub use super::collection_listing_rules::CollectionBackendSortField;

/// Owns collection persistence, count projections and atomic membership changes.
pub struct CollectionsRepository;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CategoryWithCount {
    pub id: i32,
    pub name: String,
    pub icon: Option<String>,
    pub sort_order: i32,
    pub game_count: u64,
    pub created_at: Option<i32>,
    pub updated_at: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupWithCount {
    pub id: i32,
    pub name: String,
    pub icon: Option<String>,
    pub sort_order: i32,
    pub game_count: u64,
    pub created_at: Option<i32>,
    pub updated_at: Option<i32>,
}

#[derive(Debug, FromQueryResult)]
struct CollectionCountRow {
    id: i32,
    name: String,
    icon: Option<String>,
    sort_order: i32,
    game_count: i64,
    created_at: Option<i32>,
    updated_at: Option<i32>,
}

// These values are typed database integers, never caller-supplied SQL. Literal
// lists keep bulk operations independent of SQLite's bind-parameter limit.
fn integer_list(ids: impl IntoIterator<Item = i32>) -> String {
    ids.into_iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(",")
}

impl CollectionsRepository {
    pub async fn create(
        db: &DatabaseConnection,
        data: InsertCollectionData,
    ) -> Result<collections::Model, DbErr> {
        let now = current_database_timestamp()?;
        collections::ActiveModel {
            id: NotSet,
            name: Set(data.name),
            parent_id: Set(data.parent_id),
            sort_order: Set(data.sort_order),
            icon: Set(data.icon),
            created_at: Set(Some(now)),
            updated_at: Set(Some(now)),
        }
        .insert(db)
        .await
    }

    pub async fn find_root_collections(
        db: &DatabaseConnection,
    ) -> Result<Vec<collections::Model>, DbErr> {
        Collections::find()
            .filter(collections::Column::ParentId.is_null())
            .order_by_asc(collections::Column::SortOrder)
            .order_by_asc(collections::Column::Id)
            .all(db)
            .await
    }

    /// Omitted fields never enter the SQL patch. A single UPDATE returns the
    /// saved row, so concurrent independent patches cannot restore stale fields.
    pub async fn update(
        db: &DatabaseConnection,
        id: i32,
        data: UpdateCollectionData,
    ) -> Result<collections::Model, DbErr> {
        let mut assignments = vec!["updated_at = ?"];
        let mut values: Vec<Value> = vec![current_database_timestamp()?.into()];
        if let Some(name) = data.name {
            assignments.push("name = ?");
            values.push(name.into());
        }
        if let Some(parent_id) = data.parent_id {
            assignments.push("parent_id = ?");
            values.push(parent_id.into());
        }
        if let Some(sort_order) = data.sort_order {
            assignments.push("sort_order = ?");
            values.push(sort_order.into());
        }
        if let Some(icon) = data.icon {
            assignments.push("icon = ?");
            values.push(icon.into());
        }
        values.push(id.into());
        let sql = format!(
            "UPDATE collections SET {} WHERE id = ? RETURNING id, name, parent_id, sort_order, icon, created_at, updated_at",
            assignments.join(", ")
        );
        collections::Model::find_by_statement(Statement::from_sql_and_values(
            db.get_database_backend(),
            sql,
            values,
        ))
        .one(db)
        .await?
        .ok_or_else(|| DbErr::RecordNotFound("Collection not found".to_string()))
    }

    /// Foreign-key cascades own descendant and membership removal.
    pub async fn delete(db: &DatabaseConnection, id: i32) -> Result<DeleteResult, DbErr> {
        Collections::delete_by_id(id).exec(db).await
    }

    pub async fn remove_games_from_collection(
        db: &DatabaseConnection,
        game_ids: Vec<i32>,
        collection_id: i32,
    ) -> Result<DeleteResult, DbErr> {
        let game_ids = unique_ids_in_order(game_ids);
        if game_ids.is_empty() {
            return Ok(DeleteResult { rows_affected: 0 });
        }
        let sql = format!(
            "DELETE FROM game_collection_link WHERE collection_id = {collection_id} AND game_id IN ({})",
            integer_list(game_ids)
        );
        let result = db
            .execute(Statement::from_string(db.get_database_backend(), sql))
            .await?;
        Ok(DeleteResult {
            rows_affected: result.rows_affected(),
        })
    }

    pub async fn get_games_in_collection(
        db: &DatabaseConnection,
        collection_id: i32,
    ) -> Result<Vec<i32>, DbErr> {
        GameCollectionLink::find()
            .filter(game_collection_link::Column::CollectionId.eq(collection_id))
            .order_by_asc(game_collection_link::Column::SortOrder)
            .all(db)
            .await
            .map(|links| links.into_iter().map(|link| link.game_id).collect())
    }

    pub async fn get_game_collection_ids(
        db: &DatabaseConnection,
        game_id: i32,
    ) -> Result<Vec<i32>, DbErr> {
        GameCollectionLink::find()
            .filter(game_collection_link::Column::GameId.eq(game_id))
            .order_by_asc(game_collection_link::Column::CollectionId)
            .all(db)
            .await
            .map(|links| links.into_iter().map(|link| link.collection_id).collect())
    }

    async fn load_memberships(
        txn: &DatabaseTransaction,
        predicate: String,
    ) -> Result<Vec<MembershipLink>, DbErr> {
        let sql = format!(
            "SELECT id, game_id, collection_id, sort_order, created_at FROM game_collection_link WHERE {predicate} ORDER BY id ASC"
        );
        let links = game_collection_link::Model::find_by_statement(Statement::from_string(
            txn.get_database_backend(),
            sql,
        ))
        .all(txn)
        .await?;
        Ok(links
            .into_iter()
            .map(|link| MembershipLink {
                link_id: link.id,
                game_id: link.game_id,
                collection_id: link.collection_id,
                sort_order: link.sort_order,
            })
            .collect())
    }

    async fn delete_game_collection_links(
        txn: &DatabaseTransaction,
        link_ids: Vec<i32>,
    ) -> Result<(), DbErr> {
        if !link_ids.is_empty() {
            let sql = format!(
                "DELETE FROM game_collection_link WHERE id IN ({})",
                integer_list(link_ids)
            );
            txn.execute(Statement::from_string(txn.get_database_backend(), sql))
                .await?;
        }
        Ok(())
    }

    async fn insert_game_collection_links(
        txn: &DatabaseTransaction,
        inserts: Vec<GameCollectionInsert>,
    ) -> Result<(), DbErr> {
        if inserts.is_empty() {
            return Ok(());
        }
        let now = current_database_timestamp()?;
        let rows = inserts
            .into_iter()
            .map(|row| {
                format!(
                    "({}, {}, {}, {now})",
                    row.game_id, row.collection_id, row.sort_order
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "INSERT INTO game_collection_link (game_id, collection_id, sort_order, created_at) VALUES {rows}"
        );
        txn.execute(Statement::from_string(txn.get_database_backend(), sql))
            .await?;
        Ok(())
    }

    async fn update_game_collection_sort_orders(
        txn: &DatabaseTransaction,
        updates: Vec<(i32, i32)>,
    ) -> Result<(), DbErr> {
        if updates.is_empty() {
            return Ok(());
        }
        let cases = updates
            .iter()
            .map(|(id, order)| format!("WHEN {id} THEN {order}"))
            .collect::<Vec<_>>()
            .join(" ");
        let ids = integer_list(updates.into_iter().map(|(id, _)| id));
        let sql = format!(
            "UPDATE game_collection_link SET sort_order = CASE id {cases} ELSE sort_order END WHERE id IN ({ids})"
        );
        txn.execute(Statement::from_string(txn.get_database_backend(), sql))
            .await?;
        Ok(())
    }

    /// Read each target collection's append cursor once. Cursors use i64 during
    /// planning; only values representable by the stored i32 column are emitted.
    async fn build_append_inserts(
        txn: &DatabaseTransaction,
        pairs: Vec<GameCollectionPair>,
    ) -> Result<Vec<GameCollectionInsert>, DbErr> {
        if pairs.is_empty() {
            return Ok(Vec::new());
        }
        let collection_ids: HashSet<_> = pairs.iter().map(|pair| pair.collection_id).collect();
        let sql = format!(
            "SELECT collection_id, MAX(sort_order) AS last_sort_order FROM game_collection_link WHERE collection_id IN ({}) GROUP BY collection_id",
            integer_list(collection_ids)
        );
        let rows = txn
            .query_all(Statement::from_string(txn.get_database_backend(), sql))
            .await?;
        let mut next_orders = HashMap::new();
        for row in rows {
            let collection_id: i32 = row.try_get("", "collection_id")?;
            let last_order: i32 = row.try_get("", "last_sort_order")?;
            next_orders.insert(collection_id, i64::from(last_order) + 1);
        }
        pairs
            .into_iter()
            .map(|pair| {
                let cursor = next_orders.entry(pair.collection_id).or_insert(0);
                let sort_order = i32::try_from(*cursor)
                    .map_err(|_| DbErr::Custom("合集成员排序已达到 i32 可表示上限".to_string()))?;
                *cursor += 1;
                Ok(GameCollectionInsert {
                    game_id: pair.game_id,
                    collection_id: pair.collection_id,
                    sort_order,
                })
            })
            .collect()
    }

    pub async fn add_games_to_collections(
        db: &DatabaseConnection,
        game_ids: Vec<i32>,
        collection_ids: Vec<i32>,
    ) -> Result<(), DbErr> {
        let request = plan_membership_request(game_ids, collection_ids);
        if request.game_ids.is_empty() || request.collection_ids.is_empty() {
            return Ok(());
        }
        let txn = db.begin().await?;
        let predicate = format!(
            "game_id IN ({}) AND collection_id IN ({})",
            integer_list(request.game_ids.iter().copied()),
            integer_list(request.collection_ids.iter().copied())
        );
        let existing = Self::load_memberships(&txn, predicate).await?;
        let missing = diff_membership_request(&existing, &request).to_insert;
        let inserts = Self::build_append_inserts(&txn, missing).await?;
        Self::insert_game_collection_links(&txn, inserts).await?;
        txn.commit().await
    }

    pub async fn set_game_collections(
        db: &DatabaseConnection,
        game_id: i32,
        collection_ids: Vec<i32>,
    ) -> Result<(), DbErr> {
        let request = plan_membership_request(vec![game_id], collection_ids);
        let txn = db.begin().await?;
        let existing = Self::load_memberships(&txn, format!("game_id = {game_id}")).await?;
        let changes = diff_membership_request(&existing, &request);
        // Plan every insertion before any deletion, so range failures leave the
        // transaction unchanged and existing links retain their creation data.
        let inserts = Self::build_append_inserts(&txn, changes.to_insert).await?;
        Self::delete_game_collection_links(&txn, changes.to_delete_link_ids).await?;
        Self::insert_game_collection_links(&txn, inserts).await?;
        txn.commit().await
    }

    pub async fn update_category_games(
        db: &DatabaseConnection,
        new_game_ids: Vec<i32>,
        collection_id: i32,
    ) -> Result<(), DbErr> {
        let txn = db.begin().await?;
        let existing =
            Self::load_memberships(&txn, format!("collection_id = {collection_id}")).await?;
        let changes =
            build_category_games_diff(&existing, new_game_ids, collection_id).map_err(|error| {
                match error {
                    MembershipPlanError::SortOrderOutOfRange => {
                        DbErr::Custom("分类成员排序位置超出 i32 可表示范围".to_string())
                    }
                }
            })?;
        Self::delete_game_collection_links(&txn, changes.to_delete_link_ids).await?;
        Self::update_game_collection_sort_orders(&txn, changes.to_update_sort_orders).await?;
        Self::insert_game_collection_links(&txn, changes.to_insert).await?;
        txn.commit().await
    }

    /// A group's count includes distinct games in its immediate categories.
    /// Direct root memberships and deeper descendants are intentionally excluded.
    pub async fn get_root_collections_with_count(
        db: &DatabaseConnection,
        sort: Option<(CollectionBackendSortField, SortOrder)>,
    ) -> Result<Vec<GroupWithCount>, DbErr> {
        let sql = format!(
            "SELECT c.id, c.name, c.icon, c.sort_order, c.created_at, c.updated_at, (SELECT COUNT(DISTINCT member.game_id) FROM collections AS child JOIN game_collection_link AS member ON member.collection_id = child.id WHERE child.parent_id = c.id) AS game_count FROM collections AS c WHERE c.parent_id IS NULL ORDER BY {}",
            collection_order_clause(sort)
        );
        let rows = CollectionCountRow::find_by_statement(Statement::from_string(
            db.get_database_backend(),
            sql,
        ))
        .all(db)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(GroupWithCount {
                    id: row.id,
                    name: row.name,
                    icon: row.icon,
                    sort_order: row.sort_order,
                    game_count: u64::try_from(row.game_count)
                        .map_err(|_| DbErr::Custom("分组游戏数量超出可表示范围".to_string()))?,
                    created_at: row.created_at,
                    updated_at: row.updated_at,
                })
            })
            .collect()
    }

    pub async fn batch_count_games_in_groups(
        db: &DatabaseConnection,
        group_ids: Vec<i32>,
    ) -> Result<HashMap<i32, u64>, DbErr> {
        if group_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let mut counts: HashMap<_, _> = group_ids.iter().copied().map(|id| (id, 0)).collect();
        let sql = format!(
            "SELECT child.parent_id AS group_id, COUNT(DISTINCT member.game_id) AS game_count FROM collections AS child JOIN game_collection_link AS member ON member.collection_id = child.id WHERE child.parent_id IN ({}) GROUP BY child.parent_id",
            integer_list(unique_ids_in_order(group_ids))
        );
        for row in db
            .query_all(Statement::from_string(db.get_database_backend(), sql))
            .await?
        {
            let group_id: i32 = row.try_get("", "group_id")?;
            let game_count: i64 = row.try_get("", "game_count")?;
            let game_count = u64::try_from(game_count)
                .map_err(|_| DbErr::Custom("分组游戏数量超出可表示范围".to_string()))?;
            counts.insert(group_id, game_count);
        }
        Ok(counts)
    }

    pub async fn count_games_in_group(
        db: &DatabaseConnection,
        group_id: i32,
    ) -> Result<u64, DbErr> {
        let counts = Self::batch_count_games_in_groups(db, vec![group_id]).await?;
        Ok(counts.get(&group_id).copied().unwrap_or_default())
    }

    pub async fn get_categories_with_count(
        db: &DatabaseConnection,
        group_id: i32,
        sort: Option<(CollectionBackendSortField, SortOrder)>,
    ) -> Result<Vec<CategoryWithCount>, DbErr> {
        let sql = format!(
            "SELECT c.id, c.name, c.icon, c.sort_order, c.created_at, c.updated_at, (SELECT COUNT(*) FROM game_collection_link AS member WHERE member.collection_id = c.id) AS game_count FROM collections AS c WHERE c.parent_id = ? ORDER BY {}",
            collection_order_clause(sort)
        );
        let rows = CollectionCountRow::find_by_statement(Statement::from_sql_and_values(
            db.get_database_backend(),
            sql,
            [Value::Int(Some(group_id))],
        ))
        .all(db)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(CategoryWithCount {
                    id: row.id,
                    name: row.name,
                    icon: row.icon,
                    sort_order: row.sort_order,
                    game_count: u64::try_from(row.game_count)
                        .map_err(|_| DbErr::Custom("分类游戏数量超出可表示范围".to_string()))?,
                    created_at: row.created_at,
                    updated_at: row.updated_at,
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::{CollectionBackendSortField, CollectionsRepository, UpdateCollectionData};
    use crate::database::repository::games_repository::SortOrder;
    use crate::entity::{
        game_collection_link,
        prelude::{Collections, GameCollectionLink},
    };
    use sea_orm::{
        ColumnTrait, ConnectOptions, ConnectionTrait, Database, DatabaseConnection, EntityTrait,
        QueryFilter, QueryOrder, TransactionTrait,
    };

    async fn membership_database() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("内存数据库应连接成功");
        db.execute_unprepared(
            r#"CREATE TABLE game_collection_link (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                game_id INTEGER NOT NULL,
                collection_id INTEGER NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER
            )"#,
        )
        .await
        .expect("应创建关联表");
        db.execute_unprepared(
            "CREATE UNIQUE INDEX idx_test_game_collection_unique ON game_collection_link(game_id, collection_id)",
        )
        .await
        .expect("应创建数据库中的成员唯一约束");
        db
    }

    async fn category_links(db: &DatabaseConnection) -> Vec<(i32, i32, i32)> {
        GameCollectionLink::find()
            .filter(game_collection_link::Column::CollectionId.eq(5))
            .order_by_asc(game_collection_link::Column::SortOrder)
            .all(db)
            .await
            .expect("分类成员查询应成功")
            .into_iter()
            .map(|link| (link.id, link.game_id, link.sort_order))
            .collect()
    }

    async fn game_links(db: &DatabaseConnection, game_id: i32) -> Vec<(i32, i32, i32)> {
        GameCollectionLink::find()
            .filter(game_collection_link::Column::GameId.eq(game_id))
            .order_by_asc(game_collection_link::Column::CollectionId)
            .all(db)
            .await
            .expect("游戏合集关系查询应成功")
            .into_iter()
            .map(|link| (link.collection_id, link.sort_order, link.id))
            .collect()
    }

    async fn collection_database() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("内存数据库应连接成功");
        db.execute_unprepared(
            r#"CREATE TABLE collections (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                parent_id INTEGER,
                sort_order INTEGER NOT NULL DEFAULT 0,
                icon TEXT,
                created_at INTEGER,
                updated_at INTEGER
            )"#,
        )
        .await
        .expect("应创建最小收藏夹表");
        db.execute_unprepared(
            r#"INSERT INTO collections (id, name, parent_id, sort_order) VALUES
                (30, 'Group 30', NULL, 0),
                (10, 'Group 10', NULL, 0),
                (20, 'Group 20', NULL, 0),
                (40, 'Category 40', 10, 0),
                (35, 'Category 35', 10, 0)"#,
        )
        .await
        .expect("应写入排序样本");
        db
    }

    async fn single_connection_collection_database() -> DatabaseConnection {
        let mut options = ConnectOptions::new("sqlite::memory:");
        options.max_connections(1).min_connections(1);
        let db = Database::connect(options)
            .await
            .expect("单连接内存数据库应连接成功");
        db.execute_unprepared(
            r#"CREATE TABLE collections (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                parent_id INTEGER,
                sort_order INTEGER NOT NULL DEFAULT 0,
                icon TEXT,
                created_at INTEGER,
                updated_at INTEGER
            )"#,
        )
        .await
        .expect("应创建最小收藏夹表");
        db.execute_unprepared(
            "INSERT INTO collections (id, name, parent_id, sort_order, icon, created_at, updated_at) VALUES (60, 'Original', 10, 0, 'icon.png', 1, 0)",
        )
        .await
        .expect("应创建部分更新测试行");
        db
    }

    async fn collection_count_database() -> DatabaseConnection {
        let db = collection_database().await;
        db.execute_unprepared(
            r#"CREATE TABLE game_collection_link (
                id INTEGER PRIMARY KEY,
                game_id INTEGER NOT NULL,
                collection_id INTEGER NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER
            )"#,
        )
        .await
        .expect("应创建游戏合集关联表");
        db
    }

    #[tokio::test]
    async fn default_collection_order_uses_id_to_break_sort_order_ties() {
        let db = collection_count_database().await;

        let groups = CollectionsRepository::find_root_collections(&db)
            .await
            .expect("根分组查询应成功");
        let categories = CollectionsRepository::get_categories_with_count(&db, 10, None)
            .await
            .expect("子分类及成员数查询应成功");

        assert_eq!(
            groups.iter().map(|group| group.id).collect::<Vec<_>>(),
            [10, 20, 30]
        );
        assert_eq!(
            categories
                .iter()
                .map(|category| category.id)
                .collect::<Vec<_>>(),
            [35, 40]
        );
    }

    #[tokio::test]
    async fn collection_patch_clears_nullable_fields_without_changing_omitted_values() {
        let db = single_connection_collection_database().await;
        let saved = CollectionsRepository::update(
            &db,
            60,
            UpdateCollectionData {
                name: None,
                parent_id: Some(None),
                sort_order: None,
                icon: Some(None),
            },
        )
        .await
        .expect("显式空值应清除可空字段");

        assert_eq!(saved.name, "Original");
        assert_eq!(saved.parent_id, None);
        assert_eq!(saved.icon, None);
        assert_eq!(saved.sort_order, 0);
        assert_eq!(saved.created_at, Some(1));
        assert!(saved.updated_at.expect("补丁应更新时间") > 0);

        let missing = CollectionsRepository::update(
            &db,
            999,
            UpdateCollectionData {
                name: Some("Missing".to_string()),
                parent_id: None,
                sort_order: None,
                icon: None,
            },
        )
        .await
        .expect_err("不存在的合集应报告错误");
        assert!(matches!(missing, sea_orm::DbErr::RecordNotFound(_)));
    }

    #[tokio::test]
    async fn concurrent_partial_collection_updates_preserve_omitted_fields() {
        let db = single_connection_collection_database().await;

        for iteration in 1..=128 {
            let expected_name = format!("Renamed {iteration}");
            let name_update = UpdateCollectionData {
                name: Some(expected_name.clone()),
                parent_id: None,
                sort_order: None,
                icon: None,
            };
            let order_update = UpdateCollectionData {
                name: None,
                parent_id: None,
                sort_order: Some(iteration),
                icon: None,
            };

            let (renamed, reordered) = tokio::join!(
                CollectionsRepository::update(&db, 60, name_update),
                CollectionsRepository::update(&db, 60, order_update),
            );
            renamed.expect("名称补丁应成功");
            reordered.expect("排序补丁应成功");

            let saved = Collections::find_by_id(60)
                .one(&db)
                .await
                .expect("更新结果查询应成功")
                .expect("测试收藏夹应存在");
            assert_eq!(saved.name, expected_name);
            assert_eq!(saved.sort_order, iteration);
            assert_eq!(saved.parent_id, Some(10));
            assert_eq!(saved.icon.as_deref(), Some("icon.png"));
        }
    }

    #[tokio::test]
    async fn group_count_uses_unique_games_from_direct_categories() {
        let db = collection_count_database().await;
        db.execute_unprepared(
            "INSERT INTO collections (id, name, parent_id, sort_order) VALUES (45, 'Nested', 35, 0)",
        )
        .await
        .expect("应创建嵌套分类样本");
        db.execute_unprepared(
            "INSERT INTO game_collection_link (id, game_id, collection_id, sort_order) VALUES \
             (11, 7, 35, 0), (12, 7, 40, 0), (13, 8, 40, 1), (14, 9, 45, 0)",
        )
        .await
        .expect("应写入跨分类游戏关系");

        assert_eq!(
            CollectionsRepository::count_games_in_group(&db, 10)
                .await
                .expect("单分组计数应成功"),
            2
        );
        assert_eq!(
            CollectionsRepository::count_games_in_group(&db, 20)
                .await
                .expect("空分组计数应成功"),
            0
        );
        assert_eq!(
            CollectionsRepository::batch_count_games_in_groups(&db, vec![10, 20, 999])
                .await
                .expect("批量分组计数应成功"),
            [(10, 2), (20, 0), (999, 0)].into()
        );
    }

    #[tokio::test]
    async fn root_group_listing_counts_unique_games_in_direct_categories() {
        let db = collection_count_database().await;
        db.execute_unprepared(
            "INSERT INTO collections (id, name, parent_id, sort_order) VALUES (45, 'Nested', 35, 0)",
        )
        .await
        .expect("应创建嵌套分类样本");
        db.execute_unprepared(
            "INSERT INTO game_collection_link (id, game_id, collection_id, sort_order) VALUES \
             (11, 7, 35, 0), (12, 7, 40, 0), (13, 8, 40, 1), (14, 9, 45, 0), (15, 99, 10, 0)",
        )
        .await
        .expect("应写入根分组和分类成员");

        let groups = CollectionsRepository::get_root_collections_with_count(&db, None)
            .await
            .expect("根分组及游戏数查询应成功");
        assert_eq!(
            groups
                .iter()
                .map(|group| (group.id, group.game_count))
                .collect::<Vec<_>>(),
            [(10, 2), (20, 0), (30, 0)]
        );

        let sorted = CollectionsRepository::get_root_collections_with_count(
            &db,
            Some((CollectionBackendSortField::GameCount, SortOrder::Desc)),
        )
        .await
        .expect("根分组计数排序应成功");
        assert_eq!(
            sorted.iter().map(|group| group.id).collect::<Vec<_>>(),
            [10, 20, 30]
        );
    }

    #[tokio::test]
    async fn category_listing_counts_direct_links_and_keeps_empty_categories() {
        let db = collection_count_database().await;
        db.execute_unprepared(
            "INSERT INTO collections (id, name, parent_id, sort_order) VALUES \
             (45, 'Nested', 35, 0), (55, 'Empty category', 10, 1)",
        )
        .await
        .expect("应创建嵌套和空分类样本");
        db.execute_unprepared(
            "INSERT INTO game_collection_link (id, game_id, collection_id, sort_order) VALUES \
             (21, 7, 35, 0), (22, 8, 40, 0), (23, 9, 40, 1), (24, 10, 45, 0)",
        )
        .await
        .expect("应写入分类成员");

        let categories = CollectionsRepository::get_categories_with_count(&db, 10, None)
            .await
            .expect("默认分类列表应成功");
        assert_eq!(
            categories
                .iter()
                .map(|category| (category.id, category.game_count))
                .collect::<Vec<_>>(),
            [(35, 1), (40, 2), (55, 0)]
        );

        let sorted = CollectionsRepository::get_categories_with_count(
            &db,
            10,
            Some((CollectionBackendSortField::GameCount, SortOrder::Desc)),
        )
        .await
        .expect("按游戏数排序的分类列表应成功");
        assert_eq!(
            sorted
                .iter()
                .map(|category| category.id)
                .collect::<Vec<_>>(),
            [40, 35, 55]
        );
        assert!(
            CollectionsRepository::get_categories_with_count(&db, 999, None)
                .await
                .expect("未知分组应返回空分类列表")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn replacing_category_members_preserves_links_and_reorders_once() {
        let db = membership_database().await;
        db.execute_unprepared(
            "INSERT INTO game_collection_link (id, game_id, collection_id, sort_order) VALUES \
             (11, 9, 5, 0), (12, 7, 5, 2), (13, 5, 5, 1), (14, 1, 5, 3)",
        )
        .await
        .expect("应写入当前分类成员");

        CollectionsRepository::update_category_games(&db, vec![7, 5, 9, 10, 7], 5)
            .await
            .expect("分类成员应按首见顺序替换");

        let links = category_links(&db).await;
        assert_eq!(links.len(), 4);
        assert_eq!(links[0], (12, 7, 0));
        assert_eq!(links[1], (13, 5, 1));
        assert_eq!(links[2], (11, 9, 2));
        assert_eq!(links[3].1, 10);
        assert_eq!(links[3].2, 3);
        assert!(links[3].0 > 14);
    }

    #[tokio::test]
    async fn failed_category_insert_rolls_back_membership_deletes_and_reorders() {
        let db = membership_database().await;
        db.execute_unprepared(
            "INSERT INTO game_collection_link (id, game_id, collection_id, sort_order) VALUES \
             (11, 1, 5, 0), (12, 2, 5, 1)",
        )
        .await
        .expect("应写入当前分类成员");
        db.execute_unprepared(
            r#"CREATE TRIGGER reject_category_member
               BEFORE INSERT ON game_collection_link
               WHEN NEW.game_id = 3
               BEGIN
                   SELECT RAISE(ABORT, 'forced insert failure');
               END"#,
        )
        .await
        .expect("应创建写入失败触发器");

        let result = CollectionsRepository::update_category_games(&db, vec![2, 3], 5).await;

        assert!(result.is_err());
        assert_eq!(category_links(&db).await, [(11, 1, 0), (12, 2, 1)]);
    }

    #[tokio::test]
    async fn bulk_membership_add_keeps_cartesian_input_order_and_appends_per_collection() {
        let db = membership_database().await;
        db.execute_unprepared(
            "INSERT INTO game_collection_link (id, game_id, collection_id, sort_order) VALUES \
             (11, 2, 5, 4), (12, 9, 2, 1)",
        )
        .await
        .expect("应写入已有关系");

        CollectionsRepository::add_games_to_collections(&db, vec![7, 2, 7, 3], vec![5, 2, 5])
            .await
            .expect("多游戏多合集添加应成功");

        let collection_five = category_links(&db).await;
        assert_eq!(collection_five.len(), 3);
        assert_eq!(collection_five[0], (11, 2, 4));
        assert_eq!((collection_five[1].1, collection_five[1].2), (7, 5));
        assert_eq!((collection_five[2].1, collection_five[2].2), (3, 6));
        assert!(collection_five[1].0 > 12 && collection_five[2].0 > 12);
        let collection_two = GameCollectionLink::find()
            .filter(game_collection_link::Column::CollectionId.eq(2))
            .order_by_asc(game_collection_link::Column::SortOrder)
            .all(&db)
            .await
            .expect("第二个合集关系查询应成功");
        assert_eq!(
            collection_two
                .iter()
                .map(|link| (link.game_id, link.sort_order))
                .collect::<Vec<_>>(),
            [(9, 1), (7, 2), (2, 3), (3, 4)]
        );
    }

    #[tokio::test]
    async fn new_collection_members_start_at_zero_in_request_order() {
        let db = membership_database().await;

        CollectionsRepository::add_games_to_collections(&db, vec![7, 2, 7, 3], vec![9, 9])
            .await
            .expect("空合集应从零开始按请求顺序追加成员");

        let links = GameCollectionLink::find()
            .filter(game_collection_link::Column::CollectionId.eq(9))
            .order_by_asc(game_collection_link::Column::SortOrder)
            .all(&db)
            .await
            .expect("新合集成员查询应成功");
        assert_eq!(
            links
                .iter()
                .map(|link| (link.game_id, link.sort_order))
                .collect::<Vec<_>>(),
            [(7, 0), (2, 1), (3, 2)]
        );
    }

    #[tokio::test]
    async fn append_order_lookup_handles_large_target_collection_sets() {
        use super::GameCollectionPair;

        let db = membership_database().await;
        let txn = db.begin().await.expect("应开始收藏关系事务");
        let pairs = (0..1200)
            .map(|id| GameCollectionPair {
                game_id: id,
                collection_id: id,
            })
            .collect();

        let inserts = CollectionsRepository::build_append_inserts(&txn, pairs)
            .await
            .expect("大量目标合集的最大序号应能一次读取");

        assert_eq!(inserts.len(), 1200);
        assert!(inserts.iter().all(|insert| insert.sort_order == 0));
        txn.rollback().await.expect("应回滚只读边界测试事务");
    }

    #[tokio::test]
    async fn setting_game_memberships_preserves_existing_order_and_appends_new_links() {
        let db = membership_database().await;
        db.execute_unprepared(
            "INSERT INTO game_collection_link (id, game_id, collection_id, sort_order) VALUES \
             (11, 7, 2, 4), (12, 7, 5, 0), (13, 9, 8, 2)",
        )
        .await
        .expect("应写入当前关系和目标合集关系");

        CollectionsRepository::set_game_collections(&db, 7, vec![8, 2, 8])
            .await
            .expect("单游戏合集应替换成功");

        let links = game_links(&db, 7).await;
        assert_eq!(links.len(), 2);
        assert_eq!(links[0], (2, 4, 11));
        assert_eq!(links[1].0, 8);
        assert_eq!(links[1].1, 3);
        assert!(links[1].2 > 13);
    }

    #[tokio::test]
    async fn appending_respects_i32_sort_order_boundary_without_partial_writes() {
        let db = membership_database().await;
        db.execute_unprepared(
            "INSERT INTO game_collection_link (id, game_id, collection_id, sort_order) VALUES \
             (11, 1, 5, 2147483646)",
        )
        .await
        .expect("应写入边界排序值");

        CollectionsRepository::add_games_to_collections(&db, vec![2], vec![5])
            .await
            .expect("最后一个可表示序号应可使用");
        let after_last_supported_order = category_links(&db).await;
        assert_eq!(after_last_supported_order.len(), 2);
        assert_eq!(after_last_supported_order[0], (11, 1, i32::MAX - 1));
        assert_eq!(after_last_supported_order[1].1, 2);
        assert_eq!(after_last_supported_order[1].2, i32::MAX);

        let result = CollectionsRepository::add_games_to_collections(&db, vec![3], vec![5]).await;

        assert!(result.is_err());
        assert_eq!(category_links(&db).await, after_last_supported_order);
    }
}
