use crate::backup::archive::create_7z_archive;
#[cfg(windows)]
use crate::backup::archive::open_validated_archive;
#[cfg(not(windows))]
use crate::backup::common::reserve_backup_file_path;
#[cfg(feature = "tauri-app")]
use crate::backup::common::{BackupOptions, cleanup_auto_backup_files};
use crate::backup::common::{BackupResult, resolve_backup_dir};
#[cfg(windows)]
use crate::backup::common::{
    publish_staged_backup_file_windows, reserve_staged_backup_file_windows,
};
use sea_orm::DatabaseConnection;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// 备份所有自定义封面（仅自定义封面，不含云端缓存）
///
/// 将自定义封面文件复制到临时目录后压缩为 7z 文件，
/// 备份路径跟随数据库备份路径逻辑。
///
/// 压缩包内结构（解压后直接覆盖到数据目录即可）：
/// ```text
/// covers/
///   game_123/
///     cover_123_jpg_1703123456789.jpg
///   game_456/
///     cover_456_png_1703123456789.png
/// ```
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn backup_custom_covers(
    db: tauri::State<'_, DatabaseConnection>,
    options: Option<BackupOptions>,
) -> Result<BackupResult, String> {
    let options = options.unwrap_or_default();
    let result = backup_custom_covers_archive(&db, options.auto).await?;

    if options.auto
        && let Some(max_auto_backups) = options.max_auto_backups
    {
        let backup_dir = resolve_backup_dir(&db).await?;
        if let Err(e) =
            cleanup_auto_backup_files(&backup_dir, "custom_covers_auto_", ".7z", max_auto_backups)
        {
            log::warn!("清理旧自定义封面自动备份失败: {}", e);
        }
    }

    Ok(result)
}

pub async fn backup_custom_covers_archive(
    db: &DatabaseConnection,
    auto: bool,
) -> Result<BackupResult, String> {
    let covers_dir = skerry_path::get_base_data_dir()?.join("covers");
    match fs::metadata(&covers_dir) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => return Err(format!("自定义封面路径不是目录: {}", covers_dir.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(BackupResult {
                success: true,
                path: None,
                message: "没有自定义封面需要备份".to_string(),
            });
        }
        Err(error) => {
            return Err(format!(
                "检查自定义封面目录失败 {}: {error}",
                covers_dir.display()
            ));
        }
    }

    let backup_dir = resolve_backup_dir(db).await?;
    let archive_prefix = if auto {
        "custom_covers_auto"
    } else {
        "custom_covers"
    }
    .to_string();
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();

    tokio::task::spawn_blocking(move || {
        backup_custom_covers_archive_blocking(&covers_dir, &backup_dir, &archive_prefix, &timestamp)
    })
    .await
    .map_err(|e| format!("自定义封面备份任务失败: {e}"))?
}

