use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use skerry_path::{get_base_data_dir, get_base_data_dir_for_mode};

use crate::utils::fs::move_file;

#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

#[derive(Debug, Default)]
pub struct StartupMigrationResult {
    pub migrated_files: usize,
    pub replaced_files: usize,
    pub removed_legacy_files: usize,
    pub skipped: usize,
    pub executed: usize,
}

pub fn run_startup_migrations() -> Result<StartupMigrationResult, String> {
    let mut result = StartupMigrationResult::default();

    run_startup_migration(&mut result, m20260326_000001_migrate_legacy_covers)?;
    run_startup_migration(&mut result, m20260906_000001_merge_next_up_covers)?;

    Ok(result)
}

fn run_startup_migration(
    aggregate: &mut StartupMigrationResult,
    migration: fn() -> Result<StartupMigrationResult, String>,
) -> Result<(), String> {
    let result = migration()?;

    aggregate.migrated_files += result.migrated_files;
    aggregate.replaced_files += result.replaced_files;
    aggregate.removed_legacy_files += result.removed_legacy_files;
    aggregate.skipped += result.skipped;
    aggregate.executed += result.executed;

    Ok(())
}

fn m20260326_000001_migrate_legacy_covers() -> Result<StartupMigrationResult, String> {
    let legacy_covers_dir = get_base_data_dir_for_mode(true)?.join("covers");
    let current_covers_dir = get_base_data_dir()?.join("covers");

    if current_covers_dir == legacy_covers_dir || !legacy_covers_dir.exists() {
        return Ok(StartupMigrationResult {
            skipped: 1,
            ..Default::default()
        });
    }

    if !legacy_covers_dir.is_dir() {
        return Err(format!(
            "旧版 covers 路径不是目录: {}",
            legacy_covers_dir.display()
        ));
    }

    fs::create_dir_all(&current_covers_dir).map_err(|e| {
        format!(
            "无法创建新的 covers 目录 {}: {}",
            current_covers_dir.display(),
            e
        )
    })?;

    let mut result = StartupMigrationResult {
        executed: 1,
        ..Default::default()
    };

    merge_covers_dir(&legacy_covers_dir, &current_covers_dir, &mut result)?;
    remove_dir_if_empty(&legacy_covers_dir)?;

    log::info!(
        "启动迁移完成 name=m20260326_000001_migrate_legacy_covers from={} to={} migrated={} replaced={} removed_legacy={}",
        legacy_covers_dir.display(),
        current_covers_dir.display(),
        result.migrated_files,
        result.replaced_files,
        result.removed_legacy_files
    );

    Ok(result)
}

fn m20260906_000001_merge_next_up_covers() -> Result<StartupMigrationResult, String> {
    let legacy_next_up_dir = get_base_data_dir()?.join("next-up-covers");
    let current_covers_dir = get_base_data_dir()?.join("covers");

    if !legacy_next_up_dir.exists() {
        return Ok(StartupMigrationResult {
            skipped: 1,
            ..Default::default()
        });
    }

    if !legacy_next_up_dir.is_dir() {
        return Err(format!(
            "旧 next-up-covers 路径不是目录: {}",
            legacy_next_up_dir.display()
        ));
    }

    fs::create_dir_all(&current_covers_dir).map_err(|e| {
        format!(
            "无法创建 covers 目录 {}: {}",
            current_covers_dir.display(),
            e
        )
    })?;

    let mut result = StartupMigrationResult {
        executed: 1,
        ..Default::default()
    };

    merge_covers_dir(&legacy_next_up_dir, &current_covers_dir, &mut result)?;
    remove_dir_if_empty(&legacy_next_up_dir)?;

    log::info!(
        "启动迁移完成 name=m20260906_000001_merge_next_up_covers from={} to={} migrated={} replaced={} removed_legacy={}",
        legacy_next_up_dir.display(),
        current_covers_dir.display(),
        result.migrated_files,
        result.replaced_files,
        result.removed_legacy_files
    );

    Ok(result)
}

