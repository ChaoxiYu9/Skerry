use crate::database::dto::UpdateSettingsData;
use crate::database::repository::settings_repository::{DbSettingsExt, SettingsRepository};
use sea_orm::{
    ConnectOptions, ConnectionTrait, Database, DatabaseBackend, DatabaseConnection, Statement,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BackupOptions {
    pub auto: bool,
    pub max_auto_backups: Option<usize>,
}

/// Reserve the first unused filename for a backup that may already exist from
/// an earlier backup created during the same timestamp interval.
#[cfg(any(not(windows), test))]
pub(crate) fn reserve_backup_file_path(
    backup_dir: &Path,
    filename_stem: &str,
    extension: &str,
) -> Result<(String, PathBuf), String> {
    let mut suffix = 0_u64;

    loop {
        let collision_suffix = if suffix == 0 {
            String::new()
        } else {
            format!("_{suffix}")
        };
        let filename = format!("{filename_stem}{collision_suffix}.{extension}");
        let path = backup_dir.join(&filename);

        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => {
                drop(file);
                return Ok((filename, path));
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                suffix = suffix
                    .checked_add(1)
                    .ok_or_else(|| "备份文件名序号超出支持范围".to_string())?;
            }
            Err(error) => return Err(format!("创建备份文件占位符失败: {error}")),
        }
    }
}

#[cfg(windows)]
pub(crate) fn reserve_staged_backup_file_windows(
    target: &Path,
    purpose: &str,
) -> Result<PathBuf, String> {
    loop {
        let candidate = unique_sibling_path(target, purpose)
            .map_err(|error| format!("创建备份暂存路径失败: {error}"))?;
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => {
                drop(file);
                return Ok(candidate);
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "创建备份暂存文件失败 {}: {error}",
                    candidate.display()
                ));
            }
        }
    }
}

#[cfg(windows)]
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum StagedFilePublishError {
    DestinationExists,
    Failed(String),
}

#[cfg(windows)]
pub(crate) fn publish_staged_file_windows(
    staged: &Path,
    destination: &Path,
) -> Result<(), StagedFilePublishError> {
    use windows::Win32::Foundation::{ERROR_ALREADY_EXISTS, ERROR_FILE_EXISTS};
    use windows::Win32::Storage::FileSystem::MoveFileW;
    use windows::core::{HRESULT, PCWSTR};

    let staged_path = windows_path_as_wide(staged).map_err(StagedFilePublishError::Failed)?;
    let destination_path =
        windows_path_as_wide(destination).map_err(StagedFilePublishError::Failed)?;
    // Windows moves the completed sibling file on the same volume and refuses
    // to replace a destination created by another process.
    unsafe {
        MoveFileW(
            PCWSTR::from_raw(staged_path.as_ptr()),
            PCWSTR::from_raw(destination_path.as_ptr()),
        )
    }
    .map_err(|error| {
        if error.code() == HRESULT::from_win32(ERROR_ALREADY_EXISTS.0)
            || error.code() == HRESULT::from_win32(ERROR_FILE_EXISTS.0)
        {
            StagedFilePublishError::DestinationExists
        } else {
            StagedFilePublishError::Failed(error.to_string())
        }
    })
}

#[cfg(windows)]
pub(crate) fn publish_staged_backup_file_windows(
    staged: &Path,
    backup_dir: &Path,
    filename_stem: &str,
    extension: &str,
) -> Result<(String, PathBuf), String> {
    let mut suffix = 0_u64;

    loop {
        let collision_suffix = if suffix == 0 {
            String::new()
        } else {
            format!("_{suffix}")
        };
        let filename = format!("{filename_stem}{collision_suffix}.{extension}");
        let destination = backup_dir.join(&filename);
        match publish_staged_file_windows(staged, &destination) {
            Ok(()) => return Ok((filename, destination)),
            Err(StagedFilePublishError::DestinationExists) => {
                suffix = suffix
                    .checked_add(1)
                    .ok_or_else(|| "备份文件名序号超出支持范围".to_string())?;
            }
            Err(StagedFilePublishError::Failed(error)) => return Err(error),
        }
    }
}

