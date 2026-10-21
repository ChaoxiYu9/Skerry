use crate::backup::common::BackupResult;
#[cfg(not(windows))]
use crate::backup::common::reserve_backup_file_path;
use crate::backup::common::write_sqlite_snapshot;
#[cfg(feature = "tauri-app")]
use crate::backup::common::{
    BackupOptions, ExistingPathPolicy, PathReplacement, cleanup_auto_backup_files,
    publish_path_replacements, resolve_backup_dir, stage_directory, stage_file_copy,
    validate_import_database,
};
#[cfg(windows)]
use crate::backup::common::{
    publish_staged_backup_file_windows, reserve_staged_backup_file_windows,
};
use crate::backup::covers::backup_custom_covers_archive;
use crate::database::db::close_connection;
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

use skerry_path::get_db_path;

/// 数据库导入结果
#[derive(Debug, Serialize, Deserialize)]
pub struct ImportResult {
    pub success: bool,
    pub message: String,
    pub backup_path: Option<String>,
    pub restart_required: bool,
}

// ==================== 数据库备份和导入 ====================

/// 使用 VACUUM INTO 进行数据库热备份
///
/// 此方法使用 SQLite 的 VACUUM INTO 语句，可以在数据库正在使用时安全地创建备份。
/// VACUUM INTO 会创建一个优化后的数据库副本，同时保持原数据库的完整性。
///
/// 备份路径从数据库的 user 表中读取配置：
/// - 优先使用 user.db_backup_path（如果设置且非空）
/// - 否则使用默认路径
///
/// # Returns
///
/// 备份结果，包含备份文件的路径
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn backup_database(
    db: tauri::State<'_, DatabaseConnection>,
    options: Option<BackupOptions>,
) -> Result<BackupResult, String> {
    let options = options.unwrap_or_default();
    if options.auto {
        return backup_database_file_cold(&db, options.max_auto_backups).await;
    }

    let result = backup_database_file(&db).await?;

    Ok(result)
}

pub async fn backup_database_file(db: &DatabaseConnection) -> Result<BackupResult, String> {
    let backup_dir = resolve_backup_dir(db).await?;
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
    backup_database_file_at(db, &backup_dir, &timestamp).await
}

#[cfg(windows)]
async fn backup_database_file_at(
    db: &DatabaseConnection,
    backup_dir: &Path,
    timestamp: &str,
) -> Result<BackupResult, String> {
    let filename_stem = format!("skerry_{timestamp}");
    let staged_target = backup_dir.join(format!("{filename_stem}.db"));
    let staged_path = reserve_staged_backup_file_windows(&staged_target, "database-backup")?;
    if let Err(error) = write_sqlite_snapshot(db, &staged_path).await {
        return Err(cleanup_failed_database_backup(
            &staged_path,
            format!("VACUUM INTO 备份失败: {error}"),
        ));
    }

    let (_, target_path) =
        match publish_staged_backup_file_windows(&staged_path, backup_dir, &filename_stem, "db") {
            Ok(published) => published,
            Err(error) => {
                return Err(cleanup_failed_database_backup(
                    &staged_path,
                    format!("提交数据库备份失败: {error}"),
                ));
            }
        };
    let target_path_str = target_path
        .to_str()
        .ok_or_else(|| "数据库备份路径包含无效字符".to_string())?
        .replace('\\', "/");

    log::info!("数据库热备份成功: {}", target_path_str);

    Ok(BackupResult {
        success: true,
        path: Some(target_path_str),
        message: "数据库备份成功".to_string(),
    })
}

