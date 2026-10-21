use crate::backup::archive::{
    create_7z_archive, extract_validated_archive, open_validated_archive,
};
#[cfg(not(windows))]
use crate::backup::common::reserve_backup_file_path;
use crate::backup::common::{
    ExistingPathPolicy, PathReplacement, publish_path_replacements, resolve_backup_dir,
    stage_directory, stage_file_copy, validate_import_database, write_sqlite_snapshot,
};
#[cfg(windows)]
use crate::backup::common::{
    StagedFilePublishError, publish_staged_backup_file_windows, publish_staged_file_windows,
    reserve_staged_backup_file_windows,
};
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
#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

fn extract_user_data_archive(archive: &Path, stage: &Path) -> Result<(), String> {
    let mut reader = open_validated_archive(archive).map_err(|error| error.to_string())?;
    extract_validated_archive(&mut reader, stage).map_err(|error| error.to_string())
}

fn validate_staged_user_data_package(stage: &Path) -> Result<UserDataManifest, String> {
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

    Ok(manifest)
}

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
    pub restart_required: bool,
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
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_STAGE_ID: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("读取系统时间失败: {error}"))?
        .as_nanos();
    for _ in 0..100 {
        let sequence = NEXT_STAGE_ID.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "skerry-{label}-{}-{nanos}-{sequence}",
            std::process::id()
        ));
        match fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("创建临时目录失败 {}: {error}", dir.display())),
        }
    }
    Err("无法分配唯一的用户数据暂存目录".to_string())
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
    let root_metadata = match fs::symlink_metadata(source) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => {
            return Err(format!("检查目录失败 {}: {error}", source.display()));
        }
    };
    if is_media_path_redirector(&root_metadata) {
        return Err(format!(
            "媒体目录包含符号链接或 Windows 重解析点，拒绝跟随: {}",
            source.display()
        ));
    }
    if !root_metadata.is_dir() {
        return Err(format!("待复制路径不是普通目录: {}", source.display()));
    }

    let mut directories = vec![(source.to_path_buf(), target.to_path_buf())];
    let mut copied_files = 0_u64;
    while let Some((source_dir, target_dir)) = directories.pop() {
        let mut entries = fs::read_dir(&source_dir)
            .map_err(|error| format!("读取目录失败 {}: {error}", source_dir.display()))?
            .map(|entry| {
                entry
                    .map(|entry| (entry.file_name(), entry.path()))
                    .map_err(|error| format!("读取目录项失败 {}: {error}", source_dir.display()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        entries.sort_unstable_by(|left, right| left.0.cmp(&right.0));

        for (name, source_path) in entries {
            let metadata = fs::symlink_metadata(&source_path)
                .map_err(|error| format!("检查文件失败 {}: {error}", source_path.display()))?;
            if is_media_path_redirector(&metadata) {
                return Err(format!(
                    "媒体目录包含符号链接或 Windows 重解析点，拒绝跟随: {}",
                    source_path.display()
                ));
            }

            let target_path = target_dir.join(name);
            if metadata.is_dir() {
                directories.push((source_path, target_path));
            } else if metadata.is_file() {
                copy_file(&source_path, &target_path)?;
                copied_files = copied_files
                    .checked_add(1)
                    .ok_or_else(|| "媒体文件数量超出支持范围".to_string())?;
            } else {
                return Err(format!(
                    "媒体目录包含不支持的文件类型: {}",
                    source_path.display()
                ));
            }
        }
    }
    Ok(copied_files)
}

fn is_media_path_redirector(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn stage_user_data_media(
    base_dir: &Path,
    custom_root: Option<&Path>,
    stage: &Path,
) -> Result<(), String> {
    copy_dir_merge(&base_dir.join("covers"), &stage.join("covers"))?;
    copy_dir_merge(
        &base_dir.join("next-up-covers"),
        &stage.join("next-up-covers"),
    )?;
    if let Some(root) = custom_root {
        copy_dir_merge(&root.join("covers"), &stage.join("covers"))?;
    }
    Ok(())
}

fn remove_dir_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => {
            let message = format!("删除暂存目录失败 {}: {error}", path.display());
            log::warn!("{message}");
            Err(message)
        }
    }
}

fn remove_import_staging_path(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            let message = format!("检查导入暂存内容失败 {}: {error}", path.display());
            log::warn!("{message}");
            return Err(message);
        }
    };
    let result = if metadata.file_type().is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    };
    match result {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => {
            let message = format!("清理导入暂存内容失败 {}: {error}", path.display());
            log::warn!("{message}");
            Err(message)
        }
    }
}