#[cfg(windows)]
fn windows_path_as_wide(path: &Path) -> Result<Vec<u16>, String> {
    use std::os::windows::ffi::OsStrExt;

    let mut wide = path.as_os_str().encode_wide().collect::<Vec<_>>();
    if wide.contains(&0) {
        return Err("备份路径包含无效的空字符".to_string());
    }
    wide.push(0);
    Ok(wide)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BackupResult {
    pub success: bool,
    pub path: Option<String>,
    pub message: String,
}

/// Write a consistent SQLite snapshot to an unused destination path.
/// The path is bound as a SQLite expression so quoting in Windows paths does
/// not become SQL text; callers own staging and publication around this file.
pub async fn write_sqlite_snapshot(
    db: &DatabaseConnection,
    destination: &Path,
) -> Result<(), String> {
    let path = destination
        .to_str()
        .ok_or_else(|| format!("数据库快照路径包含无效字符: {}", destination.display()))?
        .replace('\\', "/");
    db.execute(Statement::from_sql_and_values(
        DatabaseBackend::Sqlite,
        "VACUUM INTO ?",
        [path.into()],
    ))
    .await
    .map_err(|error| format!("创建 SQLite 快照失败: {error}"))?;
    Ok(())
}

/// One item in a multi-path import. `staged: None` means that the target
/// should be removed as part of the same recoverable publication.
#[derive(Debug, Clone)]
pub struct PathReplacement {
    pub target: PathBuf,
    pub staged: Option<PathBuf>,
    pub existing_path: ExistingPathPolicy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExistingPathPolicy {
    Replace,
    CreateOnly,
}

#[derive(Debug, Default)]
pub struct PathReplacementResult {
    pub cleanup_warnings: Vec<PathCleanupWarning>,
}

#[derive(Debug)]
pub struct PathCleanupWarning {
    pub preserved_path: PathBuf,
    pub error: String,
}

/// Publish a prepared set of files/directories, restoring every original path
/// if any rename fails. Staging paths must be siblings of their targets so
/// each publication is a same-volume rename.
pub fn publish_path_replacements(
    replacements: &[PathReplacement],
) -> Result<PathReplacementResult, String> {
    publish_replacements_with(replacements, |source, target| fs::rename(source, target))
}

pub fn stage_file_copy(source: &Path, target: &Path, purpose: &str) -> Result<PathBuf, String> {
    let parent = target
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| format!("目标文件没有父目录: {}", target.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("创建目标父目录失败 {}: {error}", parent.display()))?;
    let staged = unique_sibling_path(target, purpose)?;
    if let Err(error) = fs::copy(source, &staged) {
        let operation_error = format!(
            "准备导入文件失败 {} -> {}: {error}",
            source.display(),
            staged.display()
        );
        return match remove_path(&staged) {
            Ok(()) => Err(operation_error),
            Err(cleanup_error) => {
                let cleanup_message =
                    format!("清理导入暂存文件失败 {}: {cleanup_error}", staged.display());
                log::warn!("{cleanup_message}");
                Err(format!("{operation_error}；{cleanup_message}"))
            }
        };
    }
    Ok(staged)
}

pub fn stage_directory(target: &Path, purpose: &str) -> Result<PathBuf, String> {
    let parent = target
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| format!("目标目录没有父目录: {}", target.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("创建目标父目录失败 {}: {error}", parent.display()))?;
    let staged = unique_sibling_path(target, purpose)?;
    fs::create_dir(&staged)
        .map_err(|error| format!("创建导入暂存目录失败 {}: {error}", staged.display()))?;
    Ok(staged)
}

/// Check the SQLite file before an import closes the application's live pool.
pub async fn validate_import_database(path: &Path) -> Result<(), String> {
    let url = url::Url::from_file_path(path)
        .map_err(|_| format!("数据库路径无效: {}", path.display()))?;
    let mut options = ConnectOptions::new(format!("sqlite:{}?mode=ro", url.path()));
    options.max_connections(1);
    options.min_connections(1);
    options.connect_timeout(std::time::Duration::from_secs(8));
    options.sqlx_logging(false);
    let connection = Database::connect(options)
        .await
        .map_err(|error| format!("导入文件不是可读取的 SQLite 数据库: {error}"))?;

    let result = async {
        let check = connection
            .query_one(Statement::from_string(
                DatabaseBackend::Sqlite,
                "PRAGMA quick_check".to_string(),
            ))
            .await
            .map_err(|error| format!("检查导入数据库完整性失败: {error}"))?
            .ok_or_else(|| "导入数据库完整性检查没有结果".to_string())?
            .try_get::<String>("", "quick_check")
            .map_err(|error| format!("读取导入数据库完整性结果失败: {error}"))?;
        if check != "ok" {
            return Err(format!("导入数据库完整性检查失败: {check}"));
        }

        let user_table = connection
            .query_one(Statement::from_string(
                DatabaseBackend::Sqlite,
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user'".to_string(),
            ))
            .await
            .map_err(|error| format!("检查导入数据库结构失败: {error}"))?;
        if user_table.is_none() {
            return Err("导入数据库缺少 Skerry 用户设置表".to_string());
        }
        Ok(())
    }
    .await;

    let close_result = connection
        .close()
        .await
        .map_err(|error| format!("关闭导入数据库检查连接失败: {error}"));
    result.and(close_result)
}

struct PreparedPathReplacement {
    target: PathBuf,
    staged: Option<PathBuf>,
    existing_path: ExistingPathPolicy,
    previous: Option<PathBuf>,
    installed: bool,
}

fn publish_replacements_with<F>(
    replacements: &[PathReplacement],
    mut rename: F,
) -> Result<PathReplacementResult, String>
where
    F: FnMut(&Path, &Path) -> io::Result<()>,
{
    let mut prepared = prepare_path_replacements(replacements)?;

    let preserve_result = preserve_replaced_paths(&mut prepared, &mut rename);
    if let Err(failure) = preserve_result {
        return rollback_path_replacements(&mut prepared, &mut rename, failure);
    }

    let publish_result = install_staged_paths(&mut prepared, &mut rename);
    if let Err(failure) = publish_result {
        return rollback_path_replacements(&mut prepared, &mut rename, failure);
    }

    let mut result = PathReplacementResult::default();
    for item in prepared {
        if let Some(previous) = item.previous
            && let Err(error) = remove_path(&previous)
        {
            log::warn!(
                "路径替换成功，但清理旧路径失败 target={} preserved={} error={error}",
                item.target.display(),
                previous.display()
            );
            result.cleanup_warnings.push(PathCleanupWarning {
                preserved_path: previous,
                error: error.to_string(),
            });
        }
    }
    Ok(result)
}

fn prepare_path_replacements(
    replacements: &[PathReplacement],
) -> Result<Vec<PreparedPathReplacement>, String> {
    let mut targets = HashSet::with_capacity(replacements.len());
    let mut prepared = Vec::with_capacity(replacements.len());
    for replacement in replacements {
        let parent = replacement
            .target
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .ok_or_else(|| format!("替换目标没有父目录: {}", replacement.target.display()))?;
        let canonical_parent = fs::canonicalize(parent)
            .map_err(|error| format!("读取替换目标父目录失败 {}: {error}", parent.display()))?;
        let file_name = replacement
            .target
            .file_name()
            .ok_or_else(|| format!("替换目标没有文件名: {}", replacement.target.display()))?;
        let target = canonical_parent.join(file_name);
        if !targets.insert(target.clone()) {
            return Err(format!("替换目标重复: {}", target.display()));
        }

        if let Some(staged) = replacement.staged.as_deref() {
            let staged_parent = staged
                .parent()
                .filter(|path| !path.as_os_str().is_empty())
                .ok_or_else(|| format!("暂存路径没有父目录: {}", staged.display()))?;
            if fs::canonicalize(staged_parent).map_err(|error| {
                format!(
                    "读取暂存路径父目录失败 {}: {error}",
                    staged_parent.display()
                )
            })? != canonical_parent
            {
                return Err(format!(
                    "暂存路径必须与替换目标位于同一目录: {}",
                    staged.display()
                ));
            }
            fs::symlink_metadata(staged)
                .map_err(|error| format!("导入暂存内容不存在 {}: {error}", staged.display()))?;
        }

        prepared.push(PreparedPathReplacement {
            target,
            staged: replacement.staged.clone(),
            existing_path: replacement.existing_path,
            previous: None,
            installed: false,
        });
    }

    // Reject nested targets: replacing a parent would invalidate the staged
    // sibling paths or rollback paths belonging to a child replacement.
    for (index, left) in prepared.iter().enumerate() {
        if prepared.iter().skip(index + 1).any(|right| {
            left.target.starts_with(&right.target) || right.target.starts_with(&left.target)
        }) {
            return Err("批量替换目标不能互相嵌套".to_string());
        }
    }

    Ok(prepared)
}

fn preserve_replaced_paths<F>(
    prepared: &mut [PreparedPathReplacement],
    rename: &mut F,
) -> Result<(), String>
where
    F: FnMut(&Path, &Path) -> io::Result<()>,
{
    for index in 0..prepared.len() {
        match fs::symlink_metadata(&prepared[index].target) {
            Ok(_) => {
                if prepared[index].existing_path == ExistingPathPolicy::CreateOnly {
                    return Err(format!(
                        "替换目标已存在，拒绝覆盖: {}",
                        prepared[index].target.display()
                    ));
                }
                let rollback = unique_sibling_path(&prepared[index].target, "import-rollback")?;
                rename(&prepared[index].target, &rollback).map_err(|error| {
                    format!(
                        "暂存原路径失败 {}: {error}",
                        prepared[index].target.display()
                    )
                })?;
                prepared[index].previous = Some(rollback);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "检查原路径失败 {}: {error}",
                    prepared[index].target.display()
                ));
            }
        }
    }
    Ok(())
}

