use crate::backup::archive::{create_7z_archive, extract_7z_archive};
use crate::backup::common::resolve_backup_dir;
use crate::backup::database::backup_database_file;
use crate::entity::prelude::Games;
use crate::entity::{game_sources, games};
use sea_orm::{
    ConnectOptions, ConnectionTrait, Database, DatabaseConnection, EntityTrait, QueryOrder,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MANIFEST_NAME: &str = "userdata-manifest.json";
const DATABASE_NAME: &str = "skerry.db";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportUserDataRequest {
    pub archive_path: String,
    pub store_json: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UserDataManifest {
    pub format_version: u32,
    pub app_version: String,
    pub exported_at: String,
    pub store_json: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportUserDataResult {
    pub success: bool,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportUserDataResult {
    pub success: bool,
    pub message: String,
    pub backup_path: Option<String>,
    pub store_json: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UserDataGamePreview {
    pub id: i32,
    pub id_type: String,
    pub name: String,
    pub developer: Option<String>,
    pub localpath: Option<String>,
    pub launch_type: String,
    pub source_count: usize,
    pub cover_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserDataPreviewResult {
    pub archive_path: String,
    pub archive_size: u64,
    pub manifest: UserDataManifest,
    pub games: Vec<UserDataGamePreview>,
    pub warnings: Vec<String>,
    pub message: String,
}

fn unique_temp_dir(label: &str) -> Result<PathBuf, String> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("读取系统时间失败: {error}"))?
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("skerry-{label}-{nanos}"));
    fs::create_dir_all(&dir).map_err(|error| format!("创建临时目录失败: {error}"))?;
    Ok(dir)
}

fn copy_file(source: &Path, target: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建目录失败 {}: {error}", parent.display()))?;
    }
    fs::copy(source, target).map_err(|error| {
        format!(
            "复制文件失败 {} -> {}: {error}",
            source.display(),
            target.display()
        )
    })?;
    Ok(())
}

fn copy_dir_merge(source: &Path, target: &Path) -> Result<u64, String> {
    if !source.exists() {
        return Ok(0);
    }
    let entries = fs::read_dir(source)
        .map_err(|error| format!("读取目录失败 {}: {error}", source.display()))?;
    let mut count = 0;
    for entry in entries {
        let entry = entry.map_err(|error| format!("读取目录项失败: {error}"))?;
        let path = entry.path();
        let target_path = target.join(entry.file_name());
        if path.is_dir() {
            count += copy_dir_merge(&path, &target_path)?;
        } else if path.is_file() {
            copy_file(&path, &target_path)?;
            count += 1;
        }
    }
    Ok(count)
}

fn remove_dir_if_exists(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_dir_all(path)
            .map_err(|error| format!("删除目录失败 {}: {error}", path.display()))?;
    }
    Ok(())
}

async fn connect_sqlite_copy(path: &Path) -> Result<DatabaseConnection, String> {
    let url = url::Url::from_file_path(path)
        .map_err(|_| format!("数据库路径无效: {}", path.display()))?;
    let mut options = ConnectOptions::new(format!("sqlite:{}?mode=rw", url.path()));
    options.max_connections(1);
    options.min_connections(1);
    options.connect_timeout(Duration::from_secs(8));
    options.sqlx_logging(false);
    Database::connect(options)
        .await
        .map_err(|error| format!("连接备份数据库失败: {error}"))
}

fn json_string_field(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(ToString::to_string)
    })
}

fn source_metadata_field(sources: &[&game_sources::Model], keys: &[&str]) -> Option<String> {
    const SOURCE_PRIORITY: [&str; 4] = ["bgm", "vndb", "ymgal", "kun"];
    let mut ordered_sources = sources.to_vec();
    ordered_sources.sort_by_key(|source| {
        SOURCE_PRIORITY
            .iter()
            .position(|item| item.eq_ignore_ascii_case(&source.source))
            .unwrap_or(usize::MAX)
    });
    ordered_sources.iter().find_map(|source| {
        source
            .data
            .as_ref()
            .and_then(|value| json_string_field(value, keys))
    })
}

fn game_preview_cover(stage: &Path, game: &games::Model) -> Option<String> {
    let image = game.custom_data.as_ref()?.image.as_deref()?.trim();
    if image.is_empty() {
        return None;
    }
    let cover_path = stage
        .join("covers")
        .join(format!("game_{}", game.id))
        .join(format!("cover_{}_{}", game.id, image));
    if cover_path.is_file() {
        Some(cover_path.to_string_lossy().to_string())
    } else {
        None
    }
}