fn include_staging_cleanup<T>(
    result: Result<T, String>,
    cleanup: Result<(), String>,
    on_success: impl FnOnce(T, &str) -> T,
) -> Result<T, String> {
    match cleanup {
        Ok(()) => result,
        Err(cleanup_error) => match result {
            Ok(value) => Ok(on_success(value, &cleanup_error)),
            Err(operation_error) => Err(format!("{operation_error}；{cleanup_error}")),
        },
    }
}

fn create_user_data_archive(
    source: &Path,
    archive_path: &Path,
) -> Result<(u64, Option<String>), String> {
    if archive_path.exists() {
        return Err("目标文件已存在，请选择新的文件名".to_string());
    }

    let file_name = archive_path
        .file_name()
        .ok_or_else(|| "导出路径缺少文件名".to_string())?;
    let (staging_dir, final_archive_path) = create_user_data_export_stage(archive_path)?;
    let staged_archive = staging_dir.join(file_name);
    let result = create_7z_archive(source, &staged_archive)
        .map_err(|error| format!("压缩用户数据失败: {error}"))
        .and_then(|size| {
            publish_user_data_archive(&staged_archive, &final_archive_path)
                .map(|()| size)
                .map_err(|error| format!("发布用户数据包失败: {error}"))
        });

    let cleanup = match fs::remove_dir_all(&staging_dir) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => {
            let message = format!(
                "清理用户数据包暂存目录失败 {}: {error}",
                staging_dir.display()
            );
            log::warn!("{message}");
            Err(message)
        }
    };

    match (result, cleanup) {
        (Ok(size), Ok(())) => Ok((size, None)),
        (Ok(size), Err(cleanup_error)) => Ok((size, Some(cleanup_error))),
        (Err(operation_error), Ok(())) => Err(operation_error),
        (Err(operation_error), Err(cleanup_error)) => {
            Err(format!("{operation_error}；{cleanup_error}"))
        }
    }
}

fn create_user_data_export_stage(archive_path: &Path) -> Result<(PathBuf, PathBuf), String> {
    let parent = archive_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let parent = fs::canonicalize(parent)
        .map_err(|error| format!("解析导出目录失败 {}: {error}", parent.display()))?;
    let file_name = archive_path
        .file_name()
        .ok_or_else(|| "导出路径缺少文件名".to_string())?;
    let final_archive_path = parent.join(file_name);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("读取系统时间失败: {error}"))?
        .as_nanos();
    let mut attempt = 0_u64;

    loop {
        let stage = parent.join(format!(".skerry-user-data-export-{timestamp}-{attempt}"));
        match fs::create_dir(&stage) {
            Ok(()) => return Ok((stage, final_archive_path)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                attempt = attempt
                    .checked_add(1)
                    .ok_or_else(|| "无法分配用户数据包暂存目录".to_string())?;
            }
            Err(error) => {
                return Err(format!(
                    "创建用户数据包暂存目录失败 {}: {error}",
                    stage.display()
                ));
            }
        }
    }
}

fn publish_user_data_archive(staged_archive: &Path, archive_path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        return match publish_staged_file_windows(staged_archive, archive_path) {
            Ok(()) => Ok(()),
            Err(StagedFilePublishError::DestinationExists) => {
                Err("目标文件已存在，请选择新的文件名".to_string())
            }
            Err(StagedFilePublishError::Failed(error)) => Err(error),
        };
    }

    #[cfg(not(windows))]
    {
        fs::hard_link(staged_archive, archive_path).map_err(|error| error.to_string())?;
        if let Err(error) = fs::remove_file(staged_archive) {
            log::warn!(
                "清理已发布用户数据包暂存文件失败 {}: {error}",
                staged_archive.display()
            );
        }
        Ok(())
    }
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
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => return Err(format!("待备份路径不是目录: {}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!("检查待备份目录失败 {}: {error}", path.display()));
        }
    }
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
    let target = write_pre_import_directory_backup(path, backup_dir, label, &timestamp)?;
    Ok(Some(target.to_string_lossy().to_string()))
}