fn install_staged_paths<F>(
    prepared: &mut [PreparedPathReplacement],
    rename: &mut F,
) -> Result<(), String>
where
    F: FnMut(&Path, &Path) -> io::Result<()>,
{
    for item in prepared {
        if let Some(staged) = item.staged.as_deref() {
            rename(staged, &item.target)
                .map_err(|error| format!("发布导入内容失败 {}: {error}", item.target.display()))?;
            item.installed = true;
        }
    }
    Ok(())
}

fn rollback_path_replacements<F>(
    prepared: &mut [PreparedPathReplacement],
    rename: &mut F,
    failure: String,
) -> Result<PathReplacementResult, String>
where
    F: FnMut(&Path, &Path) -> io::Result<()>,
{
    let mut rollback_errors = Vec::new();
    for item in prepared.iter_mut().rev() {
        if item.installed {
            if let Err(error) = remove_path(&item.target) {
                rollback_errors.push(format!(
                    "删除未完成的新内容失败 {}: {error}",
                    item.target.display()
                ));
            }
        }
        if let Some(previous) = item.previous.as_deref()
            && let Err(error) = rename(previous, &item.target)
        {
            rollback_errors.push(format!(
                "恢复原路径失败 {}: {error}; 原内容保留在 {}",
                item.target.display(),
                previous.display()
            ));
        } else if item.previous.is_some() {
            item.previous = None;
        }
    }
    Err(if rollback_errors.is_empty() {
        format!("{failure}；原数据已恢复")
    } else {
        format!("{failure}；回滚未完全成功：{}", rollback_errors.join("；"))
    })
}

