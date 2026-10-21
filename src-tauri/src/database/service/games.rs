use sea_orm::DatabaseConnection;
use tauri::State;

use crate::database::dto::{BatchOperationResult, FullGameData, InsertGameData, UpdateGameData};
use crate::database::repository::game_query_repository::GameQueryRepository;
use crate::database::repository::game_sources_repository::GameSourcesRepository;
use crate::database::repository::games_repository::{
    GameType, GamesRepository, SortOption, SortOrder,
};
use crate::game::cover::{DownloadState, delete_game_cover_dir};

// ==================== 游戏数据相关 ====================

/// 插入游戏数据（聚合架构）
#[tauri::command]
pub async fn insert_game(
    db: State<'_, DatabaseConnection>,
    game: InsertGameData,
) -> Result<FullGameData, String> {
    GamesRepository::insert(&db, game)
        .await
        .map_err(|e| format!("插入游戏数据失败: {}", e))
}

#[tauri::command]
pub async fn insert_games_batch(
    db: State<'_, DatabaseConnection>,
    games: Vec<InsertGameData>,
) -> Result<BatchOperationResult, String> {
    Ok(GamesRepository::insert_batch(&db, games).await)
}

/// 根据 ID 查询游戏数据
#[tauri::command]
pub async fn find_game_by_id(
    db: State<'_, DatabaseConnection>,
    id: i32,
) -> Result<Option<FullGameData>, String> {
    GameQueryRepository::find_by_id(&db, id)
        .await
        .map_err(|e| format!("查询游戏数据失败: {}", e))
}

/// 获取所有游戏数据，支持按类型筛选和排序
#[tauri::command]
pub async fn find_all_games(
    db: State<'_, DatabaseConnection>,
    game_type: GameType,
    sort_option: SortOption,
    sort_order: SortOrder,
    language: Option<String>,
) -> Result<Vec<FullGameData>, String> {
    GameQueryRepository::find_all(&db, game_type, sort_option, sort_order, language)
        .await
        .map_err(|e| format!("获取游戏数据失败: {}", e))
}

/// 只返回排序/筛选后的游戏 ID 列表
///
/// 前端已缓存完整游戏数据，切换排序/筛选时只需传输 ID 数组，
/// 避免数 MB 级 JSON 反复穿过 IPC 桥梁。
#[tauri::command]
pub async fn find_game_ids(
    db: State<'_, DatabaseConnection>,
    game_type: GameType,
    sort_option: SortOption,
    sort_order: SortOrder,
    language: Option<String>,
) -> Result<Vec<i32>, String> {
    GameQueryRepository::find_ids(&db, game_type, sort_option, sort_order, language)
        .await
        .map_err(|e| format!("获取游戏 ID 列表失败: {}", e))
}

/// 更新游戏数据（聚合架构）
#[tauri::command]
pub async fn update_game(
    db: State<'_, DatabaseConnection>,
    game_id: i32,
    updates: UpdateGameData,
) -> Result<FullGameData, String> {
    GamesRepository::update(&db, game_id, updates)
        .await
        .map_err(|e| format!("更新游戏数据失败: {}", e))
}

/// 删除游戏
#[tauri::command]
pub async fn delete_game(
    db: State<'_, DatabaseConnection>,
    cover_state: State<'_, DownloadState>,
    id: i32,
) -> Result<u64, String> {
    let rows_affected = GamesRepository::delete(&db, id)
        .await
        .map(|result| result.rows_affected)
        .map_err(|e| format!("删除游戏失败: {}", e))?;

    if rows_affected > 0 {
        cover_state.mark_game_deleted(i64::from(id)).await;
        log::info!(
            "游戏删除成功 game_id={} rows_affected={}",
            id,
            rows_affected
        );
    }

    if rows_affected > 0
        && let Err(err) = delete_game_cover_dir(id).await
    {
        log::warn!("删除游戏封面目录失败 game_id={}: {}", id, err);
    }

    Ok(rows_affected)
}

/// 批量删除游戏
#[tauri::command]
pub async fn delete_games_batch(
    db: State<'_, DatabaseConnection>,
    cover_state: State<'_, DownloadState>,
    ids: Vec<i32>,
) -> Result<u64, String> {
    let rows_affected = GamesRepository::delete_many(&db, ids.clone())
        .await
        .map(|result| result.rows_affected)
        .map_err(|e| format!("批量删除游戏失败: {}", e))?;
    let requested_count = ids.len();

    for game_id in &ids {
        if *game_id > 0 {
            cover_state.mark_game_deleted(i64::from(*game_id)).await;
        }
    }

    for game_id in ids {
        if let Err(err) = delete_game_cover_dir(game_id).await {
            log::warn!(
                "批量删除时清理游戏封面目录失败 game_id={}: {}",
                game_id,
                err
            );
        }
    }

    log::info!(
        "批量删除游戏完成 requested_count={} rows_affected={}",
        requested_count,
        rows_affected
    );

    Ok(rows_affected)
}

/// 获取游戏总数
#[tauri::command]
pub async fn count_games(db: State<'_, DatabaseConnection>) -> Result<u64, String> {
    GameQueryRepository::count(&db)
        .await
        .map_err(|e| format!("获取游戏总数失败: {}", e))
}

/// 获取指定 source 的全部游戏绑定
#[tauri::command]
pub async fn get_source_bindings(
    db: State<'_, DatabaseConnection>,
    source: String,
) -> Result<Vec<(i32, String)>, String> {
    GameSourcesRepository::get_source_bindings(&db, &source)
        .await
        .map_err(|e| format!("获取 source ID 列表失败: {}", e))
}

/// 批量更新游戏数据
///
/// 使用单个事务处理所有更新操作，性能远优于逐个更新
#[tauri::command]
pub async fn update_games_batch(
    db: State<'_, DatabaseConnection>,
    updates: Vec<(i32, UpdateGameData)>,
) -> Result<Vec<FullGameData>, String> {
    GamesRepository::update_batch(&db, updates)
        .await
        .map_err(|e| format!("批量更新数据失败: {}", e))
}
