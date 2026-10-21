use sea_orm::DatabaseConnection;
use tauri::State;

use crate::database::dto::{InsertCollectionData, UpdateCollectionData};
use crate::database::repository::collection_listing_rules::{
    CollectionBackendSortField, validate_collection_sort,
};
use crate::database::repository::collections_repository::{
    CategoryWithCount, CollectionsRepository, GroupWithCount,
};
use crate::database::repository::games_repository::SortOrder;

// ==================== 合集相关 ====================

/// 创建合集
#[tauri::command]
pub async fn create_collection(
    db: State<'_, DatabaseConnection>,
    name: String,
    parent_id: Option<i32>,
    sort_order: i32,
    icon: Option<String>,
) -> Result<crate::entity::collections::Model, String> {
    let data = InsertCollectionData {
        name,
        parent_id,
        sort_order,
        icon,
    }
    .cleaned()
    .map_err(|error| format!("创建合集失败: {error}"))?;

    CollectionsRepository::create(&db, data)
        .await
        .map_err(|e| format!("创建合集失败: {}", e))
}

/// 获取根合集
#[tauri::command]
pub async fn find_root_collections(
    db: State<'_, DatabaseConnection>,
) -> Result<Vec<crate::entity::collections::Model>, String> {
    CollectionsRepository::find_root_collections(&db)
        .await
        .map_err(|e| format!("获取根合集失败: {}", e))
}

/// 获取根分组列表（带游戏数量）
#[tauri::command]
pub async fn get_root_collections_with_count(
    db: State<'_, DatabaseConnection>,
    sort_field: Option<CollectionBackendSortField>,
    sort_order: Option<SortOrder>,
) -> Result<Vec<GroupWithCount>, String> {
    let sort = validate_collection_sort(sort_field, sort_order)?;
    CollectionsRepository::get_root_collections_with_count(&db, sort)
        .await
        .map_err(|e| format!("获取根分组列表失败: {}", e))
}

/// 更新合集
#[tauri::command]
pub async fn update_collection(
    db: State<'_, DatabaseConnection>,
    id: i32,
    name: Option<String>,
    parent_id: Option<Option<i32>>,
    sort_order: Option<i32>,
    icon: Option<Option<String>>,
) -> Result<crate::entity::collections::Model, String> {
    let data = UpdateCollectionData {
        name,
        parent_id,
        sort_order,
        icon,
    }
    .cleaned()
    .map_err(|error| format!("更新合集失败: {error}"))?;

    CollectionsRepository::update(&db, id, data)
        .await
        .map_err(|e| format!("更新合集失败: {}", e))
}

/// 删除合集
#[tauri::command]
pub async fn delete_collection(db: State<'_, DatabaseConnection>, id: i32) -> Result<u64, String> {
    CollectionsRepository::delete(&db, id)
        .await
        .map(|result| result.rows_affected)
        .map_err(|e| format!("删除合集失败: {}", e))
}

/// 从单个合集中批量移除游戏
#[tauri::command]
pub async fn remove_games_from_collection(
    db: State<'_, DatabaseConnection>,
    game_ids: Vec<i32>,
    collection_id: i32,
) -> Result<u64, String> {
    CollectionsRepository::remove_games_from_collection(&db, game_ids, collection_id)
        .await
        .map(|result| result.rows_affected)
        .map_err(|e| format!("从合集中批量移除游戏失败: {}", e))
}

/// 获取合集中的所有游戏 ID
#[tauri::command]
pub async fn get_games_in_collection(
    db: State<'_, DatabaseConnection>,
    collection_id: i32,
) -> Result<Vec<i32>, String> {
    CollectionsRepository::get_games_in_collection(&db, collection_id)
        .await
        .map_err(|e| format!("获取合集中的游戏失败: {}", e))
}

/// 获取游戏所在的所有合集 ID
#[tauri::command]
pub async fn get_game_collection_ids(
    db: State<'_, DatabaseConnection>,
    game_id: i32,
) -> Result<Vec<i32>, String> {
    CollectionsRepository::get_game_collection_ids(&db, game_id)
        .await
        .map_err(|e| format!("获取游戏所在合集失败: {}", e))
}

/// 批量将多个游戏添加到多个合集
#[tauri::command]
pub async fn add_games_to_collections(
    db: State<'_, DatabaseConnection>,
    game_ids: Vec<i32>,
    collection_ids: Vec<i32>,
) -> Result<(), String> {
    CollectionsRepository::add_games_to_collections(&db, game_ids, collection_ids)
        .await
        .map_err(|e| format!("批量添加游戏到合集失败: {}", e))
}

/// 设置单个游戏所在的合集列表
#[tauri::command]
pub async fn set_game_collections(
    db: State<'_, DatabaseConnection>,
    game_id: i32,
    collection_ids: Vec<i32>,
) -> Result<(), String> {
    CollectionsRepository::set_game_collections(&db, game_id, collection_ids)
        .await
        .map_err(|e| format!("设置游戏合集失败: {}", e))
}

/// 批量更新分类中的游戏列表
#[tauri::command]
pub async fn update_category_games(
    db: State<'_, DatabaseConnection>,
    game_ids: Vec<i32>,
    collection_id: i32,
) -> Result<(), String> {
    CollectionsRepository::update_category_games(&db, game_ids, collection_id)
        .await
        .map_err(|e| format!("批量更新分类游戏失败: {}", e))
}

/// 获取分组中的游戏总数
#[tauri::command]
pub async fn count_games_in_group(
    db: State<'_, DatabaseConnection>,
    group_id: i32,
) -> Result<u64, String> {
    CollectionsRepository::count_games_in_group(&db, group_id)
        .await
        .map_err(|e| format!("获取分组游戏数量失败: {}", e))
}

/// 获取指定分组的分类列表（带游戏数量）
#[tauri::command]
pub async fn get_categories_with_count(
    db: State<'_, DatabaseConnection>,
    group_id: i32,
    sort_field: Option<CollectionBackendSortField>,
    sort_order: Option<SortOrder>,
) -> Result<Vec<CategoryWithCount>, String> {
    let sort = validate_collection_sort(sort_field, sort_order)?;
    CollectionsRepository::get_categories_with_count(&db, group_id, sort)
        .await
        .map_err(|e| format!("获取分类列表失败: {}", e))
}
