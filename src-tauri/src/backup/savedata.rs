use super::archive::{
    SavedataArchiveEntryKind, create_7z_archive, extract_validated_archive,
    open_legacy_savedata_archive, open_rooted_savedata_archive, resolve_restore_target,
    unique_sibling_path,
};
#[cfg(any(not(windows), test))]
use crate::backup::common::reserve_backup_file_path;
use crate::backup::common::{ExistingPathPolicy, PathReplacement, publish_path_replacements};
#[cfg(windows)]
use crate::backup::common::{
    publish_staged_backup_file_windows, reserve_staged_backup_file_windows,
};
use crate::database::dto::UpdateSettingsData;
use crate::database::repository::game_query_repository::GameQueryRepository;
use crate::database::repository::savedata_repository::SavedataRepository;
use crate::database::repository::settings_repository::SettingsRepository;
use crate::database::repository::to_database_game_id;
use chrono::Utc;
use sea_orm::{DatabaseConnection, TransactionTrait};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, Metadata};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, OnceLock, Weak};
use tokio::sync::{Mutex, OwnedMutexGuard, OwnedRwLockReadGuard, RwLock};

static SAVEDATA_BACKUP_OPERATION_LOCKS: OnceLock<Mutex<HashMap<i64, Weak<Mutex<()>>>>> =
    OnceLock::new();
static SAVEDATA_BACKUP_ROOT_LOCK: OnceLock<Arc<RwLock<()>>> = OnceLock::new();

fn savedata_backup_root_lock() -> Arc<RwLock<()>> {
    Arc::clone(SAVEDATA_BACKUP_ROOT_LOCK.get_or_init(|| Arc::new(RwLock::new(()))))
}

async fn savedata_backup_root_read_lock() -> OwnedRwLockReadGuard<()> {
    savedata_backup_root_lock().read_owned().await
}

async fn savedata_backup_root_write_lock() -> tokio::sync::OwnedRwLockWriteGuard<()> {
    savedata_backup_root_lock().write_owned().await
}

// Serialize file and retention changes for one game without blocking other games.
async fn savedata_backup_operation_lock(game_id: i64) -> OwnedMutexGuard<()> {
    let operation_lock = {
        let locks = SAVEDATA_BACKUP_OPERATION_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
        let mut locks = locks.lock().await;
        locks.retain(|_, lock| lock.strong_count() > 0);

        match locks.get(&game_id).and_then(Weak::upgrade) {
            Some(lock) => lock,
            None => {
                let lock = Arc::new(Mutex::new(()));
                locks.insert(game_id, Arc::downgrade(&lock));
                lock
            }
        }
    };

    operation_lock.lock_owned().await
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BackupInfo {
    pub folder_name: String,
    pub backup_time: i64,
    pub file_size: u64,
    pub backup_path: String,
}

#[derive(Debug, Serialize)]
pub struct RestoreSavedataResult {
    pub restored_path: String,
    pub replaced_existing: bool,
    pub restored_to_alternate: bool,
    pub cleanup_warning: Option<String>,
}
/// 创建游戏存档备份
///
/// 备份目录优先级：
/// 1. 使用 user.save_root_path/backups（如果设置且非空）
/// 2. 使用默认路径：
///    - 便携模式：程序目录/backups
///    - 非便携模式：AppData/backups
///
/// # Arguments
/// * `app` - Tauri应用句柄
/// * `game_id` - 游戏ID
/// * `source_path` - 源存档文件夹路径
///
/// # Returns
/// * `Result<BackupInfo, String>` - 备份信息或错误消息
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn create_savedata_backup(
    db: tauri::State<'_, DatabaseConnection>,
    game_id: i64,
    source_path: String,
) -> Result<BackupInfo, String> {
    create_savedata_backup_with_db(&db, game_id, source_path).await
}

pub async fn create_savedata_backup_with_db(
    db: &DatabaseConnection,
    game_id: i64,
    source_path: String,
) -> Result<BackupInfo, String> {
    let source_path = Path::new(&source_path);

    // 验证源路径是否存在
    if !source_path.exists() {
        return Err("源存档文件夹不存在".to_string());
    }

    if !source_path.is_dir() {
        return Err("源路径必须是一个文件夹".to_string());
    }

    let _root_guard = savedata_backup_root_read_lock().await;
    let _operation_guard = savedata_backup_operation_lock(game_id).await;
    let backup_root = resolve_savedata_backup_root(db).await?;
    let database_game_id =
        to_database_game_id(game_id).ok_or_else(|| format!("游戏不存在: {game_id}"))?;

    // 创建游戏专属备份目录
    let game_backup_dir = backup_root.join(format!("game_{}", game_id));

    ensure_savedata_backup_directory(&game_backup_dir)?;
    fs::create_dir_all(&game_backup_dir).map_err(|e| format!("创建备份目录失败: {}", e))?;
    ensure_savedata_backup_directory(&game_backup_dir)?;

    // 生成备份文件名（带时间戳）
    let now = Utc::now();
    let timestamp = now.timestamp();
    let database_timestamp =
        i32::try_from(timestamp).map_err(|_| "备份时间超出数据库整数范围".to_string())?;
    let timestamp_part = now.format("%Y%m%d_%H%M%S").to_string();
    let filename_stem = format!("savedata_{game_id}_{timestamp_part}");
    let (backup_filename, backup_file_path, backup_size) =
        create_and_publish_savedata_archive(source_path, &game_backup_dir, &filename_stem).await?;

    let database_file_size = match i32::try_from(backup_size) {
        Ok(size) => size,
        Err(_) => {
            return Err(remove_unregistered_archive(
                &backup_file_path,
                "备份文件大小超出数据库整数范围".to_string(),
            ));
        }
    };

    let backup_record_id = match SavedataRepository::save_savedata_record(
        db,
        database_game_id,
        &backup_filename,
        database_timestamp,
        database_file_size,
    )
    .await
    {
        Ok(record_id) => record_id,
        Err(error) => {
            return Err(remove_unregistered_archive(
                &backup_file_path,
                format!("保存存档备份记录失败: {error}"),
            ));
        }
    };

    // 只有新归档和数据库记录都成功后才清理历史项；清理失败不撤销有效的新备份。
    if let Err(error) =
        cleanup_old_backups(db, &game_backup_dir, database_game_id, backup_record_id).await
    {
        log::warn!("新存档备份已创建，但清理旧备份失败 game_id={game_id}: {error}");
    }

    log::info!(
        "存档备份创建成功 game_id={} file={} size={} bytes",
        game_id,
        backup_filename,
        backup_size
    );

    Ok(BackupInfo {
        folder_name: backup_filename,
        backup_time: timestamp,
        file_size: backup_size,
        backup_path: backup_file_path.to_string_lossy().to_string(),
    })
}

fn remove_unregistered_archive(path: &Path, error: String) -> String {
    match fs::remove_file(path) {
        Ok(()) => error,
        Err(cleanup_error) if cleanup_error.kind() == std::io::ErrorKind::NotFound => error,
        Err(cleanup_error) => format!("{error}；清理未登记备份文件失败: {cleanup_error}"),
    }
}

#[cfg(windows)]
async fn create_and_publish_savedata_archive(
    source_path: &Path,
    backup_dir: &Path,
    filename_stem: &str,
) -> Result<(String, PathBuf, u64), String> {
    let stage_target = backup_dir.join(format!("{filename_stem}.7z"));
    let staged_archive = reserve_staged_backup_file_windows(&stage_target, "backup-create")?;
    let archive_source = source_path.to_path_buf();
    let archive_target = staged_archive.clone();
    let archive_result = tokio::task::spawn_blocking(move || {
        create_7z_archive(&archive_source, &archive_target)
            .map_err(|error| format!("创建压缩包失败: {error}"))
    })
    .await;
    let backup_size = match archive_result {
        Ok(Ok(size)) => size,
        Ok(Err(error)) => return Err(remove_unregistered_archive(&staged_archive, error)),
        Err(error) => {
            return Err(remove_unregistered_archive(
                &staged_archive,
                format!("创建压缩任务失败: {error}"),
            ));
        }
    };

    match publish_staged_backup_file_windows(&staged_archive, backup_dir, filename_stem, "7z") {
        Ok((filename, path)) => Ok((filename, path, backup_size)),
        Err(error) => Err(remove_unregistered_archive(
            &staged_archive,
            format!("发布存档备份失败: {error}"),
        )),
    }
}

#[cfg(not(windows))]
async fn create_and_publish_savedata_archive(
    source_path: &Path,
    backup_dir: &Path,
    filename_stem: &str,
) -> Result<(String, PathBuf, u64), String> {
    let (filename, archive_path) = reserve_backup_file_path(backup_dir, filename_stem, "7z")?;
    let archive_source = source_path.to_path_buf();
    let archive_target = archive_path.clone();
    let archive_result = tokio::task::spawn_blocking(move || {
        create_7z_archive(&archive_source, &archive_target)
            .map_err(|error| format!("创建压缩包失败: {error}"))
    })
    .await;
    let backup_size = match archive_result {
        Ok(Ok(size)) => size,
        Ok(Err(error)) => return Err(remove_unregistered_archive(&archive_path, error)),
        Err(error) => {
            return Err(remove_unregistered_archive(
                &archive_path,
                format!("创建压缩任务失败: {error}"),
            ));
        }
    };
    Ok((filename, archive_path, backup_size))
}

/// 恢复存档备份
///
/// # Arguments
/// * `backup_file_path` - 备份文件完整路径
/// * `target_path` - 目标恢复路径
///
/// # Returns
/// * `Result<(), String>` - 成功或错误消息
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn restore_savedata_backup(
    backup_file_path: String,
    target_path: String,
) -> Result<RestoreSavedataResult, String> {
    let _root_guard = savedata_backup_root_read_lock().await;
    let backup_path = PathBuf::from(&backup_file_path);
    let target_path = PathBuf::from(&target_path);

    // 验证备份文件是否存在
    if !backup_path.is_file() {
        return Err("备份文件不存在".to_string());
    }
    let backup_name = backup_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "<unknown>".to_string());

    let restore_result = tokio::task::spawn_blocking(move || {
        restore_savedata_backup_sync(&backup_path, &target_path)
    })
    .await
    .map_err(|e| format!("解压任务失败: {e}"))??;

    log::info!(
        "存档备份恢复成功 file={} target={} alternate={}",
        backup_name,
        restore_result.restored_path,
        restore_result.restored_to_alternate
    );
    Ok(restore_result)
}