async fn build_user_data_game_previews(
    stage: &Path,
    connection: &DatabaseConnection,
) -> Result<Vec<UserDataGamePreview>, String> {
    let games = Games::find()
        .order_by_asc(games::Column::Id)
        .all(connection)
        .await
        .map_err(|error| format!("读取用户数据包游戏失败: {error}"))?;
    let sources = game_sources::Entity::find()
        .order_by_asc(game_sources::Column::GameId)
        .all(connection)
        .await
        .map_err(|error| format!("读取用户数据包数据源失败: {error}"))?;
    let mut source_groups: HashMap<i32, Vec<&game_sources::Model>> = HashMap::new();
    for source in &sources {
        source_groups
            .entry(source.game_id)
            .or_default()
            .push(source);
    }

    Ok(games
        .into_iter()
        .map(|game| {
            let game_sources = source_groups
                .get(&game.id)
                .map(Vec::as_slice)
                .unwrap_or_default();
            let custom_data = game.custom_data.as_ref();
            let name = custom_data
                .and_then(|data| data.name_cn.as_deref())
                .filter(|value| !value.trim().is_empty())
                .map(ToString::to_string)
                .or_else(|| {
                    custom_data
                        .and_then(|data| data.name.as_deref())
                        .filter(|value| !value.trim().is_empty())
                        .map(ToString::to_string)
                })
                .or_else(|| source_metadata_field(game_sources, &["name_cn", "name", "title"]))
                .unwrap_or_else(|| format!("未知游戏 #{}", game.id));
            let developer = custom_data
                .and_then(|data| data.developer.as_deref())
                .filter(|value| !value.trim().is_empty())
                .map(ToString::to_string)
                .or_else(|| {
                    source_metadata_field(game_sources, &["developer", "developers", "company"])
                });
            let cover_path = game_preview_cover(stage, &game);
            UserDataGamePreview {
                id: game.id,
                id_type: game.id_type,
                name,
                developer,
                localpath: game.localpath,
                launch_type: game.launch_type,
                source_count: game_sources.len(),
                cover_path,
            }
        })
        .collect())
}

async fn backup_user_directory(
    path: &Path,
    backup_dir: &Path,
    label: &str,
) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let target = backup_dir.join(format!("skerry_{label}_pre_userdata_{timestamp}.7z"));
    create_7z_archive(path, &target).map_err(|error| format!("备份 {label} 失败: {error}"))?;
    Ok(Some(target.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn export_user_data(
    request: ExportUserDataRequest,
    db: tauri::State<'_, DatabaseConnection>,
) -> Result<ExportUserDataResult, String> {
    let archive_path = PathBuf::from(&request.archive_path);
    if archive_path.extension().and_then(|value| value.to_str()) != Some("7z") {
        return Err("用户数据包必须使用 .7z 扩展名".to_string());
    }
    if let Some(parent) = archive_path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建导出目录失败: {error}"))?;
    }
    if archive_path.exists() {
        return Err("目标文件已存在，请选择新的文件名".to_string());
    }

    let settings =
        crate::database::repository::settings_repository::SettingsRepository::get_all_settings(
            db.inner(),
        )
        .await
        .map_err(|error| format!("读取设置失败: {error}"))?;
    let custom_root = settings
        .detail_backdrop_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_dir());
    let base_dir = reina_path::get_base_data_dir()?;
    let stage = unique_temp_dir("userdata-export")?;
    let result = (|| async {
        let database_target = stage.join(DATABASE_NAME);
        let escaped = database_target
            .to_string_lossy()
            .replace('\'', "''")
            .replace('\\', "/");
        db.execute_unprepared(&format!("VACUUM INTO '{escaped}'"))
            .await
            .map_err(|error| format!("导出数据库失败: {error}"))?;

        if custom_root.is_some() {
            let conn = connect_sqlite_copy(&database_target).await?;
            conn.execute_unprepared("UPDATE user SET detail_backdrop_path = NULL")
                .await
                .map_err(|error| format!("统一底图资源路径失败: {error}"))?;
            conn.close()
                .await
                .map_err(|error| format!("关闭导出数据库连接失败: {error}"))?;
        }

        copy_dir_merge(&base_dir.join("covers"), &stage.join("covers"))?;
        if let Some(root) = custom_root.as_ref() {
            copy_dir_merge(&root.join("covers"), &stage.join("covers"))?;
        }
        let manifest = UserDataManifest {
            format_version: 1,
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            exported_at: chrono::Local::now().to_rfc3339(),
            store_json: request
                .store_json
                .clone()
                .filter(|value| !value.trim().is_empty()),
        };
        let manifest_json = serde_json::to_vec_pretty(&manifest)
            .map_err(|error| format!("序列化用户数据清单失败: {error}"))?;
        fs::write(stage.join(MANIFEST_NAME), manifest_json)
            .map_err(|error| format!("写入用户数据清单失败: {error}"))?;

        let size = create_7z_archive(&stage, &archive_path)
            .map_err(|error| format!("压缩用户数据失败: {error}"))?;
        Ok::<ExportUserDataResult, String>(ExportUserDataResult {
            success: true,
            path: archive_path.to_string_lossy().to_string(),
            message: format!(
                "用户数据导出成功，包大小 {:.2} MB",
                size as f64 / 1024.0 / 1024.0
            ),
        })
    })()
    .await;

    let _ = remove_dir_if_exists(&stage);
    result
}