#[cfg(not(windows))]
async fn backup_database_file_at(
    db: &DatabaseConnection,
    backup_dir: &Path,
    timestamp: &str,
) -> Result<BackupResult, String> {
    let filename_stem = format!("skerry_{timestamp}");
    // VACUUM INTO accepts the empty file as a target, so it can write into this exclusive reservation.
    let (_, target_path) = reserve_backup_file_path(backup_dir, &filename_stem, "db")?;
    if let Err(error) = write_sqlite_snapshot(db, &target_path).await {
        return Err(cleanup_failed_database_backup(
            &target_path,
            format!("VACUUM INTO 备份失败: {error}"),
        ));
    }

    let target_path_str = target_path
        .to_str()
        .ok_or_else(|| "数据库备份路径包含无效字符".to_string())?
        .replace('\\', "/");

    log::info!("数据库热备份成功: {}", target_path_str);

    Ok(BackupResult {
        success: true,
        path: Some(target_path_str),
        message: "数据库备份成功".to_string(),
    })
}

fn cleanup_failed_database_backup(target_path: &Path, failure: String) -> String {
    match fs::remove_file(target_path) {
        Ok(()) => failure,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => failure,
        Err(cleanup_error) => format!(
            "{failure}；清理未完成备份文件失败 {}: {cleanup_error}",
            target_path.display()
        ),
    }
}

#[cfg(feature = "tauri-app")]
async fn backup_database_file_cold(
    db: &DatabaseConnection,
    max_auto_backups: Option<usize>,
) -> Result<BackupResult, String> {
    // 自动冷备份用于退出流程，会关闭连接；关闭前必须先读取配置。
    let backup_dir = resolve_backup_dir(db).await?;
    let db_path = get_db_path()?;
    close_connection(db.clone())
        .await
        .map_err(|e| format!("关闭数据库连接失败: {}", e))?;
    log::info!("数据库连接已关闭，准备执行文件操作");

    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
    let result = copy_database_file_cold(&db_path, &backup_dir, &timestamp)?;

    if let Some(max_auto_backups) = max_auto_backups
        && let Err(e) =
            cleanup_auto_backup_files(&backup_dir, "skerry_auto_", ".db", max_auto_backups)
    {
        log::warn!("清理旧数据库自动备份失败: {}", e);
    }

    Ok(result)
}

#[cfg(windows)]
fn copy_database_file_cold(
    db_path: &Path,
    backup_dir: &Path,
    timestamp: &str,
) -> Result<BackupResult, String> {
    if !db_path.exists() {
        return Err(format!("当前数据库文件不存在: {}", db_path.display()));
    }

    let filename_stem = format!("skerry_auto_{timestamp}");
    let staged_target = backup_dir.join(format!("{filename_stem}.db"));
    let staged_path = reserve_staged_backup_file_windows(&staged_target, "database-cold-backup")?;
    let copied_bytes = match fs::copy(db_path, &staged_path) {
        Ok(bytes) => bytes,
        Err(error) => {
            return Err(cleanup_failed_database_backup(
                &staged_path,
                format!("数据库冷备份失败: {error}"),
            ));
        }
    };
    let staged_bytes = match fs::metadata(&staged_path) {
        Ok(metadata) => metadata.len(),
        Err(error) => {
            return Err(cleanup_failed_database_backup(
                &staged_path,
                format!("读取数据库冷备份暂存文件失败: {error}"),
            ));
        }
    };
    if copied_bytes != staged_bytes {
        return Err(cleanup_failed_database_backup(
            &staged_path,
            format!(
                "数据库冷备份复制长度不一致: 复制 {copied_bytes} bytes，暂存文件 {staged_bytes} bytes"
            ),
        ));
    }

    let (_, backup_file_path) =
        match publish_staged_backup_file_windows(&staged_path, backup_dir, &filename_stem, "db") {
            Ok(published) => published,
            Err(error) => {
                return Err(cleanup_failed_database_backup(
                    &staged_path,
                    format!("提交数据库冷备份失败: {error}"),
                ));
            }
        };

    let path_str = backup_file_path.to_string_lossy().to_string();
    log::info!("数据库冷备份成功: {}", path_str);

    Ok(BackupResult {
        success: true,
        path: Some(path_str),
        message: "数据库备份成功".to_string(),
    })
}