fn restore_savedata_backup_sync(
    backup_path: &Path,
    target_path: &Path,
) -> Result<RestoreSavedataResult, String> {
    if is_rooted_v2_savedata_archive(backup_path) {
        return restore_rooted_v2_savedata_archive(backup_path, target_path);
    }
    restore_legacy_v1_savedata_archive(backup_path, target_path)
}

fn restore_legacy_v1_savedata_archive(
    archive_path: &Path,
    requested_target: &Path,
) -> Result<RestoreSavedataResult, String> {
    let (mut reader, archive_info) = open_legacy_savedata_archive(archive_path)
        .map_err(|error| format!("解压备份失败: {error}"))?;
    let final_path = resolve_restore_target(requested_target)
        .map_err(|error| format!("解压备份失败: {error}"))?;

    let target_kind =
        existing_savedata_kind(&final_path).map_err(|error| format!("解压备份失败: {error}"))?;
    if target_kind.is_some_and(|kind| kind != SavedataArchiveEntryKind::Directory) {
        return Err("解压备份失败: 恢复目标路径不是目录".to_string());
    }
    reject_archive_inside_restore_target(archive_path, &final_path)
        .map_err(|error| format!("解压备份失败: {error}"))?;

    let staging = create_savedata_restore_stage(&final_path)
        .map_err(|error| format!("解压备份失败: {error}"))?;
    if let Err(error) = extract_validated_archive(&mut reader, &staging) {
        return Err(with_savedata_restore_cleanup(
            format!("解压备份失败: {error}"),
            &staging,
        ));
    }

    let plan = RootedRestorePlan {
        final_path,
        replace_existing: target_kind.is_some(),
        restored_to_alternate: false,
    };
    let (replaced_existing, cleanup_warning) =
        match publish_savedata_payload(&staging, &plan, SavedataArchiveEntryKind::Directory) {
            Ok(result) => result,
            Err(error) => {
                return Err(with_savedata_restore_cleanup(
                    format!("解压备份失败: {error}"),
                    &staging,
                ));
            }
        };
    let cleanup_warning = with_savedata_restore_warning(cleanup_warning, &staging);

    log::info!(
        "旧版存档恢复成功 target={} entries={} bytes={}",
        requested_target.display(),
        archive_info.entry_count,
        archive_info.total_size
    );
    Ok(RestoreSavedataResult {
        restored_path: requested_target.to_string_lossy().into_owned(),
        replaced_existing,
        restored_to_alternate: false,
        cleanup_warning,
    })
}

fn is_rooted_v2_savedata_archive(archive_path: &Path) -> bool {
    archive_path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("savedata_v2_") && name.ends_with(".7z"))
}

struct RootedRestorePlan {
    final_path: PathBuf,
    replace_existing: bool,
    restored_to_alternate: bool,
}

fn restore_rooted_v2_savedata_archive(
    archive_path: &Path,
    target_path: &Path,
) -> Result<RestoreSavedataResult, String> {
    let (mut reader, archive_info) = open_rooted_savedata_archive(archive_path)
        .map_err(|error| format!("备份预检失败: {error}"))?;
    let target_kind = existing_savedata_kind(target_path)?;
    if target_kind.is_some_and(|kind| kind != archive_info.root_kind) {
        return Err("当前存档与备份类型不一致，拒绝恢复".to_string());
    }
    let plan = plan_rooted_restore(&archive_info.root_name, target_path, target_kind)?;

    let parent = plan
        .final_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    ensure_safe_restore_ancestors(parent)?;
    fs::create_dir_all(parent).map_err(|error| format!("创建恢复目录失败: {error}"))?;
    ensure_safe_restore_ancestors(parent)?;
    reject_archive_inside_restore_target(archive_path, &plan.final_path)?;

    let staging = create_savedata_restore_stage(&plan.final_path)?;
    if let Err(error) = extract_validated_archive(&mut reader, &staging) {
        return Err(with_savedata_restore_cleanup(
            format!("解压备份失败: {error}"),
            &staging,
        ));
    }

    let payload = staging.join(&archive_info.root_name);
    if let Err(error) = validate_staged_savedata_payload(&payload, archive_info.root_kind) {
        return Err(with_savedata_restore_cleanup(
            format!("解压内容校验失败: {error}"),
            &staging,
        ));
    }

    let (replaced_existing, cleanup_warning) =
        match publish_savedata_payload(&payload, &plan, archive_info.root_kind) {
            Ok(result) => result,
            Err(error) => {
                return Err(with_savedata_restore_cleanup(error, &staging));
            }
        };
    let cleanup_warning = with_savedata_restore_warning(cleanup_warning, &staging);

    Ok(RestoreSavedataResult {
        restored_path: plan.final_path.to_string_lossy().into_owned(),
        replaced_existing,
        restored_to_alternate: plan.restored_to_alternate,
        cleanup_warning,
    })
}

fn plan_rooted_restore(
    archived_root_name: &str,
    target_path: &Path,
    target_kind: Option<SavedataArchiveEntryKind>,
) -> Result<RootedRestorePlan, String> {
    let target_name = target_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "当前存档路径没有有效名称".to_string())?;
    let parent = target_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));

    if savedata_names_match(target_name, archived_root_name) {
        return Ok(RootedRestorePlan {
            final_path: target_path.to_path_buf(),
            replace_existing: target_kind.is_some(),
            restored_to_alternate: false,
        });
    }

    let alternate = parent.join(archived_root_name);
    match existing_savedata_kind(&alternate)? {
        Some(_) => Err(format!(
            "备份原名目标已存在，拒绝覆盖: {}",
            alternate.display()
        )),
        None => Ok(RootedRestorePlan {
            final_path: alternate,
            replace_existing: false,
            restored_to_alternate: true,
        }),
    }
}

fn savedata_names_match(current: &str, archived: &str) -> bool {
    #[cfg(windows)]
    {
        current.eq_ignore_ascii_case(archived)
    }
    #[cfg(not(windows))]
    {
        current == archived
    }
}

fn existing_savedata_kind(path: &Path) -> Result<Option<SavedataArchiveEntryKind>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if is_path_redirector(&metadata) {
                return Err(format!(
                    "存档路径不能是符号链接或重解析点: {}",
                    path.display()
                ));
            }
            if metadata.is_dir() {
                Ok(Some(SavedataArchiveEntryKind::Directory))
            } else if metadata.is_file() {
                Ok(Some(SavedataArchiveEntryKind::File))
            } else {
                Err(format!("存档路径必须是普通文件或目录: {}", path.display()))
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("读取存档路径失败 {}: {error}", path.display())),
    }
}

fn ensure_safe_restore_ancestors(path: &Path) -> Result<(), String> {
    let mut current = Some(path);
    while let Some(candidate) = current {
        match fs::symlink_metadata(candidate) {
            Ok(metadata) => {
                if is_path_redirector(&metadata) {
                    return Err(format!(
                        "恢复父路径包含路径重定向对象: {}",
                        candidate.display()
                    ));
                }
                if candidate.parent().is_some() && !metadata.is_dir() {
                    return Err(format!("恢复父路径不是目录: {}", candidate.display()));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "检查恢复父路径失败 {}: {error}",
                    candidate.display()
                ));
            }
        }
        current = candidate.parent();
    }
    Ok(())
}

#[cfg(windows)]
fn is_path_redirector(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_path_redirector(metadata: &Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn reject_archive_inside_restore_target(
    archive_path: &Path,
    target_path: &Path,
) -> Result<(), String> {
    let archive_path =
        fs::canonicalize(archive_path).map_err(|error| format!("读取备份路径失败: {error}"))?;
    let target_path = match fs::canonicalize(target_path) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = target_path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .unwrap_or_else(|| Path::new("."));
            fs::canonicalize(parent)
                .map_err(|parent_error| format!("读取恢复父路径失败: {parent_error}"))?
                .join(target_path.file_name().ok_or("恢复目标没有有效名称")?)
        }
        Err(error) => return Err(format!("读取恢复目标失败: {error}")),
    };
    if archive_path.starts_with(target_path) {
        return Err("备份文件位于恢复目标目录内，拒绝覆盖该文件".to_string());
    }
    Ok(())
}

fn create_savedata_restore_stage(target_path: &Path) -> Result<PathBuf, String> {
    for _ in 0..100 {
        let candidate = unique_sibling_path(target_path, "savedata-restore")
            .map_err(|error| format!("准备恢复暂存路径失败: {error}"))?;
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("创建恢复暂存目录失败: {error}")),
        }
    }
    Err("无法创建唯一恢复暂存目录".to_string())
}

fn validate_staged_savedata_payload(
    payload: &Path,
    expected_kind: SavedataArchiveEntryKind,
) -> Result<(), String> {
    let actual_kind =
        existing_savedata_kind(payload)?.ok_or_else(|| "恢复暂存内容缺少存档根对象".to_string())?;
    if actual_kind != expected_kind {
        return Err("解压后的存档类型与归档声明不一致".to_string());
    }
    let parent = payload
        .parent()
        .ok_or_else(|| "恢复暂存目录没有父路径".to_string())?;
    let children = fs::read_dir(parent)
        .map_err(|error| format!("读取恢复暂存目录失败: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取恢复暂存条目失败: {error}"))?;
    if children.len() != 1 || children[0].file_name() != payload.file_name().unwrap_or_default() {
        return Err("恢复暂存目录包含非预期顶层条目".to_string());
    }
    Ok(())
}

fn publish_savedata_payload(
    payload: &Path,
    plan: &RootedRestorePlan,
    expected_kind: SavedataArchiveEntryKind,
) -> Result<(bool, Option<String>), String> {
    let parent = plan
        .final_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    ensure_safe_restore_ancestors(parent)?;

    let existing_kind = existing_savedata_kind(&plan.final_path)?;
    if existing_kind.is_some() && !plan.replace_existing {
        return Err(format!(
            "恢复目标已存在，拒绝覆盖: {}",
            plan.final_path.display()
        ));
    }
    if existing_kind.is_some_and(|kind| kind != expected_kind) {
        return Err("恢复目标类型已改变，拒绝替换".to_string());
    }

    let staged_path = unique_sibling_path(&plan.final_path, "savedata-restore-publish")
        .map_err(|error| format!("准备恢复发布路径失败: {error}"))?;
    fs::rename(payload, &staged_path).map_err(|error| {
        format!(
            "准备恢复内容失败 {} -> {}: {error}",
            payload.display(),
            staged_path.display()
        )
    })?;

    let existing_path = if existing_kind.is_some() {
        ExistingPathPolicy::Replace
    } else {
        ExistingPathPolicy::CreateOnly
    };
    let replacement = PathReplacement {
        target: plan.final_path.clone(),
        staged: Some(staged_path.clone()),
        existing_path,
    };
    let publication = match publish_path_replacements(&[replacement]) {
        Ok(result) => result,
        Err(error) => {
            let cleanup = remove_savedata_object_if_present(&staged_path).err();
            return Err(match cleanup {
                Some(cleanup) => format!("{error}；{cleanup}"),
                None => error,
            });
        }
    };

    let cleanup_warning = publication
        .cleanup_warnings
        .into_iter()
        .next()
        .map(|warning| {
            format!(
                "恢复成功，但清理原存档 {} 失败: {}",
                warning.preserved_path.display(),
                warning.error
            )
        });
    Ok((existing_kind.is_some(), cleanup_warning))
}