fn write_pre_import_directory_backup(
    source: &Path,
    backup_dir: &Path,
    label: &str,
    timestamp: &str,
) -> Result<PathBuf, String> {
    let filename_stem = format!("skerry_{label}_pre_userdata_{timestamp}");
    #[cfg(windows)]
    {
        let staged_target = backup_dir.join(format!("{filename_stem}.7z"));
        let staged = reserve_staged_backup_file_windows(&staged_target, "pre-import-backup")?;
        let result = create_7z_archive(source, &staged)
            .map_err(|error| format!("备份 {label} 失败: {error}"))
            .and_then(|size| {
                open_validated_archive(&staged)
                    .map(|_| size)
                    .map_err(|error| format!("验证 {label} 备份失败: {error}"))
            });
        if let Err(error) = result {
            return Err(remove_failed_pre_import_backup(&staged, error, label));
        }
        return match publish_staged_backup_file_windows(&staged, backup_dir, &filename_stem, "7z") {
            Ok((_, target)) => Ok(target),
            Err(error) => Err(remove_failed_pre_import_backup(
                &staged,
                format!("发布 {label} 备份失败: {error}"),
                label,
            )),
        };
    }

    #[cfg(not(windows))]
    {
        let (_, target) = reserve_backup_file_path(backup_dir, &filename_stem, "7z")?;
        if let Err(error) = create_7z_archive(source, &target) {
            let failure = format!("备份 {label} 失败: {error}");
            return match fs::remove_file(&target) {
                Ok(()) => Err(failure),
                Err(cleanup_error) if cleanup_error.kind() == std::io::ErrorKind::NotFound => {
                    Err(failure)
                }
                Err(cleanup_error) => Err(format!(
                    "{failure}；清理未完成的 {label} 备份失败 {}: {cleanup_error}",
                    target.display()
                )),
            };
        }
        Ok(target)
    }
}

#[cfg(windows)]
fn remove_failed_pre_import_backup(path: &Path, failure: String, label: &str) -> String {
    match fs::remove_file(path) {
        Ok(()) => failure,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => failure,
        Err(error) => format!(
            "{failure}；清理未完成的 {label} 备份失败 {}: {error}",
            path.display()
        ),
    }
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
    let custom_root = match settings.detail_backdrop_path.as_deref().map(str::trim) {
        Some(path) if !path.is_empty() => {
            let custom_root = PathBuf::from(path);
            match fs::metadata(&custom_root) {
                Ok(metadata) if metadata.is_dir() => Some(custom_root),
                Ok(_) => None,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => {
                    return Err(format!(
                        "检查自定义媒体目录失败 {}: {error}",
                        custom_root.display()
                    ));
                }
            }
        }
        _ => None,
    };
    let base_dir = skerry_path::get_base_data_dir()?;
    let stage = unique_temp_dir("userdata-export")?;
    let result = async {
        let database_target = stage.join(DATABASE_NAME);
        write_sqlite_snapshot(db.inner(), &database_target)
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

        stage_user_data_media(&base_dir, custom_root.as_deref(), &stage)?;
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

        let (size, archive_cleanup_warning) = create_user_data_archive(&stage, &archive_path)?;
        let message = match archive_cleanup_warning {
            Some(warning) => format!(
                "用户数据导出成功，包大小 {:.2} MB；{warning}",
                size as f64 / 1024.0 / 1024.0
            ),
            None => format!(
                "用户数据导出成功，包大小 {:.2} MB",
                size as f64 / 1024.0 / 1024.0
            ),
        };
        Ok::<ExportUserDataResult, String>(ExportUserDataResult {
            success: true,
            path: archive_path.to_string_lossy().to_string(),
            message,
        })
    }
    .await;

    let cleanup = remove_dir_if_exists(&stage);
    include_staging_cleanup(result, cleanup, |mut result, warning| {
        result.message.push_str("；");
        result.message.push_str(warning);
        result
    })
}

