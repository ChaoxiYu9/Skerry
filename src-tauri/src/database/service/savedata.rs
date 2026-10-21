use sea_orm::DatabaseConnection;
use tauri::State;

use crate::database::repository::savedata_repository::SavedataRepository;
use crate::entity::savedata;

// ==================== 存档备份相关 ====================

/// 保存存档备份记录
#[tauri::command]
pub async fn save_savedata_record(
    db: State<'_, DatabaseConnection>,
    game_id: i32,
    file_name: String,
    backup_time: i32,
    file_size: i32,
) -> Result<i32, String> {
    SavedataRepository::save_savedata_record(&db, game_id, &file_name, backup_time, file_size)
        .await
        .map_err(|e| format!("保存存档备份记录失败: {}", e))
}

/// 获取指定游戏的备份数量
#[tauri::command]
pub async fn get_savedata_count(
    db: State<'_, DatabaseConnection>,
    game_id: i32,
) -> Result<u64, String> {
    SavedataRepository::get_savedata_count(&db, game_id)
        .await
        .map_err(|e| format!("获取备份数量失败: {}", e))
}

/// 获取指定游戏的所有备份记录
#[tauri::command]
pub async fn get_savedata_records(
    db: State<'_, DatabaseConnection>,
    game_id: i32,
) -> Result<Vec<savedata::Model>, String> {
    SavedataRepository::get_savedata_records(&db, game_id)
        .await
        .map_err(|e| format!("获取备份记录失败: {}", e))
}