fn remove_savedata_object_if_present(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!("检查恢复暂存内容失败 {}: {error}", path.display()));
        }
    };
    let result = if metadata.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    };
    result.map_err(|error| format!("清理恢复暂存内容失败 {}: {error}", path.display()))
}

fn remove_savedata_restore_stage(path: &Path) -> Result<(), String> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => {
            let message = format!("清理存档恢复暂存目录失败 {}: {error}", path.display());
            log::warn!("{message}");
            Err(message)
        }
    }
}

fn with_savedata_restore_cleanup(operation_error: String, staging: &Path) -> String {
    match remove_savedata_restore_stage(staging) {
        Ok(()) => operation_error,
        Err(cleanup_error) => format!("{operation_error}；{cleanup_error}"),
    }
}

fn with_savedata_restore_warning(
    existing_warning: Option<String>,
    staging: &Path,
) -> Option<String> {
    let cleanup_warning = remove_savedata_restore_stage(staging).err();
    match (existing_warning, cleanup_warning) {
        (Some(existing), Some(cleanup)) => Some(format!("{existing}；{cleanup}")),
        (Some(existing), None) => Some(existing),
        (None, Some(cleanup)) => Some(cleanup),
        (None, None) => None,
    }
}

#[cfg(feature = "tauri-app")]
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveResult {
    pub success: bool,
    pub message: String,
    pub source_retained: bool,
}

/// 移动存档备份文件夹到新位置
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn move_backup_folder(old_path: String, new_path: String) -> Result<MoveResult, String> {
    let _root_guard = savedata_backup_root_write_lock().await;
    tokio::task::spawn_blocking(move || move_backup_folder_blocking(&old_path, &new_path))
        .await
        .map_err(|e| format!("移动备份目录任务失败: {e}"))?
}

/// Relocate the configured savedata backup directory and persist its setting as one operation.
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn relocate_savedata_backup_root(
    db: tauri::State<'_, DatabaseConnection>,
    data: UpdateSettingsData,
) -> Result<MoveResult, String> {
    relocate_savedata_backup_root_with_db(&db, data).await
}

async fn relocate_savedata_backup_root_with_db(
    db: &DatabaseConnection,
    data: UpdateSettingsData,
) -> Result<MoveResult, String> {
    let _root_guard = savedata_backup_root_write_lock().await;
    let old_backup_path = resolve_savedata_backup_root(db).await?;
    let requested_save_root = data
        .save_root_path
        .as_ref()
        .ok_or_else(|| "备份根目录迁移缺少 save_root_path 设置".to_string())?;
    let new_backup_path = match requested_save_root {
        Some(path) => PathBuf::from(path).join("backups"),
        None => skerry_path::get_default_savedata_backup_path().map(PathBuf::from)?,
    };

    let old_path = old_backup_path.clone();
    let new_path = new_backup_path.clone();
    let result = tokio::task::spawn_blocking(move || {
        move_backup_folder_blocking(&old_path.to_string_lossy(), &new_path.to_string_lossy())
    })
    .await
    .map_err(|error| format!("移动备份目录任务失败: {error}"))??;
    if !result.success {
        return Ok(result);
    }

    if let Err(error) = SettingsRepository::update_settings(db, data.cleaned()).await {
        let rollback = if result.source_retained {
            "原目录仍保留，数据库设置未变更".to_string()
        } else {
            let rollback_old = new_backup_path.clone();
            let rollback_new = old_backup_path.clone();
            match tokio::task::spawn_blocking(move || {
                move_backup_folder_blocking(
                    &rollback_old.to_string_lossy(),
                    &rollback_new.to_string_lossy(),
                )
            })
            .await
            {
                Ok(Ok(rollback)) if rollback.success => "目录已回退".to_string(),
                Ok(Ok(rollback)) => format!("目录回退失败: {}", rollback.message),
                Ok(Err(error)) => format!("目录回退失败: {error}"),
                Err(error) => format!("目录回退任务失败: {error}"),
            }
        };
        return Err(format!("更新备份目录设置失败: {error}；{rollback}"));
    }

    Ok(result)
}

#[cfg(feature = "tauri-app")]
fn move_backup_folder_blocking(old_path: &str, new_path: &str) -> Result<MoveResult, String> {
    let old_backup_path = Path::new(&old_path);
    let new_backup_path = Path::new(&new_path);

    match fs::metadata(old_backup_path) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => {
            return Ok(MoveResult {
                success: false,
                message: format!("旧备份路径不是文件夹: {}", old_backup_path.display()),
                source_retained: true,
            });
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(MoveResult {
                success: true,
                message: "旧备份文件夹不存在，无需移动".to_string(),
                source_retained: false,
            });
        }
        Err(error) => {
            return Ok(MoveResult {
                success: false,
                message: format!(
                    "检查旧备份文件夹失败 {}: {error}",
                    old_backup_path.display()
                ),
                source_retained: true,
            });
        }
    }

    if old_backup_path == new_backup_path {
        return Ok(MoveResult {
            success: true,
            message: "备份目录位置未变化，无需移动".to_string(),
            source_retained: false,
        });
    }

    if let Some(parent) = new_backup_path.parent()
        && !parent.exists()
        && let Err(e) = fs::create_dir_all(parent)
    {
        return Ok(MoveResult {
            success: false,
            message: format!("无法创建目标目录: {}", e),
            source_retained: true,
        });
    }

    match fs::symlink_metadata(new_backup_path) {
        Ok(_) => {
            return Ok(MoveResult {
                success: false,
                message: "目标位置已存在备份文件夹，请手动处理".to_string(),
                source_retained: true,
            });
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Ok(MoveResult {
                success: false,
                message: format!(
                    "检查目标备份位置失败 {}: {error}",
                    new_backup_path.display()
                ),
                source_retained: true,
            });
        }
    }

    match fs::rename(old_backup_path, new_backup_path) {
        Ok(_) => Ok(MoveResult {
            success: true,
            message: "备份文件夹移动成功".to_string(),
            source_retained: false,
        }),
        Err(rename_error) => {
            let staging_path = match create_backup_staging_dir(new_backup_path) {
                Ok(path) => path,
                Err(error) => {
                    return Ok(MoveResult {
                        success: false,
                        message: format!("无法准备备份迁移目录: {error}"),
                        source_retained: true,
                    });
                }
            };

            let copy_result = copy_backup_tree(old_backup_path, &staging_path)
                .and_then(|()| verify_backup_tree(old_backup_path, &staging_path));

            if let Err(error) = copy_result {
                let cleanup = fs::remove_dir_all(&staging_path);
                let cleanup_note = cleanup
                    .err()
                    .map(|cleanup_error| format!("；临时目录清理失败: {cleanup_error}"))
                    .unwrap_or_default();
                return Ok(MoveResult {
                    success: false,
                    message: format!("备份复制失败，原备份已保留: {error}{cleanup_note}"),
                    source_retained: true,
                });
            }

            if let Err(error) = fs::rename(&staging_path, new_backup_path) {
                let cleanup = fs::remove_dir_all(&staging_path);
                let cleanup_note = cleanup
                    .err()
                    .map(|cleanup_error| format!("；临时目录清理失败: {cleanup_error}"))
                    .unwrap_or_default();
                return Ok(MoveResult {
                    success: false,
                    message: format!("无法发布复制后的备份目录: {error}{cleanup_note}"),
                    source_retained: true,
                });
            }

            Ok(MoveResult {
                success: true,
                message: format!(
                    "备份已复制到新位置，原目录已保留以便回退（原子移动失败: {rename_error}）"
                ),
                source_retained: true,
            })
        }
    }
}

#[cfg(feature = "tauri-app")]
fn create_backup_staging_dir(destination: &Path) -> Result<PathBuf, String> {
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_STAGING_ID: AtomicU64 = AtomicU64::new(0);
    let parent = destination
        .parent()
        .ok_or_else(|| "目标备份目录没有父目录".to_string())?;
    let name = destination
        .file_name()
        .ok_or_else(|| "目标备份目录名称无效".to_string())?
        .to_string_lossy();

    for _ in 0..100 {
        let id = NEXT_STAGING_ID.fetch_add(1, Ordering::Relaxed);
        let staging = parent.join(format!(
            ".{name}.skerry-migration-{}-{id}",
            std::process::id()
        ));
        match fs::create_dir(&staging) {
            Ok(()) => return Ok(staging),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }

    Err("无法分配唯一的临时备份目录".to_string())
}

#[cfg(feature = "tauri-app")]
fn copy_backup_tree(source: &Path, destination: &Path) -> std::io::Result<()> {
    let source_metadata = fs::symlink_metadata(source)?;
    let destination_metadata = fs::symlink_metadata(destination)?;
    if !source_metadata.is_dir()
        || is_path_redirector(&source_metadata)
        || !destination_metadata.is_dir()
        || is_path_redirector(&destination_metadata)
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "备份迁移的源和暂存目标必须是普通目录",
        ));
    }

    let mut pending_directories = vec![(source.to_path_buf(), destination.to_path_buf())];

    while let Some((source_directory, destination_directory)) = pending_directories.pop() {
        for entry in fs::read_dir(&source_directory)? {
            let entry = entry?;
            let source_path = entry.path();
            let destination_path = destination_directory.join(entry.file_name());
            let metadata = fs::symlink_metadata(&source_path)?;

            if is_path_redirector(&metadata) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!(
                        "备份目录中不允许包含符号链接或重解析点: {}",
                        source_path.display()
                    ),
                ));
            }
            if metadata.is_dir() {
                fs::create_dir(&destination_path)?;
                pending_directories.push((source_path, destination_path));
            } else if metadata.is_file() {
                fs::copy(&source_path, &destination_path)?;
            } else {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("备份目录中包含不支持的文件类型: {}", source_path.display()),
                ));
            }
        }
    }

    Ok(())
}