fn unique_sibling_path(target: &Path, purpose: &str) -> Result<PathBuf, String> {
    let parent = target
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let name = target
        .file_name()
        .ok_or_else(|| format!("路径没有文件名: {}", target.display()))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("读取系统时间失败: {error}"))?
        .as_nanos();
    for attempt in 0..100_u8 {
        let candidate = parent.join(format!(
            ".{}.skerry-{purpose}-{nonce}-{attempt}",
            name.to_string_lossy()
        ));
        match fs::symlink_metadata(&candidate) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(candidate),
            Ok(_) => continue,
            Err(error) => return Err(format!("检查暂存路径失败 {}: {error}", candidate.display())),
        }
    }
    Err(format!("无法分配唯一回滚路径: {}", target.display()))
}

fn remove_path(path: &Path) -> io::Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if metadata.file_type().is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

pub async fn resolve_backup_dir(db: &DatabaseConnection) -> Result<PathBuf, String> {
    let settings = db.get_settings().await?;

    if let Some(custom) = settings.db_backup_path_value() {
        let custom_path = PathBuf::from(custom);
        match fs::metadata(&custom_path) {
            Ok(metadata) if metadata.is_dir() => return Ok(custom_path),
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "检查自定义数据库备份目录失败 {}: {error}",
                    custom_path.display()
                ));
            }
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

    let backup_dir = skerry_path::get_default_db_backup_path()?;
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

    files.sort_by(|left, right| compare_auto_backup_names(&left.0, &right.0, prefix, extension));
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

