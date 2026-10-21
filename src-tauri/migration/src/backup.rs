use std::fs;
use std::fs::OpenOptions;
use std::io::ErrorKind;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use chrono::Local;
use sea_orm_migration::sea_orm::{ConnectionTrait, DatabaseBackend, DbErr};
use sea_orm_migration::SchemaManagerConnection;
use sqlx::Row;

static TEMPORARY_BACKUP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// A migration snapshot. Test-only snapshots of in-memory databases are
/// removed when the migration finishes; snapshots of file-backed databases
/// remain available to the user.
pub struct BackupArtifact {
    path: PathBuf,
    temporary_directory: Option<PathBuf>,
}

impl BackupArtifact {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for BackupArtifact {
    fn drop(&mut self) {
        if let Some(directory) = self.temporary_directory.take() {
            if let Err(error) = fs::remove_dir_all(&directory) {
                log::warn!(
                    "[MIGRATION] Could not remove temporary in-memory database snapshot directory {}: {}",
                    directory.display(),
                    error
                );
            }
        }
    }
}

/// 使用 SQLite 一致性快照备份数据库。
///
/// 从正在迁移的 SQLite 连接创建一致性快照，并读取该连接中
/// `user.db_backup_path` 字段：
/// - 若存在且非空，则备份到该路径下
/// - 否则备份到活动数据库所在目录的 `backups/` 子目录
/// - 自定义目录备份失败时记录警告并回退默认目录；默认目录备份失败则终止迁移
pub async fn backup_sqlite(
    connection: &SchemaManagerConnection<'_>,
    version: &str,
) -> Result<BackupArtifact, DbErr> {
    let pool = sqlite_pool_for_migration(connection)?;
    let db_path = sqlite_main_database_path(pool).await?;
    let source_is_in_memory = db_path.is_none();

    verify_integrity(pool, "源数据库").await?;

    let custom_path: Option<String> = sqlx::query_scalar("SELECT db_backup_path FROM user LIMIT 1")
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();

    let temporary_default_dir = if db_path.is_none() {
        Some(create_temporary_backup_directory()?)
    } else {
        None
    };
    let default_dir = match db_path.as_deref() {
        Some(db_path) => {
            let database_directory = db_path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .unwrap_or_else(|| Path::new("."));
            database_directory.join("backups")
        }
        None => temporary_default_dir
            .as_deref()
            .map(Path::to_path_buf)
            .ok_or_else(|| {
                DbErr::Custom("In-memory database has no temporary backup directory".to_string())
            })?,
    };
    let custom_dir = custom_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(Path::new);

    match create_backup_with_fallback(pool, version, custom_dir, &default_dir, source_is_in_memory)
        .await
    {
        Ok(path) => {
            let uses_temporary_directory = temporary_default_dir
                .as_deref()
                .is_some_and(|directory| path.parent() == Some(directory));
            if !uses_temporary_directory {
                if let Some(directory) = temporary_default_dir.as_deref() {
                    if let Err(error) = fs::remove_dir_all(directory) {
                        if error.kind() != ErrorKind::NotFound {
                            log::warn!(
                                "[MIGRATION] Could not remove unused temporary backup directory {}: {}",
                                directory.display(),
                                error
                            );
                        }
                    }
                }
            }
            Ok(BackupArtifact {
                path,
                temporary_directory: uses_temporary_directory
                    .then_some(temporary_default_dir)
                    .flatten(),
            })
        }
        Err(error) => {
            if let Some(directory) = temporary_default_dir {
                if let Err(cleanup_error) = fs::remove_dir_all(&directory) {
                    if cleanup_error.kind() != ErrorKind::NotFound {
                        log::warn!(
                            "[MIGRATION] Could not remove temporary backup directory {} after failure: {}",
                            directory.display(),
                            cleanup_error
                        );
                    }
                }
            }
            Err(error)
        }
    }
}

pub(crate) fn sqlite_pool_for_migration<'connection>(
    connection: &'connection SchemaManagerConnection<'_>,
) -> Result<&'connection sqlx::SqlitePool, DbErr> {
    match connection {
        SchemaManagerConnection::Connection(database) => {
            if database.get_database_backend() != DatabaseBackend::Sqlite {
                return Err(DbErr::Custom(
                    "Database migration operation requires a SQLite connection".to_string(),
                ));
            }
            Ok(database.get_sqlite_connection_pool())
        }
        SchemaManagerConnection::Transaction(_) => Err(DbErr::Custom(
            "Database snapshot and legacy catch-up must run before the migration transaction"
                .to_string(),
        )),
    }
}