fn merge_covers_dir(
    from_dir: &Path,
    to_dir: &Path,
    result: &mut StartupMigrationResult,
) -> Result<(), String> {
    let mut pending_directories = vec![open_merge_directory(from_dir, to_dir, false)?];

    while let Some(mut directory) = pending_directories.pop() {
        let (entry, to_dir) = match directory.entries.next() {
            Some(Ok(entry)) => {
                let to_dir = directory.to_dir.clone();
                pending_directories.push(directory);
                (entry, to_dir)
            }
            Some(Err(error)) => {
                return Err(format!("读取 legacy covers 项失败: {}", error));
            }
            None => {
                if directory.remove_from_when_finished {
                    remove_dir_if_empty(&directory.from_dir)?;
                }
                continue;
            }
        };

        let from_path = entry.path();
        let to_path = to_dir.join(entry.file_name());

        match classify_merge_entry(&from_path) {
            MergeEntryKind::ReparsePoint => {
                log::warn!("启动迁移跳过 Windows 重解析点 path={}", from_path.display());
                continue;
            }
            MergeEntryKind::Directory => {
                let child = open_merge_directory(&from_path, &to_path, true)?;
                fs::create_dir_all(&to_path)
                    .map_err(|e| format!("创建目标目录失败 {}: {}", to_path.display(), e))?;
                pending_directories.push(child);
                continue;
            }
            MergeEntryKind::File => {}
            MergeEntryKind::Other => continue,
        }

        if !to_path.exists() {
            move_file(&from_path, &to_path)?;
            result.migrated_files += 1;
            continue;
        }

        if !to_path.is_file() {
            return Err(format!(
                "目标 covers 路径已存在且不是文件: {}",
                to_path.display()
            ));
        }

        let from_modified = file_modified_time(&from_path)?;
        let to_modified = file_modified_time(&to_path)?;

        if from_modified > to_modified {
            move_file(&from_path, &to_path)?;
            result.migrated_files += 1;
            result.replaced_files += 1;
        } else {
            fs::remove_file(&from_path)
                .map_err(|e| format!("删除 legacy 重复文件失败 {}: {}", from_path.display(), e))?;
            result.removed_legacy_files += 1;
        }
    }

    Ok(())
}

struct MergeDirectory {
    from_dir: PathBuf,
    to_dir: PathBuf,
    entries: fs::ReadDir,
    remove_from_when_finished: bool,
}

#[derive(Clone, Copy)]
enum MergeEntryKind {
    Directory,
    File,
    ReparsePoint,
    Other,
}

fn classify_merge_entry(path: &Path) -> MergeEntryKind {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        return match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 => {
                MergeEntryKind::ReparsePoint
            }
            Ok(metadata) if metadata.is_dir() => MergeEntryKind::Directory,
            Ok(metadata) if metadata.is_file() => MergeEntryKind::File,
            Ok(_) | Err(_) => MergeEntryKind::Other,
        };
    }

    #[cfg(not(windows))]
    {
        if path.is_dir() {
            MergeEntryKind::Directory
        } else if path.is_file() {
            MergeEntryKind::File
        } else {
            MergeEntryKind::Other
        }
    }
}

fn open_merge_directory(
    from_dir: &Path,
    to_dir: &Path,
    remove_from_when_finished: bool,
) -> Result<MergeDirectory, String> {
    #[cfg(windows)]
    if remove_from_when_finished && is_windows_reparse_point(from_dir)? {
        return Err(format!(
            "启动迁移目录变为 Windows 重解析点，拒绝跟随: {}",
            from_dir.display()
        ));
    }

    let entries = fs::read_dir(from_dir)
        .map_err(|e| format!("读取 legacy covers 目录失败 {}: {}", from_dir.display(), e))?;

    Ok(MergeDirectory {
        from_dir: from_dir.to_path_buf(),
        to_dir: to_dir.to_path_buf(),
        entries,
        remove_from_when_finished,
    })
}

#[cfg(windows)]
fn is_windows_reparse_point(path: &Path) -> Result<bool, String> {
    use std::os::windows::fs::MetadataExt;

    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!("检查启动迁移路径失败 {}: {error}", path.display()));
        }
    };
    Ok(metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
}

fn file_modified_time(path: &Path) -> Result<SystemTime, String> {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .map_err(|e| format!("读取文件修改时间失败 {}: {}", path.display(), e))
}