fn compare_auto_backup_names(
    left: &str,
    right: &str,
    prefix: &str,
    extension: &str,
) -> std::cmp::Ordering {
    fn retention_key<'a>(
        filename: &'a str,
        prefix: &str,
        extension: &str,
    ) -> (&'a str, u64, &'a str) {
        let stem = filename
            .strip_prefix(prefix)
            .and_then(|name| name.strip_suffix(extension))
            .unwrap_or(filename);
        let Some(timestamp) = stem.get(..15) else {
            return (stem, 0, filename);
        };
        let timestamp_bytes = timestamp.as_bytes();
        let is_timestamp = timestamp_bytes.len() == 15
            && timestamp_bytes[..8]
                .iter()
                .all(|byte| byte.is_ascii_digit())
            && timestamp_bytes[8] == b'_'
            && timestamp_bytes[9..]
                .iter()
                .all(|byte| byte.is_ascii_digit());
        if !is_timestamp {
            return (stem, 0, filename);
        }

        let collision = match stem.get(15..) {
            Some("") => 0,
            Some(suffix) => match suffix
                .strip_prefix('_')
                .and_then(|value| value.parse::<u64>().ok())
            {
                Some(collision) => collision,
                None => return (stem, 0, filename),
            },
            None => return (stem, 0, filename),
        };
        (timestamp, collision, filename)
    }

    retention_key(left, prefix, extension).cmp(&retention_key(right, prefix, extension))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "skerry_backup_publish_{label}_{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn reserves_backup_names_without_overwriting_existing_files() {
        let root = test_root("filename-collision");
        fs::create_dir_all(&root).unwrap();
        let first_path = root.join("skerry_auto_20261019_120000.db");
        fs::write(&first_path, b"first backup").unwrap();

        let (second_name, second_path) =
            reserve_backup_file_path(&root, "skerry_auto_20261019_120000", "db").unwrap();

        assert_eq!(second_name, "skerry_auto_20261019_120000_1.db");
        assert_eq!(fs::read(&first_path).unwrap(), b"first backup");
        assert_eq!(fs::metadata(&second_path).unwrap().len(), 0);

        fs::write(&second_path, b"second backup").unwrap();
        cleanup_auto_backup_files(&root, "skerry_auto_", ".db", 1).unwrap();
        assert!(!first_path.exists());
        assert_eq!(fs::read(&second_path).unwrap(), b"second backup");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn automatic_backup_retention_orders_same_second_collision_suffix_numerically() {
        let root = test_root("numeric-collision-retention");
        fs::create_dir_all(&root).unwrap();
        let names = [
            "skerry_auto_20261019_120000.db",
            "skerry_auto_20261019_120000_2.db",
            "skerry_auto_20261019_120000_10.db",
        ];
        for name in names {
            fs::write(root.join(name), name.as_bytes()).unwrap();
        }

        let deleted = cleanup_auto_backup_files(&root, "skerry_auto_", ".db", 1).unwrap();

        assert_eq!(
            deleted,
            [
                "skerry_auto_20261019_120000.db".to_string(),
                "skerry_auto_20261019_120000_2.db".to_string(),
            ]
        );
        assert!(root.join("skerry_auto_20261019_120000_10.db").is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_staged_copy_keeps_the_copy_error_and_leaves_no_partial_file() {
        let root = test_root("failed-stage-copy");
        fs::create_dir_all(&root).unwrap();
        let missing_source = root.join("missing.db");
        let target = root.join("database.db");

        let error = stage_file_copy(&missing_source, &target, "database-import")
            .expect_err("copy from a missing source must fail");

        assert!(error.contains("准备导入文件失败"));
        assert!(error.contains(&missing_source.display().to_string()));
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn publishes_imported_paths_and_removes_replaced_paths() {
        let root = test_root("success");
        fs::create_dir_all(&root).unwrap();
        let database = root.join("skerry.db");
        let staged_database = root.join("staged.db");
        let covers = root.join("covers");
        let staged_covers = root.join("staged-covers");
        let old_next_up = root.join("next-up-covers");
        fs::write(&database, b"old db").unwrap();
        fs::write(&staged_database, b"new db").unwrap();
        fs::create_dir(&covers).unwrap();
        fs::write(covers.join("old.png"), b"old cover").unwrap();
        fs::create_dir(&staged_covers).unwrap();
        fs::write(staged_covers.join("new.png"), b"new cover").unwrap();
        fs::create_dir(&old_next_up).unwrap();
        fs::write(old_next_up.join("old.png"), b"old next-up cover").unwrap();

        publish_path_replacements(&[
            PathReplacement {
                target: database.clone(),
                staged: Some(staged_database),
                existing_path: ExistingPathPolicy::Replace,
            },
            PathReplacement {
                target: covers.clone(),
                staged: Some(staged_covers),
                existing_path: ExistingPathPolicy::Replace,
            },
            PathReplacement {
                target: old_next_up.clone(),
                staged: None,
                existing_path: ExistingPathPolicy::Replace,
            },
        ])
        .unwrap();

        assert_eq!(fs::read(database).unwrap(), b"new db");
        assert_eq!(fs::read(covers.join("new.png")).unwrap(), b"new cover");
        assert!(!covers.join("old.png").exists());
        assert!(!old_next_up.exists());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn create_only_publication_preserves_an_existing_target_and_staged_content() {
        let root = test_root("create-only");
        fs::create_dir_all(&root).unwrap();
        let target = root.join("save");
        let staged = root.join("staged-save");
        fs::write(&target, b"existing").unwrap();
        fs::write(&staged, b"prepared").unwrap();

        let error = publish_path_replacements(&[PathReplacement {
            target: target.clone(),
            staged: Some(staged.clone()),
            existing_path: ExistingPathPolicy::CreateOnly,
        }])
        .expect_err("create-only publication must refuse to replace a raced target");

        assert!(error.contains("拒绝覆盖"));
        assert_eq!(fs::read(&target).unwrap(), b"existing");
        assert_eq!(fs::read(&staged).unwrap(), b"prepared");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn restores_every_original_path_when_publication_fails() {
        let root = test_root("rollback");
        fs::create_dir_all(&root).unwrap();
        let first = root.join("first.db");
        let staged_first = root.join("staged-first.db");
        let second = root.join("second");
        let staged_second = root.join("staged-second");
        fs::write(&first, b"old first").unwrap();
        fs::write(&staged_first, b"new first").unwrap();
        fs::create_dir(&second).unwrap();
        fs::write(second.join("old"), b"old second").unwrap();
        fs::create_dir(&staged_second).unwrap();
        fs::write(staged_second.join("new"), b"new second").unwrap();

        let result = publish_replacements_with(
            &[
                PathReplacement {
                    target: first.clone(),
                    staged: Some(staged_first),
                    existing_path: ExistingPathPolicy::Replace,
                },
                PathReplacement {
                    target: second.clone(),
                    staged: Some(staged_second.clone()),
                    existing_path: ExistingPathPolicy::Replace,
                },
            ],
            |source, target| {
                if source == staged_second {
                    Err(io::Error::other("simulated publish failure"))
                } else {
                    fs::rename(source, target)
                }
            },
        );

        let error = result.unwrap_err();
        assert!(error.contains("原数据已恢复"), "{error}");
        assert_eq!(fs::read(first).unwrap(), b"old first");
        assert_eq!(fs::read(second.join("old")).unwrap(), b"old second");
        assert!(staged_second.join("new").exists());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 3);
        fs::remove_dir_all(root).unwrap();
    }
}