async fn sqlite_main_database_path(pool: &sqlx::SqlitePool) -> Result<Option<PathBuf>, DbErr> {
    let rows = sqlx::query("PRAGMA database_list")
        .fetch_all(pool)
        .await
        .map_err(|error| DbErr::Custom(format!("Failed to inspect SQLite databases: {error}")))?;

    for row in rows {
        let name: String = row.try_get(1).map_err(|error| {
            DbErr::Custom(format!("Failed to read SQLite database name: {error}"))
        })?;
        if name == "main" {
            let file: String = row.try_get(2).map_err(|error| {
                DbErr::Custom(format!("Failed to read SQLite database path: {error}"))
            })?;
            return Ok((!file.is_empty()).then(|| PathBuf::from(file)));
        }
    }

    Err(DbErr::Custom(
        "SQLite main database was not present in PRAGMA database_list".to_string(),
    ))
}

fn create_temporary_backup_directory() -> Result<PathBuf, DbErr> {
    loop {
        let sequence = TEMPORARY_BACKUP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "skerry_migration_backup_{}_{}",
            std::process::id(),
            sequence
        ));
        match fs::create_dir(&directory) {
            Ok(()) => return Ok(directory),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(DbErr::Custom(format!(
                    "Could not create temporary database backup directory {}: {error}",
                    directory.display()
                )))
            }
        }
    }
}

/// 将文件路径转换为 sqlite 连接 URL
#[cfg(test)]
pub fn path_to_sqlite_url(path: &Path) -> Result<String, DbErr> {
    path_to_sqlite_url_with_mode(path, "rwc")
}

fn path_to_sqlite_url_with_mode(path: &Path, mode: &str) -> Result<String, DbErr> {
    let db_url = url::Url::from_file_path(path)
        .map_err(|_| DbErr::Custom("Invalid database path".to_string()))?;
    Ok(format!("sqlite:{}?mode={}", db_url.path(), mode))
}

async fn verify_integrity(pool: &sqlx::SqlitePool, label: &str) -> Result<(), DbErr> {
    let result: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(pool)
        .await
        .map_err(|e| DbErr::Custom(format!("Failed to check {} integrity: {}", label, e)))?;

    if result.eq_ignore_ascii_case("ok") {
        Ok(())
    } else {
        Err(DbErr::Custom(format!(
            "{}完整性检查失败: {}",
            label, result
        )))
    }
}

async fn create_snapshot(
    pool: &sqlx::SqlitePool,
    path: &Path,
    source_is_in_memory: bool,
) -> Result<(), DbErr> {
    if source_is_in_memory {
        let mut connection = pool.acquire().await.map_err(|error| {
            DbErr::Custom(format!("Failed to acquire SQLite connection: {error}"))
        })?;
        let snapshot = connection.serialize(None).await.map_err(|error| {
            DbErr::Custom(format!(
                "Failed to serialize in-memory SQLite database: {error}"
            ))
        })?;
        let mut file = OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(path)
            .map_err(|error| {
                DbErr::Custom(format!(
                    "Failed to create in-memory SQLite snapshot {}: {error}",
                    path.display()
                ))
            })?;
        file.write_all(snapshot.as_ref()).map_err(|error| {
            DbErr::Custom(format!(
                "Failed to write in-memory SQLite snapshot {}: {error}",
                path.display()
            ))
        })?;
        file.sync_all().map_err(|error| {
            DbErr::Custom(format!(
                "Failed to flush in-memory SQLite snapshot {}: {error}",
                path.display()
            ))
        })?;
        return Ok(());
    }

    sqlx::query("VACUUM INTO ?")
        .bind(path.to_string_lossy().as_ref())
        .execute(pool)
        .await
        .map_err(|e| DbErr::Custom(format!("Failed to create SQLite snapshot: {}", e)))?;
    Ok(())
}