#[cfg(not(windows))]
fn copy_database_file_cold(
    db_path: &Path,
    backup_dir: &Path,
    timestamp: &str,
) -> Result<BackupResult, String> {
    if !db_path.exists() {
        return Err(format!("当前数据库文件不存在: {}", db_path.display()));
    }

    let filename_stem = format!("skerry_auto_{timestamp}");
    let (_, backup_file_path) = reserve_backup_file_path(backup_dir, &filename_stem, "db")?;

    if let Err(error) = fs::copy(db_path, &backup_file_path) {
        let message = format!("数据库冷备份失败: {error}");
        return match fs::remove_file(&backup_file_path) {
            Ok(()) => Err(message),
            Err(cleanup_error) if cleanup_error.kind() == std::io::ErrorKind::NotFound => {
                Err(message)
            }
            Err(cleanup_error) => Err(format!(
                "{message}；清理未完成备份文件失败 {}: {cleanup_error}",
                backup_file_path.display()
            )),
        };
    }

    let path_str = backup_file_path.to_string_lossy().to_string();
    log::info!("数据库冷备份成功: {}", path_str);

    Ok(BackupResult {
        success: true,
        path: Some(path_str),
        message: "数据库备份成功".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::{ConnectOptions, ConnectionTrait, Database, DatabaseBackend, Statement};
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "skerry_database_backup_manual_{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[cfg(feature = "tauri-app")]
    #[test]
    fn failed_import_stage_cleanup_is_returned_with_the_original_error() {
        let root = test_root();
        let wrong_type_stage = root.join("database-stage");
        fs::create_dir_all(&wrong_type_stage).unwrap();

        let message =
            with_import_stage_cleanup("导入校验失败".to_string(), Some(&wrong_type_stage), None);

        assert!(message.contains("导入校验失败"));
        assert!(message.contains("暂存清理失败"));
        assert!(message.contains(&wrong_type_stage.display().to_string()));
        assert!(wrong_type_stage.is_dir());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn manual_backups_with_the_same_timestamp_keep_both_database_snapshots() {
        let root = test_root();
        let backup_dir = root.join("backup's");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&backup_dir).unwrap();

        let source_url = url::Url::from_file_path(root.join("source.db")).unwrap();
        let mut options = ConnectOptions::new(format!("sqlite:{}?mode=rwc", source_url.path()));
        options.max_connections(1);
        let db = Database::connect(options).await.unwrap();
        db.execute_unprepared("CREATE TABLE backup_state (value TEXT NOT NULL)")
            .await
            .unwrap();
        db.execute_unprepared("INSERT INTO backup_state VALUES ('first')")
            .await
            .unwrap();

        let timestamp = "20261019_120000";
        let first = backup_database_file_at(&db, &backup_dir, timestamp)
            .await
            .unwrap();
        let first_path = PathBuf::from(first.path.unwrap());
        let first_bytes = fs::read(&first_path).unwrap();

        db.execute_unprepared("INSERT INTO backup_state VALUES ('second')")
            .await
            .unwrap();
        let second = backup_database_file_at(&db, &backup_dir, timestamp)
            .await
            .unwrap();
        let second_path = PathBuf::from(second.path.unwrap());

        assert_eq!(first_path.file_name().unwrap(), "skerry_20261019_120000.db");
        assert_eq!(
            second_path.file_name().unwrap(),
            "skerry_20261019_120000_1.db"
        );
        assert_eq!(fs::read(&first_path).unwrap(), first_bytes);

        let first_url = url::Url::from_file_path(&first_path).unwrap();
        let first_snapshot = Database::connect(ConnectOptions::new(format!(
            "sqlite:{}?mode=ro",
            first_url.path()
        )))
        .await
        .unwrap();
        let first_value = first_snapshot
            .query_one(Statement::from_string(
                DatabaseBackend::Sqlite,
                "SELECT value FROM backup_state".to_string(),
            ))
            .await
            .unwrap()
            .unwrap()
            .try_get_by::<String, _>("value")
            .unwrap();
        first_snapshot.close().await.unwrap();

        let second_url = url::Url::from_file_path(&second_path).unwrap();
        let second_snapshot = Database::connect(ConnectOptions::new(format!(
            "sqlite:{}?mode=ro",
            second_url.path()
        )))
        .await
        .unwrap();
        let second_values = second_snapshot
            .query_all(Statement::from_string(
                DatabaseBackend::Sqlite,
                "SELECT value FROM backup_state ORDER BY rowid".to_string(),
            ))
            .await
            .unwrap()
            .into_iter()
            .map(|row| row.try_get_by::<String, _>("value").unwrap())
            .collect::<Vec<_>>();
        second_snapshot.close().await.unwrap();

        assert_eq!(first_value, "first");
        assert_eq!(second_values, ["first".to_string(), "second".to_string()]);

        db.clone().close().await.unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn failed_manual_vacuum_removes_the_reserved_destination() {
        let root = test_root();
        let backup_dir = root.join("backups");
        fs::create_dir_all(&backup_dir).unwrap();
        let db = Database::connect("sqlite::memory:").await.unwrap();
        db.clone().close().await.unwrap();

        let result = backup_database_file_at(&db, &backup_dir, "20261019_120000").await;

        assert!(result.is_err());
        assert_eq!(fs::read_dir(&backup_dir).unwrap().count(), 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn same_timestamp_automatic_database_backups_keep_both_files() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("skerry_database_backup_collision_{nonce}"));
        let backup_dir = root.join("backups");
        fs::create_dir_all(&backup_dir).unwrap();
        let database = root.join("source.db");
        let timestamp = "20261019_120000";
        fs::write(&database, b"first database state").unwrap();

        let first = copy_database_file_cold(&database, &backup_dir, timestamp).unwrap();
        let first_path = Path::new(first.path.as_deref().unwrap()).to_path_buf();
        let first_contents = fs::read(&first_path).unwrap();

        fs::write(&database, b"second database state").unwrap();
        let second = copy_database_file_cold(&database, &backup_dir, timestamp).unwrap();
        let second_path = Path::new(second.path.as_deref().unwrap());

        assert_eq!(
            first_path.file_name().unwrap(),
            "skerry_auto_20261019_120000.db"
        );
        assert_eq!(
            second_path.file_name().unwrap(),
            "skerry_auto_20261019_120000_1.db"
        );
        assert_eq!(fs::read(&first_path).unwrap(), first_contents);
        assert_eq!(fs::read(second_path).unwrap(), b"second database state");
        assert_eq!(fs::read_dir(&backup_dir).unwrap().count(), 2);
        fs::remove_dir_all(root).unwrap();
    }
}

/// 导入数据库文件（覆盖现有数据库）
///
/// # Arguments
///
/// * `source_path` - 要导入的数据库文件路径
///
/// # Returns
///
/// 导入结果，包含备份路径（如果备份成功）
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn import_database(
    source_path: String,
    db: tauri::State<'_, DatabaseConnection>,
) -> Result<ImportResult, String> {
    import_database_native(source_path, db.inner()).await
}

pub async fn import_database_native(
    source_path: String,
    db: &DatabaseConnection,
) -> Result<ImportResult, String> {
    let src_path = Path::new(&source_path);

    // 检查源文件是否存在
    if !src_path.exists() {
        return Err(format!("源数据库文件不存在: {}", source_path));
    }

    // 检查文件扩展名
    if src_path.extension().and_then(|e| e.to_str()) != Some("db") {
        return Err("无效的数据库文件，请选择 .db 文件".to_string());
    }

    // 获取当前数据库路径（自动判断便携模式）
    let target_db_path = get_db_path()?;
    if let (Ok(source), Ok(target)) = (
        fs::canonicalize(src_path),
        fs::canonicalize(&target_db_path),
    ) && source == target
    {
        return Err("不能导入当前正在使用的数据库文件".to_string());
    }

    // Copy and validate the replacement before closing the live database.
    let staged_db = stage_file_copy(src_path, &target_db_path, "database-import")?;
    if let Err(error) = validate_import_database(&staged_db).await {
        return Err(with_import_stage_cleanup(error, Some(&staged_db), None));
    }
    let covers_path = skerry_path::get_base_data_dir()?.join("covers");
    let staged_covers = match stage_directory(&covers_path, "covers-import") {
        Ok(path) => path,
        Err(error) => {
            return Err(with_import_stage_cleanup(error, Some(&staged_db), None));
        }
    };

    // Keep the user-facing recovery backup and custom-cover backup before the
    // live pool is closed. The filesystem rollback copy remains until commit.
    let result_backup_path = match backup_database_file(db).await {
        Ok(result) => result.path,
        Err(error) => {
            log::warn!("创建导入前数据库备份失败，将依赖原文件回滚保护: {error}");
            None
        }
    };
    if let Err(error) = backup_custom_covers_archive(db, false).await {
        return Err(with_import_stage_cleanup(
            error,
            Some(&staged_db),
            Some(&staged_covers),
        ));
    }

    if let Err(error) = close_connection(db.clone()).await {
        let error =
            with_import_stage_cleanup(error.to_string(), Some(&staged_db), Some(&staged_covers));
        return Ok(ImportResult {
            success: false,
            message: format!("关闭数据库连接失败: {error}；应用将自动重启以恢复连接"),
            backup_path: result_backup_path,
            restart_required: true,
        });
    }
    log::info!("数据库连接已关闭，开始发布已验证的导入文件");

    let replacements = [
        PathReplacement {
            target: target_db_path.clone(),
            staged: Some(staged_db.clone()),
            existing_path: ExistingPathPolicy::Replace,
        },
        PathReplacement {
            target: covers_path,
            staged: Some(staged_covers.clone()),
            existing_path: ExistingPathPolicy::Replace,
        },
    ];
    if let Err(error) = publish_path_replacements(&replacements) {
        let error = with_import_stage_cleanup(error, Some(&staged_db), Some(&staged_covers));
        return Ok(ImportResult {
            success: false,
            message: format!("数据库导入失败: {error}；应用将自动重启"),
            backup_path: result_backup_path,
            restart_required: true,
        });
    }

    log::info!("数据库文件已替换: {} -> {:?}", source_path, target_db_path);
    Ok(ImportResult {
        success: true,
        message: "数据库导入成功，已备份自定义封面并清空封面缓存，应用将自动重启".to_string(),
        backup_path: result_backup_path,
        restart_required: true,
    })
}

#[cfg(feature = "tauri-app")]
fn with_import_stage_cleanup(
    operation_error: String,
    staged_db: Option<&Path>,
    staged_covers: Option<&Path>,
) -> String {
    let mut cleanup_errors = Vec::new();
    if let Some(path) = staged_db {
        if let Err(error) = remove_import_stage(path, ImportStageKind::File) {
            cleanup_errors.push(error);
        }
    }
    if let Some(path) = staged_covers {
        if let Err(error) = remove_import_stage(path, ImportStageKind::Directory) {
            cleanup_errors.push(error);
        }
    }

    if cleanup_errors.is_empty() {
        return operation_error;
    }

    let cleanup_error = cleanup_errors.join("; ");
    log::warn!("数据库导入暂存清理失败: {cleanup_error}");
    format!("{operation_error}；暂存清理失败: {cleanup_error}")
}

#[cfg(feature = "tauri-app")]
#[derive(Clone, Copy)]
enum ImportStageKind {
    File,
    Directory,
}

#[cfg(feature = "tauri-app")]
fn remove_import_stage(path: &Path, kind: ImportStageKind) -> Result<(), String> {
    let result = match kind {
        ImportStageKind::File => fs::remove_file(path),
        ImportStageKind::Directory => fs::remove_dir_all(path),
    };
    match result {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "{} {}: {error}",
            match kind {
                ImportStageKind::File => "文件",
                ImportStageKind::Directory => "目录",
            },
            path.display()
        )),
    }
}