fn backup_custom_covers_archive_blocking(
    covers_dir: &Path,
    backup_dir: &Path,
    archive_prefix: &str,
    archive_timestamp: &str,
) -> Result<BackupResult, String> {
    let candidates = collect_custom_cover_candidates(covers_dir)?;
    if candidates.is_empty() {
        return Ok(BackupResult {
            success: true,
            path: None,
            message: "没有自定义封面需要备份".to_string(),
        });
    }

    let staging_dir = create_cover_backup_staging_directory(&std::env::temp_dir())?;
    let archive_result = (|| {
        let covers_staging_dir = staging_dir.join("covers");
        copy_custom_cover_candidates(&candidates, &covers_staging_dir)?;

        let filename_stem = format!("{archive_prefix}_{archive_timestamp}");

        #[cfg(windows)]
        {
            let (archive_path, size) =
                create_and_publish_cover_archive(&staging_dir, backup_dir, &filename_stem)?;
            log::info!(
                "自定义封面备份成功: {} ({} bytes)",
                archive_path.display(),
                size
            );
            Ok(BackupResult {
                success: true,
                path: Some(archive_path.to_string_lossy().to_string()),
                message: "自定义封面备份成功".to_string(),
            })
        }

        #[cfg(not(windows))]
        {
            let (_, archive_path) = reserve_backup_file_path(backup_dir, &filename_stem, "7z")?;
            let size = match create_7z_archive(&staging_dir, &archive_path) {
                Ok(size) => size,
                Err(error) => {
                    let failure = format!("压缩自定义封面失败: {error}");
                    return Err(match fs::remove_file(&archive_path) {
                        Ok(()) => failure,
                        Err(cleanup_error)
                            if cleanup_error.kind() == std::io::ErrorKind::NotFound =>
                        {
                            failure
                        }
                        Err(cleanup_error) => format!(
                            "{failure}；清理未完成封面备份失败 {}: {cleanup_error}",
                            archive_path.display()
                        ),
                    });
                }
            };
            log::info!(
                "自定义封面备份成功: {} ({} bytes)",
                archive_path.display(),
                size
            );
            Ok(BackupResult {
                success: true,
                path: Some(archive_path.to_string_lossy().to_string()),
                message: "自定义封面备份成功".to_string(),
            })
        }
    })();

    match (archive_result, fs::remove_dir_all(&staging_dir)) {
        (Ok(result), Ok(())) => Ok(result),
        (Ok(result), Err(error)) if error.kind() == std::io::ErrorKind::NotFound => Ok(result),
        (Ok(result), Err(error)) => {
            log::warn!(
                "封面备份结果已生成，但清理暂存目录失败 {}: {error}",
                staging_dir.display()
            );
            Ok(result)
        }
        (Err(failure), Ok(())) => Err(failure),
        (Err(failure), Err(error)) if error.kind() == std::io::ErrorKind::NotFound => Err(failure),
        (Err(failure), Err(error)) => Err(format!(
            "{failure}；清理封面备份暂存目录失败 {}: {error}",
            staging_dir.display()
        )),
    }
}

#[cfg(windows)]
fn create_and_publish_cover_archive(
    source: &Path,
    backup_dir: &Path,
    filename_stem: &str,
) -> Result<(PathBuf, u64), String> {
    let target = backup_dir.join(format!("{filename_stem}.7z"));
    let staged = reserve_staged_backup_file_windows(&target, "covers-backup")?;
    let result = create_7z_archive(source, &staged)
        .map_err(|error| format!("压缩自定义封面失败: {error}"))
        .and_then(|size| {
            open_validated_archive(&staged)
                .map(|_| size)
                .map_err(|error| format!("验证自定义封面备份失败: {error}"))
        });
    let size = match result {
        Ok(size) => size,
        Err(error) => return Err(remove_failed_cover_archive(&staged, error)),
    };
    match publish_staged_backup_file_windows(&staged, backup_dir, filename_stem, "7z") {
        Ok((_, path)) => Ok((path, size)),
        Err(error) => Err(remove_failed_cover_archive(
            &staged,
            format!("发布自定义封面备份失败: {error}"),
        )),
    }
}

#[cfg(windows)]
fn remove_failed_cover_archive(path: &Path, failure: String) -> String {
    match fs::remove_file(path) {
        Ok(()) => failure,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => failure,
        Err(error) => format!(
            "{failure}；清理未完成封面备份失败 {}: {error}",
            path.display()
        ),
    }
}

fn create_cover_backup_staging_directory(parent: &Path) -> Result<PathBuf, String> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("读取封面备份暂存时间失败: {error}"))?
        .as_nanos();

    create_cover_backup_staging_directory_at(parent, nonce)
}