async fn create_verified_backup(
    pool: &sqlx::SqlitePool,
    version: &str,
    target_dir: &Path,
    source_is_in_memory: bool,
) -> Result<PathBuf, DbErr> {
    fs::create_dir_all(target_dir).map_err(|e| {
        DbErr::Custom(format!(
            "无法创建数据库备份目录 {}: {}",
            target_dir.display(),
            e
        ))
    })?;

    let timestamp = Local::now().format("%Y%m%d_%H%M%S_%3f").to_string();
    let backup_path = reserve_backup_path(target_dir, version, &timestamp)?;

    let result = async {
        create_snapshot(pool, &backup_path, source_is_in_memory)
            .await
            .map_err(|error| {
                DbErr::Custom(format!(
                    "无法在 {} 创建数据库快照: {}",
                    backup_path.display(),
                    error
                ))
            })?;

        let backup_url = path_to_sqlite_url_with_mode(&backup_path, "ro").map_err(|error| {
            DbErr::Custom(format!(
                "无法生成备份数据库连接地址 {}: {}",
                backup_path.display(),
                error
            ))
        })?;
        let backup_pool = sqlx::SqlitePool::connect(&backup_url)
            .await
            .map_err(|error| {
                DbErr::Custom(format!(
                    "无法打开备份数据库 {}: {}",
                    backup_path.display(),
                    error
                ))
            })?;
        let label = format!("备份数据库 {}", backup_path.display());
        let integrity_result = verify_integrity(&backup_pool, &label).await;
        backup_pool.close().await;
        integrity_result?;

        Ok(backup_path.clone())
    }
    .await;

    match result {
        Ok(path) => Ok(path),
        Err(error) => {
            if let Err(cleanup_error) = fs::remove_file(&backup_path) {
                if cleanup_error.kind() != ErrorKind::NotFound {
                    log::warn!(
                        "[MIGRATION] Could not remove incomplete backup {}: {}",
                        backup_path.display(),
                        cleanup_error
                    );
                }
            }
            Err(error)
        }
    }
}

fn reserve_backup_path(
    target_dir: &Path,
    version: &str,
    timestamp: &str,
) -> Result<PathBuf, DbErr> {
    let base_name = format!("skerry_{version}_{timestamp}");
    let mut suffix = 0_u32;

    loop {
        let file_name = if suffix == 0 {
            format!("{base_name}.db")
        } else {
            format!("{base_name}_{suffix}.db")
        };
        let path = target_dir.join(&file_name);
        if path.exists() {
            suffix = next_backup_suffix(suffix)?;
            continue;
        }

        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => {
                drop(file);
                return Ok(path);
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                suffix = next_backup_suffix(suffix)?;
            }
            Err(error) => {
                return Err(DbErr::Custom(format!(
                    "无法预留数据库备份文件 {}: {}",
                    path.display(),
                    error
                )))
            }
        }
    }
}

fn next_backup_suffix(current: u32) -> Result<u32, DbErr> {
    current
        .checked_add(1)
        .ok_or_else(|| DbErr::Custom("数据库备份文件名冲突次数超过支持范围".to_string()))
}

