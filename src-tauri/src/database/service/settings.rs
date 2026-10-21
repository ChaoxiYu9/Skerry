use sea_orm::DatabaseConnection;
use tauri::State;

use crate::database::dto::UpdateSettingsData;
use crate::database::repository::settings_repository::SettingsRepository;
use crate::entity::user;

// ==================== 用户设置相关 ====================

/// 获取所有设置
#[tauri::command]
pub async fn get_all_settings(db: State<'_, DatabaseConnection>) -> Result<user::Model, String> {
    SettingsRepository::get_all_settings(&db)
        .await
        .map_err(|e| format!("获取所有设置失败: {}", e))
}

/// 批量更新设置
#[tauri::command]
pub async fn update_settings(
    db: State<'_, DatabaseConnection>,
    data: UpdateSettingsData,
) -> Result<(), String> {
    let data = data.cleaned(); // 清洗空字符串

    SettingsRepository::update_settings(&db, data)
        .await
        .map_err(|e| format!("更新设置失败: {}", e))
}