#[cfg(test)]
mod export_archive_tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn test_root(label: &str) -> PathBuf {
        static NEXT_ID: AtomicU64 = AtomicU64::new(0);
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "skerry_user_data_export_{label}_{}_{id}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("create test directory");
        root
    }

    #[tokio::test]
    async fn pre_import_directory_backup_only_skips_a_missing_directory() {
        let root = test_root("pre-import-directory-state");
        let backup_dir = root.join("backups");
        fs::create_dir_all(&backup_dir).expect("create backup directory");
        let missing = root.join("missing-covers");
        assert_eq!(
            backup_user_directory(&missing, &backup_dir, "covers")
                .await
                .expect("missing optional directory is skipped"),
            None
        );

        let file = root.join("covers-file");
        fs::write(&file, b"preserve").expect("create non-directory path");
        let error = backup_user_directory(&file, &backup_dir, "covers")
            .await
            .expect_err("a file cannot stand in for the covers directory");

        assert!(error.contains("待备份路径不是目录"));
        assert!(error.contains(&file.display().to_string()));
        assert_eq!(
            fs::read(&file).expect("preserve original file"),
            b"preserve"
        );
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[cfg(windows)]
    fn create_test_junction(link: &Path, target: &Path) {
        use std::process::Command;

        let output = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "New-Item -ItemType Junction -Path $env:SKERRY_TEST_JUNCTION -Target $env:SKERRY_TEST_OUTSIDE | Out-Null",
            ])
            .env("SKERRY_TEST_JUNCTION", link)
            .env("SKERRY_TEST_OUTSIDE", target)
            .output()
            .expect("run Windows junction creation command");
        assert!(
            output.status.success(),
            "junction creation failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
    }

    fn export_staging_entries(root: &Path) -> Vec<PathBuf> {
        fs::read_dir(root)
            .expect("read export directory")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name().is_some_and(|name| {
                    name.to_string_lossy()
                        .starts_with(".skerry-user-data-export-")
                })
            })
            .collect()
    }

    #[test]
    fn staging_cleanup_reports_a_non_directory_path() {
        let root = test_root("cleanup-error");
        let file = root.join("not-a-directory");
        fs::write(&file, b"keep for assertion").expect("create regular file");

        let message = include_staging_cleanup(
            Ok("用户数据预览成功".to_string()),
            remove_dir_if_exists(&file),
            |mut message, warning| {
                message.push_str("；");
                message.push_str(warning);
                message
            },
        )
        .expect("operation success remains success when cleanup fails");

        assert!(message.contains("用户数据预览成功"));
        assert!(message.contains("删除暂存目录失败"));
        assert!(message.contains(&file.display().to_string()));
        assert_eq!(
            fs::read(&file).expect("failed cleanup must preserve the file"),
            b"keep for assertion"
        );
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn export_claims_destination_and_preserves_existing_file() {
        let root = test_root("destination-conflict");
        let source = root.join("source");
        fs::create_dir_all(&source).expect("create source directory");
        fs::write(source.join("manifest.json"), b"manifest").expect("write source content");
        let target = root.join("Skerry 用户数据.7z");
        fs::write(&target, b"existing export").expect("write existing target");

        let error = create_user_data_archive(&source, &target)
            .expect_err("existing destination must be rejected");

        assert_eq!(error, "目标文件已存在，请选择新的文件名");
        assert_eq!(
            fs::read(&target).expect("read existing target"),
            b"existing export"
        );
        assert!(export_staging_entries(&root).is_empty());
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn export_publication_does_not_replace_a_destination_created_during_compression() {
        let root = test_root("publication-conflict");
        let staged = root.join("staged.7z");
        let target = root.join("Skerry 用户数据.7z");
        fs::write(&staged, b"completed archive").expect("write staged archive");
        fs::write(&target, b"concurrent destination").expect("write concurrent destination");

        let error = publish_user_data_archive(&staged, &target)
            .expect_err("publication must not replace a concurrent destination");

        assert!(!error.is_empty());
        assert_eq!(
            fs::read(&target).expect("read destination"),
            b"concurrent destination"
        );
        assert_eq!(
            fs::read(&staged).expect("read staged archive"),
            b"completed archive"
        );
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn export_creates_a_readable_archive_at_the_selected_path() {
        let root = test_root("successful-export");
        let source = root.join("source");
        fs::create_dir_all(&source).expect("create source directory");
        fs::write(source.join("manifest.json"), b"manifest").expect("write source content");
        let target = root.join("Skerry 用户数据.7z");

        let (size, cleanup_warning) =
            create_user_data_archive(&source, &target).expect("create export archive");
        let extracted = root.join("extracted");
        fs::create_dir(&extracted).expect("create extraction directory");
        extract_user_data_archive(&target, &extracted).expect("read exported archive");

        assert_eq!(size, fs::metadata(&target).expect("stat archive").len());
        assert_eq!(cleanup_warning, None);
        assert_eq!(
            fs::read(extracted.join("manifest.json")).expect("read archived content"),
            b"manifest"
        );
        assert!(export_staging_entries(&root).is_empty());
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn v1_export_keeps_legacy_next_up_covers_as_a_separate_package_root() {
        let root = test_root("export-next-up-covers");
        let base = root.join("base");
        let custom = root.join("custom");
        let package_stage = root.join("package-stage");
        let archive = root.join("profile.7z");
        let extracted = root.join("extracted");
        fs::create_dir_all(base.join("covers/game_1")).expect("create base cover directory");
        fs::create_dir_all(base.join("covers/game_3")).expect("create shared cover directory");
        fs::create_dir_all(base.join("next-up-covers/game_2"))
            .expect("create legacy next-up cover directory");
        fs::create_dir_all(custom.join("covers/game_3")).expect("create custom cover directory");
        fs::create_dir(&package_stage).expect("create package stage");
        fs::create_dir(&extracted).expect("create extraction directory");
        fs::write(base.join("covers/game_1/cover.png"), b"main cover").expect("write base cover");
        fs::write(base.join("covers/game_3/cover.png"), b"base cover")
            .expect("write base shared cover");
        fs::write(
            base.join("next-up-covers/game_2/cover.png"),
            b"legacy next-up cover",
        )
        .expect("write next-up cover");
        fs::write(custom.join("covers/game_3/cover.png"), b"custom cover")
            .expect("write custom cover");
        fs::write(package_stage.join(DATABASE_NAME), b"database bytes")
            .expect("write package database");
        let manifest = UserDataManifest {
            format_version: 1,
            app_version: "1.0.0".to_string(),
            exported_at: "2026-10-20T00:00:00+08:00".to_string(),
            store_json: None,
        };
        fs::write(
            package_stage.join(MANIFEST_NAME),
            serde_json::to_vec(&manifest).expect("serialize manifest"),
        )
        .expect("write manifest");

        stage_user_data_media(&base, Some(&custom), &package_stage)
            .expect("stage both media roots");
        create_user_data_archive(&package_stage, &archive).expect("create v1 package");
        extract_user_data_archive(&archive, &extracted).expect("read v1 package");
        validate_staged_user_data_package(&extracted).expect("validate v1 package");

        assert_eq!(
            fs::read(extracted.join("covers/game_1/cover.png")).expect("read base cover"),
            b"main cover"
        );
        assert_eq!(
            fs::read(extracted.join("covers/game_3/cover.png")).expect("read custom cover"),
            b"custom cover"
        );
        assert_eq!(
            fs::read(extracted.join("next-up-covers/game_2/cover.png"))
                .expect("read next-up cover"),
            b"legacy next-up cover"
        );
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[cfg(windows)]
    #[test]
    fn windows_export_rejects_media_junction_without_copying_external_files() {
        let root = test_root("export-media-junction");
        let base = root.join("base");
        let outside = root.join("outside");
        let stage = root.join("stage");
        let covers_root = base.join("covers");
        fs::create_dir_all(&outside).expect("create outside directory");
        fs::create_dir(&base).expect("create base directory");
        fs::create_dir(&stage).expect("create export stage");
        fs::write(outside.join("secret.png"), b"outside media").expect("write outside media");

        create_test_junction(&covers_root, &outside);
        let root_error = stage_user_data_media(&base, None, &stage)
            .expect_err("export must reject a media root junction");
        assert!(
            root_error.contains("重解析点"),
            "unexpected error: {root_error}"
        );
        assert!(!stage.join("covers/secret.png").exists());

        fs::remove_dir(&covers_root).expect("remove media root junction");
        fs::create_dir(&covers_root).expect("create regular covers root");
        let junction = covers_root.join("external");
        create_test_junction(&junction, &outside);

        let error = stage_user_data_media(&base, None, &stage)
            .expect_err("export must reject a directory junction");

        assert!(error.contains("重解析点"), "unexpected error: {error}");
        assert!(!stage.join("covers/external/secret.png").exists());
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn pre_import_directory_backups_do_not_replace_same_second_archive() {
        let root = test_root("pre-import-backup-collision");
        let source = root.join("covers");
        fs::create_dir_all(&source).expect("create source directory");
        fs::write(source.join("cover.png"), b"current cover").expect("write source cover");
        let timestamp = "20261020_120000";
        let existing = root.join(format!("skerry_covers_pre_userdata_{timestamp}.7z"));
        fs::write(&existing, b"earlier backup").expect("write existing backup");

        let created = write_pre_import_directory_backup(&source, &root, "covers", timestamp)
            .expect("create a collision-safe backup");

        assert_eq!(
            created
                .file_name()
                .expect("backup filename")
                .to_string_lossy(),
            format!("skerry_covers_pre_userdata_{timestamp}_1.7z")
        );
        assert_eq!(
            fs::read(&existing).expect("read original backup"),
            b"earlier backup"
        );
        let mut reader = open_validated_archive(&created).expect("open created backup");
        let extracted = root.join("extracted");
        fs::create_dir(&extracted).expect("create extraction directory");
        extract_validated_archive(&mut reader, &extracted).expect("extract created backup");
        assert_eq!(
            fs::read(extracted.join("cover.png")).expect("read backed-up cover"),
            b"current cover"
        );
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn pre_import_next_up_covers_backup_is_readable() {
        let root = test_root("pre-import-next-up-backup");
        let source = root.join("next-up-covers");
        fs::create_dir_all(&source).expect("create legacy media directory");
        fs::write(source.join("cover.png"), b"legacy media").expect("write legacy media");

        let archive =
            write_pre_import_directory_backup(&source, &root, "next_up_covers", "20261020_120000")
                .expect("create legacy media restore point");
        let extracted = root.join("extracted");
        fs::create_dir(&extracted).expect("create extraction directory");
        extract_user_data_archive(&archive, &extracted).expect("read legacy media backup");

        assert_eq!(
            fs::read(extracted.join("cover.png")).expect("read backed-up media"),
            b"legacy media"
        );
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn failed_pre_import_directory_backup_removes_partial_archive() {
        let root = test_root("pre-import-backup-failure");
        let missing_source = root.join("missing-covers");

        let error =
            write_pre_import_directory_backup(&missing_source, &root, "covers", "20261020_120000")
                .expect_err("missing source should fail backup creation");

        assert!(error.starts_with("备份 covers 失败:"));
        assert_eq!(
            fs::read_dir(&root).expect("read backup directory").count(),
            0
        );
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn failed_export_keeps_final_destination_absent_and_cleans_stage() {
        let root = test_root("failed-export");
        let target = root.join("profile.7z");

        let error = create_user_data_archive(&root.join("missing-source"), &target)
            .expect_err("missing source should fail archive creation");

        assert!(error.starts_with("压缩用户数据失败:"));
        assert!(!target.exists());
        assert!(export_staging_entries(&root).is_empty());
        fs::remove_dir_all(root).expect("remove test directory");
    }
}

#[cfg(test)]
mod package_validation_tests {
    use super::*;
    use sevenz_rust2::{ArchiveEntry, ArchiveWriter};
    use std::sync::atomic::{AtomicU64, Ordering};

    fn test_stage(label: &str) -> PathBuf {
        static NEXT_ID: AtomicU64 = AtomicU64::new(0);
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let stage = std::env::temp_dir().join(format!(
            "skerry_user_data_package_{label}_{}_{id}",
            std::process::id()
        ));
        fs::create_dir_all(&stage).expect("create package stage");
        stage
    }

    fn write_valid_package_files(stage: &Path, format_version: u32) {
        fs::write(stage.join(DATABASE_NAME), b"sqlite database placeholder")
            .expect("write package database fixture");
        let manifest = UserDataManifest {
            format_version,
            app_version: "1.0.0".to_string(),
            exported_at: "2026-10-19T00:00:00+08:00".to_string(),
            store_json: None,
        };
        fs::write(
            stage.join(MANIFEST_NAME),
            serde_json::to_vec(&manifest).expect("serialize package manifest fixture"),
        )
        .expect("write package manifest fixture");
    }

    fn write_archive(path: &Path, entries: &[(&str, &[u8])]) {
        let mut writer = ArchiveWriter::create(path).expect("create archive writer");
        for (name, contents) in entries {
            writer
                .push_archive_entry(ArchiveEntry::new_file(name), Some(*contents))
                .expect("write archive entry");
        }
        writer.finish().expect("finish archive");
    }

    #[test]
    fn preview_and_import_package_validation_accept_the_same_v1_manifest() {
        let stage = test_stage("valid-v1");
        write_valid_package_files(&stage, 1);

        let manifest = validate_staged_user_data_package(&stage)
            .expect("v1 package should be accepted by the shared validator");

        assert_eq!(manifest.format_version, 1);
        assert_eq!(manifest.app_version, "1.0.0");
        fs::remove_dir_all(stage).expect("remove package stage");
    }

    #[test]
    fn package_validation_rejects_missing_required_files() {
        let stage = test_stage("missing-files");

        let error = validate_staged_user_data_package(&stage)
            .expect_err("package without required files must be rejected");

        assert_eq!(error, "无效的用户数据包：缺少数据库或清单文件");
        fs::remove_dir_all(stage).expect("remove package stage");
    }

    #[test]
    fn package_validation_rejects_invalid_json_and_unsupported_versions() {
        let stage = test_stage("invalid-manifest");
        fs::write(stage.join(DATABASE_NAME), b"sqlite database placeholder")
            .expect("write package database fixture");
        fs::write(stage.join(MANIFEST_NAME), b"{").expect("write invalid manifest");
        let error = validate_staged_user_data_package(&stage)
            .expect_err("invalid manifest JSON must be rejected");
        assert!(error.starts_with("用户数据清单无效:"));

        write_valid_package_files(&stage, 2);
        let error = validate_staged_user_data_package(&stage)
            .expect_err("unsupported package version must be rejected");
        assert_eq!(error, "不支持的用户数据包版本: 2");
        fs::remove_dir_all(stage).expect("remove package stage");
    }

    #[test]
    fn user_data_archive_ingest_accepts_v1_content_and_ignored_extra_files() {
        let root = test_stage("archive-ingest-valid");
        let archive = root.join("profile.7z");
        let stage = root.join("stage");
        let manifest = UserDataManifest {
            format_version: 1,
            app_version: "1.0.0".to_string(),
            exported_at: "2026-10-19T00:00:00+08:00".to_string(),
            store_json: None,
        };
        let manifest_bytes = serde_json::to_vec(&manifest).expect("serialize manifest");
        fs::create_dir(&stage).expect("create extraction stage");
        write_archive(
            &archive,
            &[
                (DATABASE_NAME, b"database bytes"),
                (MANIFEST_NAME, &manifest_bytes),
                ("extra/metadata.txt", b"preserved package extra"),
            ],
        );

        extract_user_data_archive(&archive, &stage).expect("extract valid user-data package");
        let restored_manifest = validate_staged_user_data_package(&stage)
            .expect("validate extracted user-data package");

        assert_eq!(restored_manifest.format_version, 1);
        assert_eq!(
            fs::read(stage.join("extra/metadata.txt")).expect("read extra package file"),
            b"preserved package extra"
        );
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn user_data_archive_ingest_rejects_traversal_before_writing_stage() {
        let root = test_stage("archive-ingest-traversal");
        let archive = root.join("malicious.7z");
        let stage = root.join("stage");
        let escaped = root.join("escaped.txt");
        fs::create_dir(&stage).expect("create extraction stage");
        write_archive(&archive, &[("../escaped.txt", b"outside stage")]);

        let error = extract_user_data_archive(&archive, &stage)
            .expect_err("archive traversal must be rejected");

        assert!(error.contains("不安全的名称"));
        assert!(!escaped.exists());
        assert_eq!(
            fs::read_dir(&stage).expect("read extraction stage").count(),
            0
        );
        fs::remove_dir_all(root).expect("remove test directory");
    }
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
        extract_user_data_archive(&archive, &stage)
            .map_err(|error| format!("读取用户数据包失败: {error}"))?;
        let manifest = validate_staged_user_data_package(&stage)?;

        let extracted_db = stage.join(DATABASE_NAME);
        validate_import_database(&extracted_db)
            .await
            .map_err(|error| format!("用户数据包数据库无效: {error}"))?;
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

    let cleanup = remove_dir_if_exists(&stage);
    include_staging_cleanup(result, cleanup, |mut result, warning| {
        result.warnings.push(warning.to_string());
        result
    })
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
    let mut publication_stages = Vec::new();
    let result = async {
        extract_user_data_archive(&archive, &stage)
            .map_err(|error| format!("解压用户数据包失败: {error}"))?;
        let manifest = validate_staged_user_data_package(&stage)?;
        let extracted_db = stage.join(DATABASE_NAME);

        let base_data_dir = skerry_path::get_base_data_dir()?;
        let target_db = skerry_path::get_db_path()?;
        let staged_db = stage_file_copy(&extracted_db, &target_db, "userdata-database")?;
        publication_stages.push(staged_db.clone());
        validate_import_database(&staged_db).await?;

        let covers_target = base_data_dir.join("covers");
        let staged_covers =
            if stage.join("covers").is_dir() || stage.join("next-up-covers").is_dir() {
                let staged = stage_directory(&covers_target, "userdata-covers")?;
                publication_stages.push(staged.clone());
                copy_dir_merge(&stage.join("covers"), &staged)?;
                copy_dir_merge(&stage.join("next-up-covers"), &staged)?;
                Some(staged)
            } else {
                None
            };

        // Do all package validation and staging before creating recovery copies.
        // This avoids leaving import backups for a package that cannot be installed.
        let backup_dir = resolve_backup_dir(db.inner()).await?;
        let database_backup = backup_database_file(db.inner()).await?;
        backup_user_directory(&base_data_dir.join("covers"), &backup_dir, "covers").await?;
        backup_user_directory(
            &base_data_dir.join("next-up-covers"),
            &backup_dir,
            "next_up_covers",
        )
        .await?;

        // Prepared data lives beside its targets. The only post-close work is
        // a small set of renames with an explicit rollback path.
        if let Err(error) = crate::database::db::close_connection(db.inner().clone()).await {
            return Ok(ImportUserDataResult {
                success: false,
                message: format!("关闭数据库连接失败: {error}；应用将自动重启以恢复连接"),
                backup_path: database_backup.path,
                store_json: None,
                restart_required: true,
            });
        }

        let replacements = [
            PathReplacement {
                target: target_db,
                staged: Some(staged_db),
                existing_path: ExistingPathPolicy::Replace,
            },
            PathReplacement {
                target: covers_target,
                staged: staged_covers,
                existing_path: ExistingPathPolicy::Replace,
            },
            PathReplacement {
                target: base_data_dir.join("next-up-covers"),
                staged: None,
                existing_path: ExistingPathPolicy::Replace,
            },
        ];
        if let Err(error) = publish_path_replacements(&replacements) {
            return Ok(ImportUserDataResult {
                success: false,
                message: format!("导入用户数据失败: {error}；应用将自动重启"),
                backup_path: database_backup.path,
                store_json: None,
                restart_required: true,
            });
        }

        Ok(ImportUserDataResult {
            success: true,
            message: "用户数据导入成功，应用将自动重启".to_string(),
            backup_path: database_backup.path,
            store_json: manifest.store_json,
            restart_required: true,
        })
    }
    .await;

    let mut cleanup_errors = Vec::new();
    for staged in publication_stages {
        if let Err(error) = remove_import_staging_path(&staged) {
            cleanup_errors.push(error);
        }
    }
    if let Err(error) = remove_dir_if_exists(&stage) {
        cleanup_errors.push(error);
    }
    let cleanup = if cleanup_errors.is_empty() {
        Ok(())
    } else {
        Err(cleanup_errors.join("; "))
    };
    include_staging_cleanup(result, cleanup, |mut result, warning| {
        result.message.push_str("；");
        result.message.push_str(warning);
        result
    })
}

#[cfg(test)]
mod staging_path_tests {
    use super::unique_temp_dir;
    use std::fs;

    #[test]
    fn concurrent_operations_receive_distinct_exclusive_stage_directories() {
        let first = unique_temp_dir("parallel-check").unwrap();
        let second = unique_temp_dir("parallel-check").unwrap();

        assert_ne!(first, second);
        assert!(first.is_dir());
        assert!(second.is_dir());
        fs::remove_dir_all(first).unwrap();
        fs::remove_dir_all(second).unwrap();
    }
}