async fn create_backup_with_fallback(
    pool: &sqlx::SqlitePool,
    version: &str,
    custom_dir: Option<&Path>,
    default_dir: &Path,
    source_is_in_memory: bool,
) -> Result<PathBuf, DbErr> {
    let Some(custom_dir) = custom_dir else {
        return create_verified_backup(pool, version, default_dir, source_is_in_memory).await;
    };

    match create_verified_backup(pool, version, custom_dir, source_is_in_memory).await {
        Ok(backup_path) => Ok(backup_path),
        Err(custom_error) => {
            log::warn!(
                "[MIGRATION] 自定义数据库备份失败，将尝试默认目录。custom_dir={}, default_dir={}, error={}",
                custom_dir.display(),
                default_dir.display(),
                custom_error
            );

            create_verified_backup(pool, version, default_dir, source_is_in_memory)
                .await
                .map_err(|default_error| {
                    DbErr::Custom(format!(
                        "自定义数据库备份失败，回退默认目录后仍失败；custom_dir={}；custom_error={}；default_dir={}；default_error={}",
                        custom_dir.display(),
                        custom_error,
                        default_dir.display(),
                        default_error
                    ))
                })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::sea_orm::{
        ConnectionTrait, Database, DatabaseBackend, DatabaseConnection, Statement,
    };
    use std::time::{SystemTime, UNIX_EPOCH};

    fn create_test_directory(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "skerry_backup_{}_{}_{}",
            name,
            std::process::id(),
            unique
        ));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    async fn create_test_source(directory: &Path) -> sqlx::SqlitePool {
        let source_path = directory.join("source.db");
        let source_pool = sqlx::SqlitePool::connect(&path_to_sqlite_url(&source_path).unwrap())
            .await
            .unwrap();
        sqlx::query("CREATE TABLE values_table(value TEXT NOT NULL)")
            .execute(&source_pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO values_table(value) VALUES ('kept')")
            .execute(&source_pool)
            .await
            .unwrap();
        source_pool
    }

    async fn read_test_value(backup_path: &Path) -> String {
        let backup_pool =
            sqlx::SqlitePool::connect(&path_to_sqlite_url_with_mode(backup_path, "ro").unwrap())
                .await
                .unwrap();
        let value = sqlx::query_scalar("SELECT value FROM values_table")
            .fetch_one(&backup_pool)
            .await
            .unwrap();
        backup_pool.close().await;
        value
    }

    async fn create_sea_orm_source(connection: &DatabaseConnection) {
        connection
            .execute_unprepared("CREATE TABLE user(db_backup_path TEXT)")
            .await
            .unwrap();
        connection
            .execute_unprepared("INSERT INTO user(db_backup_path) VALUES (NULL)")
            .await
            .unwrap();
        connection
            .execute_unprepared("CREATE TABLE values_table(value TEXT NOT NULL)")
            .await
            .unwrap();
        connection
            .execute_unprepared("INSERT INTO values_table(value) VALUES ('active connection')")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn in_memory_migration_backup_snapshots_the_active_database_and_cleans_up() {
        let connection = Database::connect("sqlite::memory:").await.unwrap();
        create_sea_orm_source(&connection).await;
        let migration_connection = SchemaManagerConnection::Connection(&connection);

        let backup = backup_sqlite(&migration_connection, "memory_test")
            .await
            .unwrap();
        let backup_path = backup.path().to_path_buf();
        assert_eq!(read_test_value(&backup_path).await, "active connection");
        assert!(backup_path.exists());

        drop(backup);
        assert!(!backup_path.exists());
        connection.get_sqlite_connection_pool().close().await;
    }

    #[tokio::test]
    async fn file_backed_migration_backup_uses_the_active_database_location() {
        let directory = create_test_directory("active_file_source");
        let source_path = directory.join("active.db");
        let connection = Database::connect(path_to_sqlite_url(&source_path).unwrap())
            .await
            .unwrap();
        create_sea_orm_source(&connection).await;
        let migration_connection = SchemaManagerConnection::Connection(&connection);

        let backup = backup_sqlite(&migration_connection, "file_test")
            .await
            .unwrap();
        let backup_path = backup.path().to_path_buf();
        assert_eq!(
            backup_path.parent(),
            Some(directory.join("backups").as_path())
        );
        assert_eq!(read_test_value(&backup_path).await, "active connection");
        drop(backup);
        assert!(backup_path.exists());

        connection.get_sqlite_connection_pool().close().await;
        fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn migration_backup_reads_custom_directory_from_the_active_database() {
        let directory = create_test_directory("active_custom_backup_setting");
        let source_path = directory.join("active.db");
        let custom_backup_directory = directory.join("configured-backups");
        let connection = Database::connect(path_to_sqlite_url(&source_path).unwrap())
            .await
            .unwrap();
        create_sea_orm_source(&connection).await;
        connection
            .execute(Statement::from_sql_and_values(
                DatabaseBackend::Sqlite,
                "UPDATE user SET db_backup_path = ?",
                [custom_backup_directory
                    .to_string_lossy()
                    .into_owned()
                    .into()],
            ))
            .await
            .unwrap();
        let migration_connection = SchemaManagerConnection::Connection(&connection);

        let backup = backup_sqlite(&migration_connection, "custom_setting_test")
            .await
            .unwrap();
        let backup_path = backup.path().to_path_buf();
        assert_eq!(
            backup_path.parent(),
            Some(custom_backup_directory.as_path())
        );
        assert_eq!(read_test_value(&backup_path).await, "active connection");
        drop(backup);
        assert!(backup_path.exists());

        connection.get_sqlite_connection_pool().close().await;
        fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn vacuum_into_creates_readable_snapshot() {
        let directory = create_test_directory("snapshot_test");
        let backup_path = directory.join("backup.db");
        let source_pool = create_test_source(&directory).await;

        create_snapshot(&source_pool, &backup_path, false)
            .await
            .unwrap();
        source_pool.close().await;

        let backup_pool =
            sqlx::SqlitePool::connect(&path_to_sqlite_url_with_mode(&backup_path, "ro").unwrap())
                .await
                .unwrap();
        verify_integrity(&backup_pool, "测试备份").await.unwrap();
        let value: String = sqlx::query_scalar("SELECT value FROM values_table")
            .fetch_one(&backup_pool)
            .await
            .unwrap();
        assert_eq!(value, "kept");
        backup_pool.close().await;

        fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn custom_backup_failure_falls_back_to_verified_default_directory() {
        let directory = create_test_directory("fallback_test");
        let invalid_custom_dir = directory.join("invalid-custom");
        let default_dir = directory.join("missing").join("backups");
        fs::write(&invalid_custom_dir, "not a directory").unwrap();

        let source_pool = create_test_source(&directory).await;
        let backup_path = create_backup_with_fallback(
            &source_pool,
            "fallback_test",
            Some(&invalid_custom_dir),
            &default_dir,
            false,
        )
        .await
        .unwrap();
        assert_eq!(backup_path.parent(), Some(default_dir.as_path()));

        let value = read_test_value(&backup_path).await;
        assert_eq!(value, "kept");
        source_pool.close().await;

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn concurrent_migration_snapshots_reserve_distinct_names() {
        let directory = create_test_directory("migration_filename_collision");
        let first =
            reserve_backup_path(&directory, "collision_test", "20261019_120000_000").unwrap();
        let second =
            reserve_backup_path(&directory, "collision_test", "20261019_120000_000").unwrap();

        assert_eq!(
            first.file_name().unwrap(),
            "skerry_collision_test_20261019_120000_000.db"
        );
        assert_eq!(
            second.file_name().unwrap(),
            "skerry_collision_test_20261019_120000_000_1.db"
        );
        drop(first);
        drop(second);
        fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn fallback_failure_reports_both_directories() {
        let directory = create_test_directory("fallback_error_test");
        let invalid_custom_dir = directory.join("invalid-custom");
        let invalid_default_dir = directory.join("invalid-default");
        fs::write(&invalid_custom_dir, "not a directory").unwrap();
        fs::write(&invalid_default_dir, "not a directory").unwrap();

        let source_pool = create_test_source(&directory).await;
        let error = create_backup_with_fallback(
            &source_pool,
            "fallback_error_test",
            Some(&invalid_custom_dir),
            &invalid_default_dir,
            false,
        )
        .await
        .unwrap_err()
        .to_string();

        assert!(error.contains(invalid_custom_dir.to_string_lossy().as_ref()));
        assert!(error.contains(invalid_default_dir.to_string_lossy().as_ref()));
        assert!(error.contains("回退默认目录后仍失败"));
        source_pool.close().await;

        fs::remove_dir_all(directory).unwrap();
    }
}