#[cfg(feature = "tauri-app")]
fn verify_backup_tree(source: &Path, destination: &Path) -> std::io::Result<()> {
    let source_metadata = fs::symlink_metadata(source)?;
    let destination_metadata = fs::symlink_metadata(destination)?;
    if !source_metadata.is_dir()
        || is_path_redirector(&source_metadata)
        || !destination_metadata.is_dir()
        || is_path_redirector(&destination_metadata)
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "备份迁移的源和暂存目标必须是普通目录",
        ));
    }

    let mut pending_directories = vec![(source.to_path_buf(), destination.to_path_buf())];

    while let Some((source_directory, destination_directory)) = pending_directories.pop() {
        let mut source_entries = fs::read_dir(&source_directory)?
            .map(|entry| entry.map(|entry| (entry.file_name(), entry.path())))
            .collect::<Result<Vec<_>, _>>()?;
        let mut destination_entries = fs::read_dir(&destination_directory)?
            .map(|entry| entry.map(|entry| (entry.file_name(), entry.path())))
            .collect::<Result<Vec<_>, _>>()?;
        source_entries.sort_unstable_by(|left, right| left.0.cmp(&right.0));
        destination_entries.sort_unstable_by(|left, right| left.0.cmp(&right.0));

        if source_entries.len() != destination_entries.len()
            || source_entries
                .iter()
                .zip(&destination_entries)
                .any(|(source_entry, destination_entry)| source_entry.0 != destination_entry.0)
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("备份目录迁移后条目不一致: {}", source_directory.display()),
            ));
        }

        for ((_, source_path), (_, destination_path)) in
            source_entries.into_iter().zip(destination_entries)
        {
            let source_metadata = fs::symlink_metadata(&source_path)?;
            let destination_metadata = fs::symlink_metadata(&destination_path)?;
            if is_path_redirector(&source_metadata) || is_path_redirector(&destination_metadata) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!(
                        "备份目录迁移后出现符号链接或重解析点: {}",
                        destination_path.display()
                    ),
                ));
            }

            if source_metadata.is_dir() && destination_metadata.is_dir() {
                pending_directories.push((source_path, destination_path));
            } else if source_metadata.is_file() && destination_metadata.is_file() {
                if source_metadata.len() != destination_metadata.len()
                    || !backup_files_have_equal_contents(&source_path, &destination_path)?
                {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        format!("备份目录迁移后文件内容不一致: {}", source_path.display()),
                    ));
                }
            } else {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("备份目录迁移后条目类型不一致: {}", source_path.display()),
                ));
            }
        }
    }

    Ok(())
}

#[cfg(feature = "tauri-app")]
fn backup_files_have_equal_contents(left: &Path, right: &Path) -> std::io::Result<bool> {
    let mut left_file = fs::File::open(left)?;
    let mut right_file = fs::File::open(right)?;
    let mut left_buffer = [0; 64 * 1024];
    let mut right_buffer = [0; 64 * 1024];

    loop {
        let left_read = read_backup_file_chunk(&mut left_file, &mut left_buffer)?;
        let right_read = read_backup_file_chunk(&mut right_file, &mut right_buffer)?;
        if left_read != right_read || left_buffer[..left_read] != right_buffer[..right_read] {
            return Ok(false);
        }
        if left_read == 0 {
            return Ok(true);
        }
    }
}

#[cfg(feature = "tauri-app")]
fn read_backup_file_chunk(reader: &mut fs::File, buffer: &mut [u8]) -> std::io::Result<usize> {
    use std::io::Read;

    let mut bytes_read = 0;
    while bytes_read < buffer.len() {
        match reader.read(&mut buffer[bytes_read..]) {
            Ok(0) => break,
            Ok(count) => bytes_read += count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    Ok(bytes_read)
}

/// 删除单个备份记录（文件 + 数据库）
///
/// 文件确实删除或已经不存在时才删除记录；文件删除失败时保留记录。
///
/// # Arguments
/// * `db` - 数据库连接
/// * `backup_file_path` - 备份文件完整路径
/// * `backup_id` - 数据库记录 ID
///
/// # Returns
/// * `Option<String>` - 如果有错误返回错误信息，否则返回 None
async fn delete_backup_record(
    db: &DatabaseConnection,
    backup_file_path: &Path,
    backup_id: i32,
) -> Option<String> {
    let staged_file = match stage_backup_file_for_deletion(backup_file_path) {
        Ok(staged_file) => staged_file,
        Err(error) => return Some(error),
    };

    let transaction = match db.begin().await {
        Ok(transaction) => transaction,
        Err(error) => {
            let restore_status =
                restore_staged_backup_after_delete_failure(staged_file.as_ref(), backup_file_path);
            return Some(format!(
                "开启存档备份删除事务失败 (ID: {backup_id}): {error}；{restore_status}"
            ));
        }
    };

    if let Err(error) = SavedataRepository::delete_savedata_record(&transaction, backup_id).await {
        let rollback_error = transaction.rollback().await.err();
        let restore_status =
            restore_staged_backup_after_delete_failure(staged_file.as_ref(), backup_file_path);
        let transaction_status = rollback_error
            .map(|rollback_error| format!("数据库回滚失败: {rollback_error}"))
            .unwrap_or_else(|| "数据库记录已保留".to_string());
        return Some(format!(
            "删除数据库记录失败 (ID: {backup_id}): {error}；{transaction_status}；{restore_status}"
        ));
    }

    if let Err(error) = transaction.commit().await {
        let restore_status =
            restore_staged_backup_after_delete_failure(staged_file.as_ref(), backup_file_path);
        return Some(format!(
            "提交存档备份删除失败 (ID: {backup_id}): {error}；{restore_status}"
        ));
    }

    if let Some(staged_file) = staged_file {
        remove_committed_backup_deletion_stage(&staged_file);
    }

    None
}

struct StagedBackupFile {
    path: PathBuf,
    directory: PathBuf,
}

fn stage_backup_file_for_deletion(path: &Path) -> Result<Option<StagedBackupFile>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "检查备份文件失败 {:?}: {error}；数据库记录已保留",
                path
            ));
        }
    };

    if metadata.is_dir() {
        return Err(format!(
            "删除备份文件失败 {:?}: 目标是目录；数据库记录已保留",
            path
        ));
    }

    let file_name = path
        .file_name()
        .ok_or_else(|| format!("备份文件路径没有文件名: {:?}；数据库记录已保留", path))?;
    let directory = create_savedata_delete_stage_directory(path)?;
    let staged_file = StagedBackupFile {
        path: directory.join(file_name),
        directory,
    };

    match fs::rename(path, &staged_file.path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            remove_empty_backup_deletion_stage(&staged_file.directory);
            return Ok(None);
        }
        Err(error) => {
            remove_empty_backup_deletion_stage(&staged_file.directory);
            return Err(format!(
                "删除备份文件失败 {:?}: {error}；数据库记录已保留",
                path
            ));
        }
    }

    match fs::symlink_metadata(&staged_file.path) {
        Ok(metadata) if !metadata.is_dir() => Ok(Some(staged_file)),
        Ok(_) => {
            let restore_status =
                restore_staged_backup_after_delete_failure(Some(&staged_file), path);
            Err(format!(
                "删除备份文件失败 {:?}: 目标在操作期间变成目录；{restore_status}",
                path
            ))
        }
        Err(error) => {
            let restore_status =
                restore_staged_backup_after_delete_failure(Some(&staged_file), path);
            Err(format!(
                "检查暂存备份文件失败 {:?}: {error}；{restore_status}",
                staged_file.path
            ))
        }
    }
}

fn create_savedata_delete_stage_directory(path: &Path) -> Result<PathBuf, String> {
    for _ in 0..100 {
        let candidate = unique_sibling_path(path, "savedata-delete")
            .map_err(|error| format!("准备备份删除暂存目录失败: {error}"))?;
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("创建备份删除暂存目录失败: {error}")),
        }
    }
    Err("无法创建唯一备份删除暂存目录".to_string())
}

fn restore_staged_backup_after_delete_failure(
    staged_file: Option<&StagedBackupFile>,
    original_path: &Path,
) -> String {
    let Some(staged_file) = staged_file else {
        return "备份文件原本不存在".to_string();
    };

    match restore_staged_backup_file(staged_file, original_path) {
        Ok(()) => "备份文件已恢复到原路径".to_string(),
        Err(error) => format!(
            "备份文件回滚失败: {error}；文件仍保存在 {}",
            staged_file.path.display()
        ),
    }
}

fn restore_staged_backup_file(
    staged_file: &StagedBackupFile,
    original_path: &Path,
) -> Result<(), String> {
    match fs::symlink_metadata(original_path) {
        Ok(_) => {
            return Err(format!("原备份路径已被占用: {}", original_path.display()));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "检查原备份路径失败 {}: {error}",
                original_path.display()
            ));
        }
    }

    fs::rename(&staged_file.path, original_path).map_err(|error| {
        format!(
            "恢复备份文件 {} -> {} 失败: {error}",
            staged_file.path.display(),
            original_path.display()
        )
    })?;
    remove_empty_backup_deletion_stage(&staged_file.directory);
    Ok(())
}

fn remove_committed_backup_deletion_stage(staged_file: &StagedBackupFile) {
    if let Err(error) = fs::remove_file(&staged_file.path) {
        log::warn!(
            "备份记录已删除，但暂存归档清理失败 path={}: {error}",
            staged_file.path.display()
        );
        return;
    }
    remove_empty_backup_deletion_stage(&staged_file.directory);
}

fn remove_empty_backup_deletion_stage(directory: &Path) {
    if let Err(error) = fs::remove_dir(directory)
        && error.kind() != std::io::ErrorKind::NotFound
    {
        log::warn!(
            "清理备份删除暂存目录失败 path={}: {error}",
            directory.display()
        );
    }
}

/// 删除备份文件和数据库记录
///
/// 二合一功能：同时删除备份文件和对应的数据库记录。
/// 文件不存在时清理陈旧记录；文件删除失败时保留记录并返回错误。
///
/// # Arguments
/// * `app` - Tauri应用句柄
/// * `db` - 数据库连接
/// * `backup_id` - 备份记录ID
///
/// # Returns
/// * `Result<(), String>` - 成功或错误消息
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn delete_savedata_backup(
    db: tauri::State<'_, DatabaseConnection>,
    backup_id: i32,
) -> Result<(), String> {
    delete_savedata_backup_with_db(&db, backup_id).await
}

