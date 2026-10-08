use crate::database::dto::UpdateSettingsData;
use crate::database::repository::settings_repository::{DbSettingsExt, SettingsRepository};
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BackupOptions {
    pub auto: bool,
    pub max_auto_backups: Option<usize>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BackupResult {
    pub success: bool,
    pub path: Option<String>,
    pub message: String,
}

pub async fn resolve_backup_dir(db: &DatabaseConnection) -> Result<PathBuf, String> {
    let settings = db.get_settings().await?;

    if let Some(custom) = settings.db_backup_path_value() {
        let custom_path = PathBuf::from(custom);
        if custom_path.is_dir() {
            return Ok(custom_path);
        }

        log::warn!(
            "自定义数据库备份目录无效，清空设置并回退默认目录: {}",
            custom
        );
        SettingsRepository::update_settings(
            db,
            UpdateSettingsData {
                db_backup_path: Some(None),
                ..Default::default()
            },
        )
        .await
        .map_err(|e| format!("清空无效数据库备份路径失败: {}", e))?;
    }

    let backup_dir = reina_path::get_default_db_backup_path()?;
    fs::create_dir_all(&backup_dir).map_err(|e| format!("无法创建备份目录: {}", e))?;

    Ok(backup_dir)
}

pub fn cleanup_auto_backup_files(
    backup_dir: &Path,
    prefix: &str,
    extension: &str,
    max_count: usize,
) -> Result<Vec<String>, String> {
    let max_count = max_count.max(1);
    let entries = fs::read_dir(backup_dir).map_err(|e| format!("读取备份目录失败: {}", e))?;
    let mut files = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| format!("读取备份文件失败: {}", e))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };

        if file_name.starts_with(prefix) && file_name.ends_with(extension) {
            files.push((file_name.to_string(), path));
        }
    }

    files.sort_by(|a, b| a.0.cmp(&b.0));
    if files.len() <= max_count {
        return Ok(Vec::new());
    }

    let remove_count = files.len() - max_count;
    let mut deleted_files = Vec::new();
    for (file_name, path) in files.into_iter().take(remove_count) {
        fs::remove_file(&path)
            .map_err(|e| format!("删除旧自动备份失败 {}: {}", path.to_string_lossy(), e))?;
        deleted_files.push(file_name);
    }

    Ok(deleted_files)
}