#[tauri::command]
pub async fn inspect_user_data(archive_path: String) -> Result<UserDataPreviewResult, String> {
    let archive = PathBuf::from(&archive_path);
    if !archive.is_file() {
        return Err(format!("用户数据包不存在: {archive_path}"));
    }

    let archive_size = fs::metadata(&archive)
        .map_err(|error| format!("读取用户数据包信息失败: {error}"))?
        .len();
    let stage = unique_temp_dir("userdata-preview")?;
    let result = (|| async {
        extract_7z_archive(&archive, &stage)
            .map_err(|error| format!("读取用户数据包失败: {error}"))?;
        let extracted_db = stage.join(DATABASE_NAME);
        let manifest_path = stage.join(MANIFEST_NAME);
        if !extracted_db.is_file() || !manifest_path.is_file() {
            return Err("无效的用户数据包：缺少数据库或清单文件".to_string());
        }

        let manifest_bytes =
            fs::read(&manifest_path).map_err(|error| format!("读取用户数据清单失败: {error}"))?;
        let manifest: UserDataManifest = serde_json::from_slice(&manifest_bytes)
            .map_err(|error| format!("用户数据清单无效: {error}"))?;
        if manifest.format_version != 1 {
            return Err(format!(
                "不支持的用户数据包版本: {}",
                manifest.format_version
            ));
        }

        let connection = connect_sqlite_copy(&extracted_db).await?;
        let games = build_user_data_game_previews(&stage, &connection).await?;
        connection
            .close()
            .await
            .map_err(|error| format!("关闭用户数据包连接失败: {error}"))?;

        let warnings = vec![format!("导入会替换当前游戏库、统计和媒体资源。")];
        let result = UserDataPreviewResult {
            archive_path: archive.to_string_lossy().to_string(),
            archive_size,
            manifest,
            games,
            warnings,
            message: "用户数据包读取成功，请确认后再导入".to_string(),
        };
        Ok(result)
    })()
    .await;

    let _ = remove_dir_if_exists(&stage);
    result
}

#[tauri::command]
pub async fn import_user_data(
    archive_path: String,
    db: tauri::State<'_, DatabaseConnection>,
) -> Result<ImportUserDataResult, String> {
    let archive = PathBuf::from(&archive_path);
    if !archive.is_file() {
        return Err(format!("用户数据包不存在: {archive_path}"));
    }

    let stage = unique_temp_dir("userdata-import")?;
    let result = (|| async {
        extract_7z_archive(&archive, &stage)
            .map_err(|error| format!("解压用户数据包失败: {error}"))?;
        let extracted_db = stage.join(DATABASE_NAME);
        let manifest_path = stage.join(MANIFEST_NAME);
        if !extracted_db.is_file() || !manifest_path.is_file() {
            return Err("无效的用户数据包：缺少数据库或清单文件".to_string());
        }
        let manifest_bytes =
            fs::read(&manifest_path).map_err(|error| format!("读取用户数据清单失败: {error}"))?;
        let manifest: UserDataManifest = serde_json::from_slice(&manifest_bytes)
            .map_err(|error| format!("用户数据清单无效: {error}"))?;
        if manifest.format_version != 1 {
            return Err(format!(
                "不支持的用户数据包版本: {}",
                manifest.format_version
            ));
        }

        let backup_dir = resolve_backup_dir(db.inner()).await?;
        let database_backup = backup_database_file(db.inner()).await?;
        let _covers_backup = backup_user_directory(
            &reina_path::get_base_data_dir()?.join("covers"),
            &backup_dir,
            "covers",
        )
        .await?;
        let target_db = reina_path::get_db_path()?;
        crate::database::db::close_connection(db.inner().clone())
            .await
            .map_err(|error| format!("关闭数据库连接失败: {error}"))?;

        let import_result = (|| -> Result<(), String> {
            remove_dir_if_exists(&reina_path::get_base_data_dir()?.join("covers"))?;
            remove_dir_if_exists(&reina_path::get_base_data_dir()?.join("next-up-covers"))?;
            copy_dir_merge(
                &stage.join("covers"),
                &reina_path::get_base_data_dir()?.join("covers"),
            )?;
            copy_dir_merge(
                &stage.join("next-up-covers"),
                &reina_path::get_base_data_dir()?.join("covers"),
            )?;
            fs::copy(&extracted_db, &target_db)
                .map_err(|error| format!("替换数据库失败: {error}"))?;
            Ok(())
        })();

        match import_result {
            Ok(()) => Ok(ImportUserDataResult {
                success: true,
                message: "用户数据导入成功，应用将自动重启".to_string(),
                backup_path: database_backup.path,
                store_json: manifest.store_json,
            }),
            Err(error) => Err(format!("导入用户数据失败: {error}")),
        }
    })()
    .await;

    let _ = remove_dir_if_exists(&stage);
    result
}