fn create_cover_backup_staging_directory_at(parent: &Path, nonce: u128) -> Result<PathBuf, String> {
    let mut attempt = 0_u32;
    loop {
        let candidate = parent.join(format!(
            "skerry-covers-{}-{nonce}-{attempt}",
            std::process::id()
        ));
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                attempt = attempt.checked_add(1).ok_or_else(|| {
                    format!("封面备份暂存目录序号超出支持范围: {}", parent.display())
                })?;
            }
            Err(error) => {
                return Err(format!(
                    "创建封面备份暂存目录失败 {}: {error}",
                    candidate.display()
                ));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn same_timestamp_cover_archives_keep_the_previous_archive() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("skerry_cover_backup_collision_{nonce}"));
        let covers = root.join("covers");
        let game_covers = covers.join("game_7");
        let backup_dir = root.join("backups");
        fs::create_dir_all(&game_covers).unwrap();
        fs::create_dir_all(&backup_dir).unwrap();
        let cover = game_covers.join("cover_7_png_1.png");
        fs::write(&cover, b"first cover image").unwrap();
        let timestamp = "20261019_120000";

        let first = backup_custom_covers_archive_blocking(
            &covers,
            &backup_dir,
            "custom_covers_auto",
            timestamp,
        )
        .unwrap();
        let first_path = Path::new(first.path.as_deref().unwrap()).to_path_buf();
        let first_contents = fs::read(&first_path).unwrap();

        fs::write(&cover, b"second cover image").unwrap();
        let second = backup_custom_covers_archive_blocking(
            &covers,
            &backup_dir,
            "custom_covers_auto",
            timestamp,
        )
        .unwrap();
        let second_path = Path::new(second.path.as_deref().unwrap());

        assert_eq!(
            first_path.file_name().unwrap(),
            "custom_covers_auto_20261019_120000.7z"
        );
        assert_eq!(
            second_path.file_name().unwrap(),
            "custom_covers_auto_20261019_120000_1.7z"
        );
        assert_eq!(fs::read(&first_path).unwrap(), first_contents);
        assert!(fs::metadata(second_path).unwrap().len() > 0);
        assert_eq!(fs::read_dir(&backup_dir).unwrap().count(), 2);

        let extracted = root.join("extracted");
        fs::create_dir(&extracted).unwrap();
        let mut reader = crate::backup::archive::open_validated_archive(second_path).unwrap();
        crate::backup::archive::extract_validated_archive(&mut reader, &extracted).unwrap();
        assert_eq!(
            fs::read(extracted.join("covers/game_7/cover_7_png_1.png")).unwrap(),
            b"second cover image"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn failed_cover_archive_creation_leaves_no_final_or_staged_file() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("skerry_cover_backup_failure_{nonce}"));
        let backup_dir = root.join("backups");
        fs::create_dir_all(&backup_dir).unwrap();

        let result = create_and_publish_cover_archive(
            &root.join("missing-source"),
            &backup_dir,
            "custom_covers_20261019_120000",
        );

        assert!(result.is_err());
        assert_eq!(fs::read_dir(&backup_dir).unwrap().count(), 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cover_candidates_require_a_matching_direct_game_folder_and_id_boundary() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("skerry_cover_candidates_{nonce}"));
        let covers = root.join("covers");
        fs::create_dir_all(covers.join("game_7/nested")).unwrap();
        fs::create_dir_all(covers.join("game_70")).unwrap();
        fs::create_dir_all(covers.join("other_7")).unwrap();
        fs::write(covers.join("game_7/cover_7_png_1.png"), b"custom").unwrap();
        fs::write(covers.join("game_7/cover_70_png_2.png"), b"other game").unwrap();
        fs::write(
            covers.join("game_7/cover_7suffix_png_3.png"),
            b"no id boundary",
        )
        .unwrap();
        fs::write(covers.join("game_7/cloud_7.png"), b"cloud cache").unwrap();
        fs::write(covers.join("game_7/cg_7_1.png"), b"gallery image").unwrap();
        fs::write(
            covers.join("game_7/nested/cover_7_png_4.png"),
            b"nested file",
        )
        .unwrap();
        fs::write(covers.join("game_70/cover_7_png_5.png"), b"wrong folder").unwrap();
        fs::write(covers.join("other_7/cover_7_png_6.png"), b"wrong directory").unwrap();

        let candidates = collect_custom_cover_candidates(&covers).unwrap();
        let archived_paths = candidates
            .iter()
            .map(|candidate| candidate.archive_relative_path.clone())
            .collect::<Vec<_>>();

        assert_eq!(archived_paths, [PathBuf::from("game_7/cover_7_png_1.png")]);

        let archive_covers_dir = root.join("prepared/covers");
        copy_custom_cover_candidates(&candidates, &archive_covers_dir).unwrap();
        assert_eq!(
            fs::read(archive_covers_dir.join("game_7/cover_7_png_1.png")).unwrap(),
            b"custom"
        );
        assert_eq!(
            fs::read_dir(archive_covers_dir.join("game_7"))
                .unwrap()
                .count(),
            1
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cache_only_directory_reports_no_custom_cover_archive() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("skerry_cover_cache_only_{nonce}"));
        let covers = root.join("covers/game_7");
        let backup_dir = root.join("backups");
        fs::create_dir_all(&covers).unwrap();
        fs::create_dir_all(&backup_dir).unwrap();
        fs::write(covers.join("cloud_7.png"), b"cached remote cover").unwrap();

        let result = backup_custom_covers_archive_blocking(
            &root.join("covers"),
            &backup_dir,
            "custom",
            "test",
        )
        .unwrap();

        assert!(result.success);
        assert!(result.path.is_none());
        assert_eq!(result.message, "没有自定义封面需要备份");
        assert_eq!(fs::read_dir(&backup_dir).unwrap().count(), 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cover_backup_staging_directories_are_exclusive() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("skerry_cover_staging_{nonce}"));
        fs::create_dir_all(&root).unwrap();

        let first = create_cover_backup_staging_directory_at(&root, 42).unwrap();
        let second = create_cover_backup_staging_directory_at(&root, 42).unwrap();

        assert_ne!(first, second);
        assert!(first.file_name().unwrap().to_string_lossy().ends_with("-0"));
        assert!(
            second
                .file_name()
                .unwrap()
                .to_string_lossy()
                .ends_with("-1")
        );
        assert!(first.is_dir());
        assert!(second.is_dir());
        fs::remove_dir_all(root).unwrap();
    }
}