fn remove_dir_if_empty(path: &Path) -> Result<(), String> {
    if !path.exists() || !path.is_dir() {
        return Ok(());
    }

    let mut entries = fs::read_dir(path)
        .map_err(|e| format!("检查目录是否为空失败 {}: {}", path.display(), e))?;

    if entries.next().is_none() {
        fs::remove_dir(path).map_err(|e| format!("删除空目录失败 {}: {}", path.display(), e))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{StartupMigrationResult, merge_covers_dir, remove_dir_if_empty};
    #[cfg(windows)]
    use super::{is_windows_reparse_point, open_merge_directory};
    use std::fs::{self, FileTimes, OpenOptions};
    use std::io;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, UNIX_EPOCH};

    static NEXT_TEMP_DIRECTORY: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            loop {
                let sequence = NEXT_TEMP_DIRECTORY.fetch_add(1, Ordering::Relaxed);
                let path = std::env::temp_dir().join(format!(
                    "skerry-cover-migration-test-{}-{sequence}",
                    std::process::id()
                ));

                match fs::create_dir(&path) {
                    Ok(()) => return Self(path),
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(error) => panic!("测试目录应能创建: {error}"),
                }
            }
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
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
            .expect("运行 Windows junction 创建命令");
        assert!(
            output.status.success(),
            "junction 创建失败: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
    }

    fn write_file_with_modified_time(path: &Path, contents: &[u8], modified_seconds: u64) {
        fs::create_dir_all(path.parent().expect("测试文件应有父目录"))
            .expect("测试文件父目录应能创建");
        fs::write(path, contents).expect("测试文件应能写入");
        OpenOptions::new()
            .write(true)
            .open(path)
            .expect("测试文件应能打开")
            .set_times(
                FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(modified_seconds)),
            )
            .expect("测试文件修改时间应能设置");
    }

    #[test]
    fn iterative_merge_preserves_newer_file_conflict_policy_and_cleans_nested_sources() {
        let temporary = TestDirectory::new();
        let from_dir = temporary.path().join("legacy");
        let to_dir = temporary.path().join("current");

        write_file_with_modified_time(&from_dir.join("only/nested/cover.png"), b"new cover", 500);
        write_file_with_modified_time(&from_dir.join("replace.png"), b"legacy newer", 500);
        write_file_with_modified_time(&from_dir.join("equal.png"), b"legacy equal", 300);
        write_file_with_modified_time(&from_dir.join("older.png"), b"legacy older", 100);
        write_file_with_modified_time(&to_dir.join("replace.png"), b"current older", 100);
        write_file_with_modified_time(&to_dir.join("equal.png"), b"current equal", 300);
        write_file_with_modified_time(&to_dir.join("older.png"), b"current newer", 500);

        let mut result = StartupMigrationResult::default();
        merge_covers_dir(&from_dir, &to_dir, &mut result).expect("legacy contents should merge");
        remove_dir_if_empty(&from_dir).expect("empty legacy root should be removed");

        assert_eq!(
            fs::read(to_dir.join("only/nested/cover.png")).unwrap(),
            b"new cover"
        );
        assert_eq!(
            fs::read(to_dir.join("replace.png")).unwrap(),
            b"legacy newer"
        );
        assert_eq!(
            fs::read(to_dir.join("equal.png")).unwrap(),
            b"current equal"
        );
        assert_eq!(
            fs::read(to_dir.join("older.png")).unwrap(),
            b"current newer"
        );
        assert!(!from_dir.exists());
        assert_eq!(result.migrated_files, 2);
        assert_eq!(result.replaced_files, 1);
        assert_eq!(result.removed_legacy_files, 2);
    }

    #[test]
    fn file_destination_directory_fails_without_removing_the_legacy_file() {
        let temporary = TestDirectory::new();
        let from_dir = temporary.path().join("legacy");
        let to_dir = temporary.path().join("current");
        let legacy_file = from_dir.join("cover.png");

        write_file_with_modified_time(&legacy_file, b"legacy cover", 500);
        fs::create_dir_all(to_dir.join("cover.png"))
            .expect("conflicting destination directory should be created");

        let mut result = StartupMigrationResult::default();
        let error = merge_covers_dir(&from_dir, &to_dir, &mut result)
            .expect_err("a directory cannot replace a legacy cover file");

        assert!(error.contains("目标 covers 路径已存在且不是文件"));
        assert_eq!(fs::read(legacy_file).unwrap(), b"legacy cover");
        assert!(to_dir.join("cover.png").is_dir());
        assert_eq!(result.migrated_files, 0);
        assert_eq!(result.replaced_files, 0);
        assert_eq!(result.removed_legacy_files, 0);
    }

    #[cfg(windows)]
    #[test]
    fn nested_reparse_points_are_skipped_without_following_or_removing_them() {
        let temporary = TestDirectory::new();
        let from_dir = temporary.path().join("legacy");
        let to_dir = temporary.path().join("current");
        let outside_dir = temporary.path().join("outside");
        let junction = from_dir.join("linked");
        fs::create_dir(&from_dir).expect("legacy root should be created");
        fs::create_dir(&to_dir).expect("current root should be created");
        fs::create_dir(&outside_dir).expect("outside root should be created");
        fs::write(from_dir.join("ordinary.png"), b"legacy image")
            .expect("ordinary legacy image should be written");
        fs::write(outside_dir.join("private.png"), b"outside image")
            .expect("outside image should be written");
        create_test_junction(&junction, &outside_dir);

        let mut result = StartupMigrationResult::default();
        merge_covers_dir(&from_dir, &to_dir, &mut result)
            .expect("ordinary files should migrate around the junction");
        remove_dir_if_empty(&from_dir).expect("legacy root should be checked after migration");

        assert_eq!(
            fs::read(to_dir.join("ordinary.png")).expect("ordinary image should migrate"),
            b"legacy image"
        );
        assert!(!to_dir.join("linked/private.png").exists());
        assert_eq!(
            fs::read(outside_dir.join("private.png")).expect("outside image should remain"),
            b"outside image"
        );
        assert!(
            from_dir.is_dir(),
            "junction keeps the legacy root non-empty"
        );
        assert!(is_windows_reparse_point(&junction).expect("junction should be inspected"));
        assert_eq!(result.migrated_files, 1);

        let nested_error = match open_merge_directory(&junction, &to_dir, true) {
            Ok(_) => panic!("a nested reparse point must not be opened for traversal"),
            Err(error) => error,
        };
        assert!(nested_error.contains("重解析点"));
    }
}