pub async fn delete_savedata_backup_with_db(
    db: &DatabaseConnection,
    backup_id: i32,
) -> Result<(), String> {
    let _root_guard = savedata_backup_root_read_lock().await;
    let initial_record = SavedataRepository::get_savedata_record_by_id(db, backup_id)
        .await
        .map_err(|e| format!("获取备份记录失败: {}", e))?
        .ok_or_else(|| "备份记录不存在".to_string())?;
    let _operation_guard = savedata_backup_operation_lock(i64::from(initial_record.game_id)).await;
    let record = SavedataRepository::get_savedata_record_by_id(db, backup_id)
        .await
        .map_err(|e| format!("获取备份记录失败: {}", e))?
        .ok_or_else(|| "备份记录不存在".to_string())?;
    if record.game_id != initial_record.game_id {
        return Err("备份记录所属游戏已变化，请重试".to_string());
    }

    let backup_root = resolve_savedata_backup_root(db).await?;
    let game_backup_dir = backup_root.join(format!("game_{}", record.game_id));
    let backup_path = savedata_backup_file_path(&game_backup_dir, &record.file)?;

    // 使用通用函数删除备份记录
    if let Some(error) = delete_backup_record(db, &backup_path, backup_id).await {
        return Err(error);
    }

    log::info!(
        "存档备份删除成功 backup_id={} game_id={}",
        backup_id,
        record.game_id
    );

    Ok(())
}

async fn resolve_savedata_backup_root(db: &DatabaseConnection) -> Result<PathBuf, String> {
    use crate::database::repository::settings_repository::DbSettingsExt;
    let settings = db.get_settings().await?;

    let backup_root = if let Some(custom) = settings.save_root_path_value() {
        PathBuf::from(custom).join("backups")
    } else {
        skerry_path::get_base_data_dir()?.join("backups")
    };

    Ok(backup_root)
}

/// 清理超出数量限制的旧备份（基于数据库记录，异步处理）
///
/// 从 games 表中读取该游戏的 maxbackups 设置
///
/// # Arguments
/// * `db` - 数据库连接
/// * `backup_dir` - 备份目录路径
/// * `game_id` - 游戏ID
///
/// # Returns
/// * `Result<(), String>` - 成功或错误消息
async fn cleanup_old_backups(
    db: &DatabaseConnection,
    backup_dir: &Path,
    game_id: i32,
    new_backup_id: i32,
) -> Result<(), String> {
    // 从数据库获取游戏信息，读取 maxbackups 设置
    let game = GameQueryRepository::find_by_id(db, game_id)
        .await
        .map_err(|e| format!("获取游戏信息失败: {}", e))?;

    // 获取最大备份数量（前端已设置默认值20，不会为null）
    let max_backups = usize::try_from(game.and_then(|g| g.maxbackups).unwrap_or(20).max(1))
        .map_err(|_| "最大备份数量超出当前平台支持范围".to_string())?;

    // 从数据库获取该游戏的所有备份记录
    let records = SavedataRepository::get_savedata_records(db, game_id)
        .await
        .map_err(|e| format!("获取备份记录失败: {}", e))?;

    let records_to_delete = records_to_prune(records, new_backup_id, max_backups)?;
    if records_to_delete.is_empty() {
        return Ok(());
    }

    // 收集错误信息，不中断循环
    let mut errors: Vec<String> = Vec::new();

    // 使用通用函数删除文件和数据库记录
    let mut deleted_count = 0;
    for record in &records_to_delete {
        let backup_file_path = match savedata_backup_file_path(backup_dir, &record.file) {
            Ok(path) => path,
            Err(error) => {
                errors.push(format!("备份记录 {} 的文件名无效: {error}", record.id));
                continue;
            }
        };

        if let Some(error) = delete_backup_record(db, &backup_file_path, record.id).await {
            errors.push(error);
        } else {
            deleted_count += 1;
        }
    }

    log::debug!(
        "旧存档备份清理完成 game_id={} deleted_count={}",
        game_id,
        deleted_count
    );

    // 有错误时记录日志，但不终止备份流程
    if !errors.is_empty() {
        log::warn!(
            "清理旧备份时遇到 {} 个错误:\n{}",
            errors.len(),
            errors.join("\n")
        );
    }

    Ok(())
}

fn records_to_prune(
    records: Vec<crate::entity::savedata::Model>,
    new_backup_id: i32,
    max_backups: usize,
) -> Result<Vec<crate::entity::savedata::Model>, String> {
    if !records.iter().any(|record| record.id == new_backup_id) {
        return Err("新备份记录未出现在清理查询结果中".to_string());
    }

    let excess_count = records.len().saturating_sub(max_backups.max(1));
    if excess_count == 0 {
        return Ok(Vec::new());
    }

    let mut older_records = records
        .into_iter()
        .filter(|record| record.id != new_backup_id)
        .collect::<Vec<_>>();
    older_records.sort_by_key(|record| (record.backup_time, record.id));
    older_records.truncate(excess_count);
    Ok(older_records)
}

fn savedata_backup_file_path(backup_dir: &Path, file_name: &str) -> Result<PathBuf, String> {
    let mut components = Path::new(file_name).components();
    let is_single_normal_component =
        matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none();
    if file_name.is_empty()
        || file_name.contains('/')
        || file_name.contains('\\')
        || file_name.contains(':')
        || !is_single_normal_component
    {
        return Err("备份记录文件名必须是单个普通文件名".to_string());
    }

    ensure_savedata_backup_directory(backup_dir)?;
    Ok(backup_dir.join(file_name))
}

fn ensure_savedata_backup_directory(backup_dir: &Path) -> Result<(), String> {
    match fs::symlink_metadata(backup_dir) {
        Ok(metadata) if is_path_redirector(&metadata) => {
            return Err(format!(
                "游戏备份目录不能是符号链接或重解析点: {}",
                backup_dir.display()
            ));
        }
        Ok(metadata) if !metadata.is_dir() => {
            return Err(format!("游戏备份路径不是目录: {}", backup_dir.display()));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "检查游戏备份目录失败 {}: {error}",
                backup_dir.display()
            ));
        }
        _ => {}
    }

    Ok(())
}

#[cfg(test)]
mod savedata_backup_tests {
    use super::*;
    use sea_orm::{
        ActiveValue::Set, ConnectionTrait, Database, DatabaseBackend, EntityTrait, Statement,
    };
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::time::Duration;