struct CustomCoverCandidate {
    source_path: PathBuf,
    archive_relative_path: PathBuf,
}

/// 先完整确定归档文件清单，再创建暂存文件。
/// 文件夹和文件名中的后缀必须指向同一游戏；下划线用于兼容旧文件名的 ID 边界。
fn collect_custom_cover_candidates(covers_dir: &Path) -> Result<Vec<CustomCoverCandidate>, String> {
    let entries = fs::read_dir(covers_dir).map_err(|e| format!("无法读取封面目录: {}", e))?;
    let mut candidates = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| format!("读取目录项失败: {}", e))?;
        let entry_path = entry.path();

        if !entry_path.is_dir() {
            continue;
        }

        let dir_name = entry.file_name().to_string_lossy().to_string();

        // 只处理 game_{id} 格式的目录
        let game_id_str = match dir_name.strip_prefix("game_") {
            Some(id) => id,
            None => continue,
        };

        let file_entries = fs::read_dir(&entry_path)
            .map_err(|e| format!("无法读取游戏封面目录 {}: {}", dir_name, e))?;

        for file_entry in file_entries {
            let file_entry = file_entry.map_err(|e| format!("读取游戏封面目录项失败: {}", e))?;

            if !file_entry.path().is_file() {
                continue;
            }

            let file_name = file_entry.file_name().to_string_lossy().to_string();
            if !is_custom_cover_for_game(&file_name, game_id_str) {
                continue;
            }

            candidates.push(CustomCoverCandidate {
                source_path: file_entry.path(),
                archive_relative_path: PathBuf::from(entry.file_name())
                    .join(file_entry.file_name()),
            });
        }
    }

    candidates.sort_unstable_by(|left, right| {
        left.archive_relative_path.cmp(&right.archive_relative_path)
    });
    Ok(candidates)
}

fn is_custom_cover_for_game(file_name: &str, game_id: &str) -> bool {
    file_name
        .strip_prefix("cover_")
        .and_then(|name| name.strip_prefix(game_id))
        .is_some_and(|remaining| remaining.starts_with('_'))
}

fn copy_custom_cover_candidates(
    candidates: &[CustomCoverCandidate],
    archive_covers_dir: &Path,
) -> Result<(), String> {
    for candidate in candidates {
        let target_path = archive_covers_dir.join(&candidate.archive_relative_path);
        let target_dir = target_path
            .parent()
            .ok_or_else(|| format!("封面备份路径缺少父目录: {}", target_path.display()))?;
        fs::create_dir_all(target_dir).map_err(|error| {
            format!("创建封面备份暂存目录失败 {}: {error}", target_dir.display())
        })?;
        fs::copy(&candidate.source_path, &target_path).map_err(|error| {
            format!(
                "复制自定义封面文件失败 {}: {error}",
                candidate.archive_relative_path.display()
            )
        })?;
    }

    Ok(())
}
