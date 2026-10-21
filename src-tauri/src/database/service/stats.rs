use sea_orm::DatabaseConnection;
use tauri::State;

use crate::database::repository::game_stats_repository::{GameLastPlayed, GameStatsRepository};

// ==================== 游戏统计相关 ====================

/// 手动创建游戏会话
#[tauri::command]
pub async fn create_manual_game_session(
    db: State<'_, DatabaseConnection>,
    game_id: i32,
    start_time: i32,
    duration: i32,
) -> Result<i32, String> {
    GameStatsRepository::create_manual_session(&db, game_id, start_time, duration)
        .await
        .map(|session| session.session_id)
        .map_err(|e| format!("创建游戏会话失败: {}", e))
}

/// 修复/调试命令：从全部事实会话重建指定游戏的统计投影
///
/// 常规会话增删已在事务内同步维护统计，不应调用此命令。
#[tauri::command]
pub async fn rebuild_game_statistics(
    db: State<'_, DatabaseConnection>,
    game_id: i32,
) -> Result<(), String> {
    GameStatsRepository::rebuild_statistics(&db, game_id)
        .await
        .map_err(|e| format!("重建游戏统计失败: {}", e))
}

/// 获取游戏会话历史
#[tauri::command]
pub async fn get_game_sessions(
    db: State<'_, DatabaseConnection>,
    game_id: i32,
    limit: u64,
    offset: u64,
) -> Result<Vec<crate::entity::game_sessions::Model>, String> {
    GameStatsRepository::get_sessions(&db, game_id, limit, offset)
        .await
        .map_err(|e| format!("获取游戏会话历史失败: {}", e))
}

/// 获取指定游戏范围内的全局最近会话
#[tauri::command]
pub async fn get_recent_sessions_for_all(
    db: State<'_, DatabaseConnection>,
    game_ids: Vec<i32>,
    limit: u64,
    offset: u64,
) -> Result<Vec<crate::entity::game_sessions::Model>, String> {
    GameStatsRepository::get_recent_sessions_for_all(&db, game_ids, limit, offset)
        .await
        .map_err(|e| format!("获取最近会话失败: {}", e))
}

/// 删除游戏会话
#[tauri::command]
pub async fn delete_game_session(
    db: State<'_, DatabaseConnection>,
    session_id: i32,
) -> Result<i32, String> {
    GameStatsRepository::delete_session_with_statistics(&db, session_id)
        .await
        .map_err(|e| format!("删除游戏会话失败: {}", e))
}

/// 获取游戏统计信息
#[tauri::command]
pub async fn get_game_statistics(
    db: State<'_, DatabaseConnection>,
    game_id: i32,
) -> Result<Option<crate::entity::game_statistics::Model>, String> {
    GameStatsRepository::get_statistics(&db, game_id)
        .await
        .map_err(|e| format!("获取游戏统计失败: {}", e))
}

/// 获取所有游戏统计信息
#[tauri::command]
pub async fn get_all_game_statistics(
    db: State<'_, DatabaseConnection>,
) -> Result<Vec<crate::entity::game_statistics::Model>, String> {
    GameStatsRepository::get_all_statistics(&db)
        .await
        .map_err(|e| format!("获取所有游戏统计失败: {}", e))
}

/// 获取所有游戏的最近游玩时间
#[tauri::command]
pub async fn get_all_game_last_played(
    db: State<'_, DatabaseConnection>,
) -> Result<Vec<GameLastPlayed>, String> {
    GameStatsRepository::get_all_last_played(&db)
        .await
        .map_err(|e| format!("获取所有游戏最近游玩时间失败: {}", e))
}