    fn test_root(label: &str) -> PathBuf {
        static NEXT_ID: AtomicU64 = AtomicU64::new(0);
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "skerry_savedata_backup_{label}_{}_{id}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("create test directory");
        root
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn completed_archive_is_published_after_staging_without_overwriting_a_collision() {
        let root = test_root("staged-create-collision");
        let source = root.join("source");
        let backup_dir = root.join("backups");
        fs::create_dir_all(&source).expect("create source directory");
        fs::create_dir_all(&backup_dir).expect("create backup directory");
        fs::write(source.join("slot.dat"), b"complete save data").expect("write save data");
        let filename_stem = "savedata_7_20261020_123456";
        let existing = backup_dir.join(format!("{filename_stem}.7z"));
        fs::write(&existing, b"pre-existing archive").expect("write collision file");

        let (filename, published, size) =
            create_and_publish_savedata_archive(&source, &backup_dir, filename_stem)
                .await
                .expect("create and publish a completed archive");

        assert_eq!(filename, format!("{filename_stem}_1.7z"));
        assert_eq!(published, backup_dir.join(&filename));
        assert_eq!(
            fs::read(&existing).expect("read collision file"),
            b"pre-existing archive"
        );
        assert_eq!(
            fs::metadata(&published)
                .expect("published archive metadata")
                .len(),
            size
        );
        let (_, archive_info) = open_legacy_savedata_archive(&published).expect("validate archive");
        assert_eq!(archive_info.entry_count, 1);
        assert_eq!(
            archive_info.total_size,
            u64::try_from(b"complete save data".len()).expect("test payload length fits u64")
        );
        assert_eq!(
            fs::read_dir(&backup_dir)
                .expect("read backup directory")
                .count(),
            2,
            "only the existing archive and completed archive remain"
        );

        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn failed_staged_archive_creation_removes_the_incomplete_file() {
        let root = test_root("staged-create-failure");
        let missing_source = root.join("missing-source");

        let error = create_and_publish_savedata_archive(&missing_source, &root, "savedata_7_test")
            .await
            .expect_err("missing source must fail archive creation");

        assert!(error.contains("创建压缩包失败"));
        assert_eq!(
            fs::read_dir(&root).expect("read backup directory").count(),
            0,
            "failed archive creation must not leave a staged or published file"
        );
        fs::remove_dir_all(root).expect("remove test directory");
    }

    fn record(id: i32, backup_time: i32) -> crate::entity::savedata::Model {
        crate::entity::savedata::Model {
            id,
            game_id: 7,
            file: format!("savedata_7_{id}.7z"),
            backup_time,
            file_size: 1,
        }
    }

    fn lock_test_game_id() -> i64 {
        static NEXT_LOCK_GAME_ID: AtomicU64 = AtomicU64::new(0);
        9_000_000_000_i64
            + i64::try_from(NEXT_LOCK_GAME_ID.fetch_add(1, Ordering::Relaxed))
                .expect("test lock ID fits i64")
    }

    #[tokio::test]
    async fn backup_operations_serialize_per_game_and_allow_other_games_to_continue() {
        let game_id = lock_test_game_id();
        let other_game_id = lock_test_game_id();
        let first_guard = savedata_backup_operation_lock(game_id).await;
        let other_guard = tokio::time::timeout(
            Duration::from_secs(1),
            savedata_backup_operation_lock(other_game_id),
        )
        .await
        .expect("a different game's backup should not wait");

        let operation_started = Arc::new(AtomicBool::new(false));
        let operation_entered = Arc::clone(&operation_started);
        let (waiting_tx, waiting_rx) = tokio::sync::oneshot::channel();
        let waiting_operation = tokio::spawn(async move {
            waiting_tx.send(()).expect("signal lock attempt");
            let _guard = savedata_backup_operation_lock(game_id).await;
            operation_entered.store(true, Ordering::Release);
        });

        waiting_rx.await.expect("receive lock attempt");
        tokio::task::yield_now().await;
        assert!(!operation_started.load(Ordering::Acquire));

        drop(other_guard);
        drop(first_guard);
        waiting_operation
            .await
            .expect("same-game backup operation should finish");
        assert!(operation_started.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn backup_root_migration_waits_for_active_root_operations() {
        let active_operation = savedata_backup_root_read_lock().await;
        let migration_started = Arc::new(AtomicBool::new(false));
        let migration_entered = Arc::clone(&migration_started);
        let (waiting_tx, waiting_rx) = tokio::sync::oneshot::channel();
        let migration = tokio::spawn(async move {
            waiting_tx.send(()).expect("signal migration lock attempt");
            let _guard = savedata_backup_root_write_lock().await;
            migration_entered.store(true, Ordering::Release);
        });

        waiting_rx.await.expect("receive migration lock attempt");
        tokio::task::yield_now().await;
        assert!(!migration_started.load(Ordering::Acquire));

        drop(active_operation);
        tokio::time::timeout(Duration::from_secs(1), migration)
            .await
            .expect("migration should continue after active operations finish")
            .expect("migration task should finish");
        assert!(migration_started.load(Ordering::Acquire));
    }

    async fn savedata_database() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("connect in-memory database");
        db.execute(Statement::from_string(
            DatabaseBackend::Sqlite,
            "CREATE TABLE savedata (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                game_id INTEGER NOT NULL,
                file TEXT NOT NULL,
                backup_time INTEGER NOT NULL,
                file_size INTEGER NOT NULL
            )"
            .to_string(),
        ))
        .await
        .expect("create savedata table");
        db
    }

    async fn backup_application_database(save_root: &Path) -> DatabaseConnection {
        use crate::entity::{games, prelude::Games};
        use migration::{Migrator, MigratorTrait};

        let db = Database::connect("sqlite::memory:")
            .await
            .expect("connect in-memory database");
        Migrator::up(&db, None)
            .await
            .expect("apply current schema migrations");
        crate::database::repository::settings_repository::SettingsRepository::get_all_settings(&db)
            .await
            .expect("create the settings row");
        db.execute(Statement::from_sql_and_values(
            DatabaseBackend::Sqlite,
            "UPDATE user SET save_root_path = ? WHERE id = 1",
            [save_root.to_string_lossy().into_owned().into()],
        ))
        .await
        .expect("configure the savedata root");
        Games::insert(games::ActiveModel {
            id: Set(7),
            id_type: Set("custom".to_string()),
            launch_type: Set("local".to_string()),
            maxbackups: Set(Some(1)),
            ..Default::default()
        })
        .exec(&db)
        .await
        .expect("create game with one-backup retention");

        db
    }

    #[cfg(feature = "tauri-app")]
    #[tokio::test]
    async fn backup_root_relocation_moves_files_and_persists_the_selected_root() {
        let root = test_root("root-relocation");
        let old_root = root.join("old");
        let new_root = root.join("new");
        let old_backup_dir = old_root.join("backups").join("game_7");
        fs::create_dir_all(&old_backup_dir).expect("create old backup directory");
        fs::write(old_backup_dir.join("savedata.7z"), b"backup data")
            .expect("write existing backup");
        let db = backup_application_database(&old_root).await;

        let result = relocate_savedata_backup_root_with_db(
            &db,
            UpdateSettingsData {
                save_root_path: Some(Some(new_root.to_string_lossy().into_owned())),
                ..UpdateSettingsData::default()
            },
        )
        .await
        .expect("relocate backup root");

        assert!(result.success);
        assert!(!result.source_retained);
        assert!(!old_root.join("backups").exists());
        assert_eq!(
            fs::read(new_root.join("backups/game_7/savedata.7z")).expect("read moved backup"),
            b"backup data"
        );
        let settings = SettingsRepository::get_all_settings(&db)
            .await
            .expect("read persisted settings");
        assert_eq!(settings.save_root_path.as_deref(), new_root.to_str());
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn same_timestamp_reservation_uses_a_new_file_without_overwriting() {
        let root = test_root("filename-collision");
        let timestamp = "20261019_120000";
        let filename_stem = format!("savedata_7_{timestamp}");
        let (first_name, first_path) =
            reserve_backup_file_path(&root, &filename_stem, "7z").expect("reserve first archive");
        fs::write(&first_path, b"first archive").expect("write first archive");

        let (second_name, second_path) =
            reserve_backup_file_path(&root, &filename_stem, "7z").expect("reserve second archive");

        assert_eq!(first_name, "savedata_7_20261019_120000.7z");
        assert_eq!(second_name, "savedata_7_20261019_120000_1.7z");
        assert_eq!(
            fs::read(&first_path).expect("read first archive"),
            b"first archive"
        );
        assert_eq!(
            fs::metadata(second_path)
                .expect("reserved second file")
                .len(),
            0
        );
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn backup_record_path_rejects_non_filename_components() {
        let root = test_root("unsafe-record-name");
        for file_name in ["../outside.7z", "..\\outside.7z", "C:outside.7z", ""] {
            assert!(
                savedata_backup_file_path(&root, file_name).is_err(),
                "{file_name:?}"
            );
        }
        assert_eq!(
            savedata_backup_file_path(&root, "savedata_7_20261019_120000.7z").unwrap(),
            root.join("savedata_7_20261019_120000.7z")
        );
        let file_instead_of_directory = root.join("not-a-directory");
        fs::write(&file_instead_of_directory, b"file").expect("write file");
        assert!(savedata_backup_file_path(&file_instead_of_directory, "valid.7z").is_err());
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn retention_prunes_oldest_rows_and_always_keeps_the_new_record() {
        let rows = vec![record(1, 10), record(2, 20), record(3, 20)];

        let pruned = records_to_prune(rows, 3, 2).expect("plan retention");

        assert_eq!(pruned.iter().map(|row| row.id).collect::<Vec<_>>(), vec![1]);
    }

    #[test]
    fn retention_uses_record_id_to_order_backups_created_in_the_same_second() {
        let rows = vec![
            record(12, 20),
            record(11, 20),
            record(14, 20),
            record(10, 20),
            record(13, 20),
        ];

        let pruned = records_to_prune(rows, 13, 3).expect("plan retention");

        assert_eq!(
            pruned.iter().map(|row| row.id).collect::<Vec<_>>(),
            vec![10, 11]
        );
    }

    #[test]
    fn retention_selects_only_the_oldest_excess_rows_from_an_unsorted_history() {
        let rows = vec![
            record(6, 30),
            record(5, 20),
            record(1, 10),
            record(3, 20),
            record(2, 20),
            record(4, 15),
        ];

        let pruned = records_to_prune(rows, 6, 4).expect("plan retention");

        assert_eq!(
            pruned.iter().map(|row| row.id).collect::<Vec<_>>(),
            vec![1, 4]
        );
    }

    #[test]
    fn retention_keeps_the_new_record_when_the_limit_is_zero_or_not_exceeded() {
        let rows = vec![record(1, 10), record(2, 20), record(3, 30)];

        assert!(
            records_to_prune(rows.clone(), 3, 3)
                .expect("within retention limit")
                .is_empty()
        );
        assert_eq!(
            records_to_prune(rows, 3, 0)
                .expect("zero limit keeps the required new record")
                .iter()
                .map(|row| row.id)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
    }

    #[tokio::test]
    async fn failed_archive_file_removal_keeps_its_database_record() {
        let db = savedata_database().await;
        let root = test_root("failed-delete");
        let archive_path = root.join("is-a-directory");
        fs::create_dir(&archive_path).expect("create directory at archive path");
        fs::write(archive_path.join("keep.dat"), b"keep").expect("write sentinel");
        let record_id = SavedataRepository::save_savedata_record(&db, 7, "is-a-directory", 10, 4)
            .await
            .expect("insert backup record");

        let error = delete_backup_record(&db, &archive_path, record_id)
            .await
            .expect("file deletion must fail");

        assert!(error.contains("数据库记录已保留"));
        assert!(
            SavedataRepository::get_savedata_record_by_id(&db, record_id)
                .await
                .expect("read savedata record")
                .is_some()
        );
        assert_eq!(fs::read(archive_path.join("keep.dat")).unwrap(), b"keep");
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[tokio::test]
    async fn database_delete_failure_restores_the_staged_archive_and_record() {
        let db = savedata_database().await;
        let root = test_root("database-delete-failure");
        let archive_path = root.join("savedata_7_10.7z");
        fs::write(&archive_path, b"recoverable backup").expect("write backup archive");
        let record_id =
            SavedataRepository::save_savedata_record(&db, 7, "savedata_7_10.7z", 10, 19)
                .await
                .expect("insert backup record");
        db.execute(Statement::from_string(
            DatabaseBackend::Sqlite,
            "CREATE TRIGGER reject_savedata_delete BEFORE DELETE ON savedata \
             BEGIN SELECT RAISE(ABORT, 'injected savedata delete failure'); END",
        ))
        .await
        .expect("create delete failure trigger");

        let error = delete_backup_record(&db, &archive_path, record_id)
            .await
            .expect("database deletion should fail");

        assert!(error.contains("数据库记录已保留"));
        assert!(error.contains("备份文件已恢复到原路径"));
        assert_eq!(
            fs::read(&archive_path).expect("read restored archive"),
            b"recoverable backup"
        );
        assert!(
            SavedataRepository::get_savedata_record_by_id(&db, record_id)
                .await
                .expect("read preserved record")
                .is_some()
        );
        assert_eq!(
            fs::read_dir(&root).expect("read backup directory").count(),
            1,
            "rollback must remove its temporary staging directory"
        );

        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[tokio::test]
    async fn successful_backup_delete_removes_archive_and_record() {
        let db = savedata_database().await;
        let root = test_root("successful-delete");
        let archive_path = root.join("savedata_7_11.7z");
        fs::write(&archive_path, b"backup to delete").expect("write backup archive");
        let record_id =
            SavedataRepository::save_savedata_record(&db, 7, "savedata_7_11.7z", 11, 16)
                .await
                .expect("insert backup record");

        assert_eq!(
            delete_backup_record(&db, &archive_path, record_id).await,
            None
        );

        assert!(!archive_path.exists());
        assert!(
            SavedataRepository::get_savedata_record_by_id(&db, record_id)
                .await
                .expect("read deleted record")
                .is_none()
        );
        assert_eq!(
            fs::read_dir(&root).expect("read backup directory").count(),
            0,
            "successful deletion must remove its temporary staging directory"
        );

        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[tokio::test]
    async fn missing_backup_file_still_removes_its_stale_database_record() {
        let db = savedata_database().await;
        let root = test_root("missing-file-delete");
        let archive_path = root.join("missing.7z");
        let record_id = SavedataRepository::save_savedata_record(&db, 7, "missing.7z", 12, 0)
            .await
            .expect("insert stale backup record");

        assert_eq!(
            delete_backup_record(&db, &archive_path, record_id).await,
            None
        );

        assert!(
            SavedataRepository::get_savedata_record_by_id(&db, record_id)
                .await
                .expect("read deleted stale record")
                .is_none()
        );
        assert_eq!(
            fs::read_dir(&root).expect("read backup directory").count(),
            0
        );

        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[tokio::test]
    async fn backup_creation_registers_the_archive_then_prunes_old_records() {
        let root = test_root("create-and-retain");
        let save_root = root.join("saves");
        let game_backup_dir = save_root.join("backups").join("game_7");
        fs::create_dir_all(&game_backup_dir).expect("create game backup directory");
        let db = backup_application_database(&save_root).await;
        let old_files = ["savedata_7_old_1.7z", "savedata_7_old_2.7z"];
        for (index, file_name) in old_files.iter().enumerate() {
            let path = game_backup_dir.join(file_name);
            fs::write(&path, format!("old backup {index}")).expect("write old backup");
            let file_size = i32::try_from(fs::metadata(&path).expect("old archive metadata").len())
                .expect("test backup size fits savedata schema");
            SavedataRepository::save_savedata_record(
                &db,
                7,
                file_name,
                i32::try_from(index + 1).expect("test timestamp fits savedata schema"),
                file_size,
            )
            .await
            .expect("register old backup");
        }
        let source = root.join("source");
        fs::create_dir_all(&source).expect("create save data source");
        fs::write(source.join("slot.dat"), b"current save data").expect("write save data");

        let backup = create_savedata_backup_with_db(&db, 7, source.to_string_lossy().into_owned())
            .await
            .expect("create and register the backup");

        let backup_path = game_backup_dir.join(&backup.folder_name);
        assert!(backup_path.is_file());
        let records = SavedataRepository::get_savedata_records(&db, 7)
            .await
            .expect("read retained backup records");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].file, backup.folder_name);
        assert_eq!(
            records[0].backup_time,
            i32::try_from(backup.backup_time).expect("stored timestamp fits the database column")
        );
        assert_eq!(
            records[0].file_size,
            i32::try_from(backup.file_size).expect("stored size fits the database column")
        );
        assert_eq!(
            fs::metadata(&backup_path)
                .expect("read created archive metadata")
                .len(),
            backup.file_size
        );
        for file_name in old_files {
            assert!(!game_backup_dir.join(file_name).exists());
        }

        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[tokio::test]
    async fn concurrent_same_game_creations_keep_the_configured_backup_limit() {
        let root = test_root("concurrent-create-retention");
        let save_root = root.join("saves");
        let db = backup_application_database(&save_root).await;
        let first_source = root.join("first-source");
        let second_source = root.join("second-source");
        fs::create_dir_all(&first_source).expect("create first source");
        fs::create_dir_all(&second_source).expect("create second source");
        fs::write(first_source.join("slot.dat"), b"first save").expect("write first save");
        fs::write(second_source.join("slot.dat"), b"second save").expect("write second save");

        let first_backup =
            create_savedata_backup_with_db(&db, 7, first_source.to_string_lossy().into_owned());
        let second_backup =
            create_savedata_backup_with_db(&db, 7, second_source.to_string_lossy().into_owned());
        let (first_backup, second_backup) = tokio::join!(first_backup, second_backup);
        let first_backup = first_backup.expect("create first backup");
        let second_backup = second_backup.expect("create second backup");
        assert_ne!(first_backup.folder_name, second_backup.folder_name);

        let records = SavedataRepository::get_savedata_records(&db, 7)
            .await
            .expect("read retained backup records");
        assert_eq!(records.len(), 1);
        let game_backup_dir = save_root.join("backups").join("game_7");
        assert!(game_backup_dir.join(&records[0].file).is_file());
        assert_eq!(
            fs::read_dir(&game_backup_dir)
                .expect("read game backup directory")
                .count(),
            1
        );

        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[tokio::test]
    async fn failed_record_insert_preserves_old_backups_and_removes_new_archive() {
        let root = test_root("create-record-failure");
        let save_root = root.join("saves");
        let game_backup_dir = save_root.join("backups").join("game_7");
        fs::create_dir_all(&game_backup_dir).expect("create game backup directory");
        let db = backup_application_database(&save_root).await;
        let old_files = ["savedata_7_old_1.7z", "savedata_7_old_2.7z"];
        for (index, file_name) in old_files.iter().enumerate() {
            let path = game_backup_dir.join(file_name);
            fs::write(&path, format!("old backup {index}")).expect("write old backup");
            let file_size = i32::try_from(fs::metadata(&path).expect("old archive metadata").len())
                .expect("test backup size fits savedata schema");
            SavedataRepository::save_savedata_record(
                &db,
                7,
                file_name,
                i32::try_from(index + 1).expect("test timestamp fits savedata schema"),
                file_size,
            )
            .await
            .expect("register old backup");
        }
        db.execute(Statement::from_string(
            DatabaseBackend::Sqlite,
            "CREATE TRIGGER reject_savedata_insert BEFORE INSERT ON savedata \
             BEGIN SELECT RAISE(ABORT, 'injected savedata insert failure'); END",
        ))
        .await
        .expect("install deterministic record failure");
        let source = root.join("source");
        fs::create_dir_all(&source).expect("create save data source");
        fs::write(source.join("slot.dat"), b"current save data").expect("write save data");

        let result =
            create_savedata_backup_with_db(&db, 7, source.to_string_lossy().into_owned()).await;

        assert!(result.unwrap_err().contains("保存存档备份记录失败"));
        let records = SavedataRepository::get_savedata_records(&db, 7)
            .await
            .expect("read old backup records");
        assert_eq!(records.len(), old_files.len());
        for file_name in old_files {
            assert!(game_backup_dir.join(file_name).is_file());
        }
        assert_eq!(
            fs::read_dir(&game_backup_dir)
                .expect("read game backup directory")
                .count(),
            old_files.len()
        );

        fs::remove_dir_all(root).expect("remove test directory");
    }
}

#[cfg(all(test, feature = "tauri-app"))]
mod move_backup_folder_tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_root() -> PathBuf {
        static NEXT_TEST_ID: AtomicU64 = AtomicU64::new(0);
        let id = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "skerry-backup-move-test-{}-{id}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create test directory");
        path
    }

    #[test]
    fn existing_destination_refuses_move_and_preserves_both_directories() {
        let root = temp_root();
        let source = root.join("source");
        let destination = root.join("destination");
        fs::create_dir_all(&source).expect("create source");
        fs::create_dir_all(&destination).expect("create destination");
        fs::write(source.join("backup.zip"), b"source backup").expect("write source backup");
        fs::write(destination.join("keep.txt"), b"existing destination")
            .expect("write existing destination");

        let result = move_backup_folder_blocking(
            source.to_str().expect("source path"),
            destination.to_str().expect("destination path"),
        )
        .expect("move result");

        assert!(!result.success);
        assert!(source.join("backup.zip").is_file());
        assert_eq!(
            fs::read(destination.join("keep.txt")).unwrap(),
            b"existing destination"
        );
        assert!(result.source_retained);
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn non_directory_backup_source_is_not_reported_as_a_successful_noop() {
        let root = temp_root();
        let source = root.join("source-file");
        let destination = root.join("destination");
        fs::write(&source, b"preserve backup data").expect("create source file");

        let result = move_backup_folder_blocking(
            source.to_str().expect("source path"),
            destination.to_str().expect("destination path"),
        )
        .expect("move result");

        assert!(!result.success);
        assert!(result.source_retained);
        assert!(result.message.contains("旧备份路径不是文件夹"));
        assert_eq!(
            fs::read(&source).expect("preserve source"),
            b"preserve backup data"
        );
        assert!(!destination.exists());
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn destination_parent_creation_failure_reports_that_source_was_retained() {
        let root = temp_root();
        let source = root.join("source");
        let blocking_parent = root.join("not-a-directory");
        let destination = blocking_parent.join("nested").join("destination");
        fs::create_dir_all(&source).expect("create source");
        fs::write(source.join("backup.zip"), b"preserve backup").expect("write source backup");
        fs::write(&blocking_parent, b"block parent creation").expect("write blocking parent");

        let result = move_backup_folder_blocking(
            source.to_str().expect("source path"),
            destination.to_str().expect("destination path"),
        )
        .expect("move result");

        assert!(!result.success);
        assert!(result.source_retained);
        assert!(result.message.contains("无法创建目标目录"));
        assert_eq!(
            fs::read(source.join("backup.zip")).expect("preserve source backup"),
            b"preserve backup"
        );
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn identical_paths_are_a_successful_noop() {
        let root = temp_root();
        fs::write(root.join("backup.zip"), b"backup").expect("write backup");

        let result = move_backup_folder_blocking(
            root.to_str().expect("root path"),
            root.to_str().expect("root path"),
        )
        .expect("move result");

        assert!(result.success);
        assert!(root.join("backup.zip").is_file());
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn backup_tree_copy_preserves_nested_and_empty_directories_and_verifies_bytes() {
        let root = temp_root();
        let source = root.join("source");
        let destination = root.join("destination");
        fs::create_dir_all(source.join("nested").join("deeper")).expect("create nested source");
        fs::create_dir(source.join("empty")).expect("create empty source directory");
        fs::write(source.join("backup.7z"), b"archive bytes").expect("write archive");
        fs::write(
            source.join("nested").join("deeper").join("entry.dat"),
            b"save data",
        )
        .expect("write nested save data");
        fs::create_dir(&destination).expect("create destination");

        copy_backup_tree(&source, &destination).expect("copy backup tree");
        verify_backup_tree(&source, &destination).expect("verify copied backup tree");

        fs::write(
            destination.join("nested").join("deeper").join("entry.dat"),
            b"save dAta",
        )
        .expect("change copied data without changing its size");
        let error = verify_backup_tree(&source, &destination).expect_err("content mismatch");
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn backup_tree_verification_rejects_unexpected_destination_entries() {
        let root = temp_root();
        let source = root.join("source");
        let destination = root.join("destination");
        fs::create_dir(&source).expect("create source");
        fs::create_dir(&destination).expect("create destination");
        fs::write(destination.join("unexpected.7z"), b"extra").expect("write extra entry");

        let error = verify_backup_tree(&source, &destination).expect_err("unexpected entry");
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[cfg(windows)]
    #[test]
    fn move_backup_falls_back_to_verified_copy_across_windows_volumes() {
        use std::path::Component;

        fn volume(path: &Path) -> Option<std::ffi::OsString> {
            path.components().find_map(|component| match component {
                Component::Prefix(prefix) => Some(prefix.as_os_str().to_os_string()),
                _ => None,
            })
        }

        let source_root = temp_root();
        let source = source_root.join("source");
        let destination_root = std::env::current_dir()
            .expect("current test directory")
            .join(format!(
                ".skerry-backup-move-test-{}-{}",
                std::process::id(),
                source_root
                    .file_name()
                    .expect("unique source root")
                    .to_string_lossy()
            ));
        let destination = destination_root.join("destination");

        if volume(&source_root) == volume(&destination_root) {
            fs::remove_dir_all(source_root).expect("remove skipped test directory");
            return;
        }

        fs::create_dir_all(source.join("nested").join("deeper")).expect("create nested source");
        fs::create_dir(source.join("empty")).expect("create empty source directory");
        fs::write(source.join("backup.7z"), b"archive bytes").expect("write archive");
        fs::write(
            source.join("nested").join("deeper").join("entry.dat"),
            b"save data",
        )
        .expect("write nested save data");

        let result = move_backup_folder_blocking(
            source.to_str().expect("source path"),
            destination.to_str().expect("destination path"),
        )
        .expect("migration result");

        assert!(result.success, "{}", result.message);
        assert!(result.source_retained);
        assert!(source.join("backup.7z").is_file());
        assert_eq!(
            fs::read(destination.join("nested").join("deeper").join("entry.dat"))
                .expect("read copied save data"),
            b"save data"
        );
        assert!(destination.join("empty").is_dir());
        verify_backup_tree(&source, &destination).expect("verify published migration");

        fs::remove_dir_all(source_root).expect("remove source test directory");
        fs::remove_dir_all(destination_root).expect("remove destination test directory");
    }
}

#[cfg(test)]
mod savedata_restore_tests {
    use super::*;
    use sevenz_rust2::{ArchiveEntry, ArchiveWriter, encoder_options::ZstandardOptions};
    use std::sync::atomic::{AtomicU64, Ordering};

    fn test_root(label: &str) -> PathBuf {
        static NEXT_ID: AtomicU64 = AtomicU64::new(0);
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "skerry_savedata_restore_{label}_{}_{id}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn restore_stage_cleanup_failure_is_returned_with_the_operation_error() {
        let root = test_root("cleanup-error");
        let invalid_stage = root.join("stage-file");
        fs::write(&invalid_stage, b"preserve").unwrap();

        let error = with_savedata_restore_cleanup("存档解压失败".to_string(), &invalid_stage);

        assert!(error.contains("存档解压失败"));
        assert!(error.contains("清理存档恢复暂存目录失败"));
        assert!(error.contains(&invalid_stage.display().to_string()));
        assert_eq!(fs::read(&invalid_stage).unwrap(), b"preserve");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn successful_restore_keeps_existing_and_stage_cleanup_warnings() {
        let root = test_root("cleanup-warning");
        let invalid_stage = root.join("stage-file");
        fs::write(&invalid_stage, b"preserve").unwrap();

        let warning =
            with_savedata_restore_warning(Some("原存档清理失败".to_string()), &invalid_stage)
                .expect("cleanup warning is returned");

        assert!(warning.contains("原存档清理失败"));
        assert!(warning.contains("清理存档恢复暂存目录失败"));
        assert!(warning.contains(&invalid_stage.display().to_string()));
        assert_eq!(fs::read(&invalid_stage).unwrap(), b"preserve");
        fs::remove_dir_all(root).unwrap();
    }

    fn create_rooted_archive(
        archive_path: &Path,
        root_name: &str,
        root_kind: SavedataArchiveEntryKind,
    ) {
        let mut writer = ArchiveWriter::create(archive_path).unwrap();
        writer.set_content_methods(vec![ZstandardOptions::from_level(3).into()]);
        match root_kind {
            SavedataArchiveEntryKind::File => {
                writer
                    .push_archive_entry(
                        ArchiveEntry::new_file(root_name),
                        Some(&b"restored save file"[..]),
                    )
                    .unwrap();
            }
            SavedataArchiveEntryKind::Directory => {
                writer
                    .push_archive_entry::<&[u8]>(ArchiveEntry::new_directory(root_name), None)
                    .unwrap();
                writer
                    .push_archive_entry(
                        ArchiveEntry::new_file(&format!("{root_name}/slot.dat")),
                        Some(&b"restored save data"[..]),
                    )
                    .unwrap();
            }
        }
        writer.finish().unwrap();
    }

    #[test]
    fn restores_rooted_v2_file_and_directory_without_merging() {
        for (name, kind) in [
            ("save.dat", SavedataArchiveEntryKind::File),
            ("SaveData", SavedataArchiveEntryKind::Directory),
        ] {
            let root = test_root(name);
            let archive = root.join("savedata_v2_7_20261018_120000.7z");
            let target = root.join("game").join(name);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            create_rooted_archive(&archive, name, kind);
            match kind {
                SavedataArchiveEntryKind::File => fs::write(&target, b"old file").unwrap(),
                SavedataArchiveEntryKind::Directory => {
                    fs::create_dir(&target).unwrap();
                    fs::write(target.join("slot.dat"), b"old data").unwrap();
                    fs::write(target.join("stale.dat"), b"stale").unwrap();
                }
            }

            let result = restore_savedata_backup_sync(&archive, &target).unwrap();

            assert_eq!(result.restored_path, target.to_string_lossy());
            assert!(result.replaced_existing);
            assert!(!result.restored_to_alternate);
            assert_eq!(result.cleanup_warning, None);
            match kind {
                SavedataArchiveEntryKind::File => {
                    assert_eq!(fs::read(&target).unwrap(), b"restored save file");
                }
                SavedataArchiveEntryKind::Directory => {
                    assert_eq!(
                        fs::read(target.join("slot.dat")).unwrap(),
                        b"restored save data"
                    );
                    assert!(!target.join("stale.dat").exists());
                }
            }
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn restores_mismatched_root_to_its_original_name_and_refuses_an_existing_alternate() {
        let root = test_root("alternate");
        let archive = root.join("savedata_v2_7_20261018_120000.7z");
        let game_dir = root.join("game");
        let current = game_dir.join("CurrentData");
        let alternate = game_dir.join("SaveData");
        fs::create_dir_all(&current).unwrap();
        fs::write(current.join("keep.dat"), b"current save").unwrap();
        create_rooted_archive(&archive, "SaveData", SavedataArchiveEntryKind::Directory);

        let result = restore_savedata_backup_sync(&archive, &current).unwrap();

        assert_eq!(result.restored_path, alternate.to_string_lossy());
        assert!(!result.replaced_existing);
        assert!(result.restored_to_alternate);
        assert_eq!(fs::read(current.join("keep.dat")).unwrap(), b"current save");
        assert_eq!(
            fs::read(alternate.join("slot.dat")).unwrap(),
            b"restored save data"
        );

        fs::write(alternate.join("unknown.dat"), b"keep this too").unwrap();
        assert!(restore_savedata_backup_sync(&archive, &current).is_err());
        assert_eq!(fs::read(current.join("keep.dat")).unwrap(), b"current save");
        assert_eq!(
            fs::read(alternate.join("unknown.dat")).unwrap(),
            b"keep this too"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_rooted_archive_preserves_current_save_and_does_not_escape() {
        let root = test_root("invalid");
        let archive = root.join("savedata_v2_7_20261018_120000.7z");
        let target = root.join("game").join("SaveData");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("keep.dat"), b"current save").unwrap();

        let mut writer = ArchiveWriter::create(&archive).unwrap();
        writer
            .push_archive_entry(
                ArchiveEntry::new_file("../escape.dat"),
                Some(&b"outside"[..]),
            )
            .unwrap();
        writer.finish().unwrap();

        assert!(restore_savedata_backup_sync(&archive, &target).is_err());
        assert_eq!(fs::read(target.join("keep.dat")).unwrap(), b"current save");
        assert!(!root.join("escape.dat").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rooted_restore_rejects_a_file_directory_mismatch_before_replacing_data() {
        let root = test_root("type-mismatch");
        let archive = root.join("savedata_v2_7_20261018_120000.7z");
        let target = root.join("game").join("save.dat");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("keep.dat"), b"current directory save").unwrap();
        create_rooted_archive(&archive, "save.dat", SavedataArchiveEntryKind::File);

        assert!(restore_savedata_backup_sync(&archive, &target).is_err());
        assert_eq!(
            fs::read(target.join("keep.dat")).unwrap(),
            b"current directory save"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rootless_v1_archive_keeps_current_restore_behavior() {
        let root = test_root("v1");
        let source = root.join("source");
        let target = root.join("game").join("SaveData");
        let archive = root.join("savedata_7_20261018_120000.7z");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(source.join("slot.dat"), b"v1 payload").unwrap();
        fs::write(target.join("stale.dat"), b"old payload").unwrap();
        create_7z_archive(&source, &archive).unwrap();

        let result = restore_savedata_backup_sync(&archive, &target).unwrap();

        assert_eq!(result.restored_path, target.to_string_lossy());
        assert!(result.replaced_existing);
        assert!(!result.restored_to_alternate);
        assert_eq!(fs::read(target.join("slot.dat")).unwrap(), b"v1 payload");
        assert!(!target.join("stale.dat").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn empty_rootless_v1_archive_replaces_the_target_with_an_empty_directory() {
        let root = test_root("v1-empty");
        let source = root.join("empty-source");
        let target = root.join("game").join("SaveData");
        let archive = root.join("savedata_7_empty.7z");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("stale.dat"), b"old payload").unwrap();
        create_7z_archive(&source, &archive).unwrap();

        let result = restore_savedata_backup_sync(&archive, &target).unwrap();

        assert!(result.replaced_existing);
        assert!(target.is_dir());
        assert_eq!(fs::read_dir(&target).unwrap().count(), 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_rootless_v1_archive_preserves_target_and_stays_inside_staging() {
        let root = test_root("v1-invalid");
        let archive = root.join("savedata_7_20261018_120000.7z");
        let target = root.join("game").join("SaveData");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("keep.dat"), b"current save").unwrap();

        let mut writer = ArchiveWriter::create(&archive).unwrap();
        writer
            .push_archive_entry(
                ArchiveEntry::new_file("../escape.dat"),
                Some(&b"outside"[..]),
            )
            .unwrap();
        writer.finish().unwrap();

        let error = restore_savedata_backup_sync(&archive, &target).unwrap_err();

        assert!(error.starts_with("解压备份失败:"));
        assert_eq!(fs::read(target.join("keep.dat")).unwrap(), b"current save");
        assert!(!root.join("escape.dat").exists());
        assert_eq!(
            fs::read_dir(target.parent().unwrap()).unwrap().count(),
            1,
            "failed restore should leave no staging directory"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
