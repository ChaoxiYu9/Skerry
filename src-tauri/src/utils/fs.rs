#[cfg(target_os = "windows")]
use crate::utils::command_ext::CommandGuiExt;

use serde::Serialize;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct PortableModeResult {
    pub is_portable: bool,
}

#[derive(Debug, Serialize)]
pub struct DroppedLocalPathResult {
    pub kind: DroppedLocalPathKind,
    pub path: Option<String>,
    pub directory: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DroppedLocalPathKind {
    Executable,
    SingleExecutable,
    MultipleExecutables,
    NoExecutable,
    Invalid,
}

const LOCAL_EXECUTABLE_EXTENSIONS: &[&str] = &["exe", "bat", "cmd"];

fn is_supported_local_executable(path: &Path) -> bool {
    path.extension().is_some_and(|ext| {
        LOCAL_EXECUTABLE_EXTENSIONS
            .iter()
            .any(|expected| ext.eq_ignore_ascii_case(expected))
    })
}

enum ExecutableCandidates {
    None,
    One(PathBuf),
    Multiple,
}

impl ExecutableCandidates {
    fn include(self, path: PathBuf) -> Self {
        match self {
            Self::None => Self::One(path),
            Self::One(_) | Self::Multiple => Self::Multiple,
        }
    }
}

/// 打开目录
///
/// # Arguments
///
/// * `dir_path` - 要打开的目录路径
///
/// # Returns
///
/// 操作结果
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn open_directory(dir_path: String) -> Result<(), String> {
    let dir_path = dir_path.trim();
    if dir_path.is_empty() {
        return Err("目录未设置".to_string());
    }
    let open_path = PathBuf::from(dir_path);
    if !open_path.is_dir() {
        return Err(format!("目录不存在或不是文件夹: {}", open_path.display()));
    }

    #[cfg(target_os = "windows")]
    {
        // Windows Explorer 在某些情况下对反斜杠的处理更稳定
        // 虽然 Windows 系统本身支持正斜杠，但 Explorer 更喜欢原生的反斜杠格式
        let normalized_path = open_path.to_string_lossy().replace('/', "\\");

        let result = Command::new("explorer")
            .arg(&normalized_path)
            .gui_safe()
            .spawn();

        match result {
            Ok(_) => Ok(()),
            Err(e) => {
                let fallback_result = Command::new("cmd")
                    .args(["/c", "start", "", &normalized_path])
                    .gui_safe()
                    .spawn();

                match fallback_result {
                    Ok(_) => Ok(()),
                    Err(e2) => Err(format!(
                        "无法打开目录 '{}': explorer 失败 ({}), cmd 备用方案也失败 ({})",
                        open_path.display(),
                        e,
                        e2
                    )),
                }
            }
        }
    }
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn resolve_dropped_local_path(
    dropped_path: String,
) -> Result<DroppedLocalPathResult, String> {
    tokio::task::spawn_blocking(move || {
        let path = PathBuf::from(&dropped_path);
        let metadata =
            fs::metadata(&path).map_err(|e| format!("无法读取路径 '{}': {}", dropped_path, e))?;

        if metadata.is_dir() {
            let mut executables = ExecutableCandidates::None;
            for entry in fs::read_dir(&path).map_err(|e| format!("读取目录失败: {}", e))? {
                let entry = entry.map_err(|e| format!("读取目录项失败: {}", e))?;
                let entry_path = entry.path();
                if entry_path.is_file() && is_supported_local_executable(&entry_path) {
                    executables = executables.include(entry_path);
                    if matches!(&executables, ExecutableCandidates::Multiple) {
                        break;
                    }
                }
            }

            return Ok(match executables {
                ExecutableCandidates::None => DroppedLocalPathResult {
                    kind: DroppedLocalPathKind::NoExecutable,
                    path: None,
                    directory: Some(dropped_path),
                },
                ExecutableCandidates::One(executable) => DroppedLocalPathResult {
                    kind: DroppedLocalPathKind::SingleExecutable,
                    path: Some(executable.to_string_lossy().into_owned()),
                    directory: Some(dropped_path),
                },
                ExecutableCandidates::Multiple => DroppedLocalPathResult {
                    kind: DroppedLocalPathKind::MultipleExecutables,
                    path: None,
                    directory: Some(dropped_path),
                },
            });
        }

        if metadata.is_file() && is_supported_local_executable(&path) {
            return Ok(DroppedLocalPathResult {
                kind: DroppedLocalPathKind::Executable,
                path: Some(dropped_path),
                directory: path
                    .parent()
                    .filter(|parent| !parent.as_os_str().is_empty())
                    .map(|parent| parent.to_string_lossy().to_string()),
            });
        }

        Ok(DroppedLocalPathResult {
            kind: DroppedLocalPathKind::Invalid,
            path: None,
            directory: path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .map(|parent| parent.to_string_lossy().to_string()),
        })
    })
    .await
    .map_err(|e| format!("解析拖拽路径任务失败: {}", e))?
}

/// 判断当前是否为便携模式
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub fn is_portable_mode() -> PortableModeResult {
    PortableModeResult {
        is_portable: skerry_path::is_portable_mode(),
    }
}

// ==================== 数据迁移相关文件操作 ====================

static MOVE_FILE_STAGE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[cfg(windows)]
// Win32 FILE_ATTRIBUTE_REPARSE_POINT; mirrors the same file-system boundary used by legacy migration.
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

/// 创建与目标文件同目录的暂存目录，保证暂存文件最终可以通过 rename 安装。
fn create_move_file_staging_directory(destination: &Path) -> Result<PathBuf, String> {
    let parent = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));

    loop {
        let sequence = MOVE_FILE_STAGE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let staging_directory =
            parent.join(format!(".skerry-move-{}-{sequence}", std::process::id()));

        match fs::create_dir(&staging_directory) {
            Ok(()) => return Ok(staging_directory),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "创建文件移动暂存目录失败 {}: {}",
                    staging_directory.display(),
                    error
                ));
            }
        }
    }
}

/// 清理只包含本次临时副本的暂存目录；恢复失败时调用方会保留目录供恢复。
fn discard_move_file_staging_directory(staging_directory: &Path) {
    if let Err(error) = fs::remove_dir_all(staging_directory) {
        log::warn!(
            "文件移动失败后清理暂存目录失败 path={} error={}",
            staging_directory.display(),
            error
        );
    }
}

/// 完成同盘重命名失败后的复制迁移。
fn move_file_after_rename_failure(
    from: &Path,
    to: &Path,
    rename_error: io::Error,
) -> Result<(), String> {
    if to.is_dir() {
        return Err(format!(
            "文件移动目标已存在且不是文件 {}: {}",
            to.display(),
            rename_error
        ));
    }

    let staging_directory = create_move_file_staging_directory(to)?;
    let staged_file = staging_directory.join("incoming");
    let previous_file = staging_directory.join("previous");

    if let Err(copy_error) = fs::copy(from, &staged_file) {
        discard_move_file_staging_directory(&staging_directory);
        return Err(format!(
            "文件移动失败 {} -> {}；重命名失败: {}；复制源文件失败: {}",
            from.display(),
            to.display(),
            rename_error,
            copy_error
        ));
    }

    let destination_exists = match fs::symlink_metadata(to) {
        Ok(_) => true,
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => {
            discard_move_file_staging_directory(&staging_directory);
            return Err(format!("检查移动目标失败 {}: {}", to.display(), error));
        }
    };
    if destination_exists {
        if let Err(error) = fs::rename(to, &previous_file) {
            discard_move_file_staging_directory(&staging_directory);
            return Err(format!(
                "暂存新文件后无法保留原目标文件 {}: {}",
                to.display(),
                error
            ));
        }
    }

    if let Err(install_error) = fs::rename(&staged_file, to) {
        if destination_exists {
            if let Err(restore_error) = fs::rename(&previous_file, to) {
                return Err(format!(
                    "安装暂存文件失败 {}: {}；恢复原目标也失败: {}；原目标保留在 {}，源文件仍在 {}",
                    to.display(),
                    install_error,
                    restore_error,
                    previous_file.display(),
                    from.display()
                ));
            }
        }
        discard_move_file_staging_directory(&staging_directory);
        return Err(format!(
            "安装暂存文件失败 {}: {}；源文件仍在 {}",
            to.display(),
            install_error,
            from.display()
        ));
    }

    if let Err(source_remove_error) = fs::remove_file(from) {
        if let Err(target_remove_error) = fs::remove_file(to) {
            if destination_exists {
                return Err(format!(
                    "删除源文件失败 {}: {}；回滚新目标 {} 也失败: {}；原目标备份保留在 {}",
                    from.display(),
                    source_remove_error,
                    to.display(),
                    target_remove_error,
                    previous_file.display()
                ));
            }

            discard_move_file_staging_directory(&staging_directory);
            return Err(format!(
                "删除源文件失败 {}: {}；回滚新目标 {} 也失败: {}",
                from.display(),
                source_remove_error,
                to.display(),
                target_remove_error
            ));
        }

        if destination_exists {
            if let Err(restore_error) = fs::rename(&previous_file, to) {
                return Err(format!(
                    "删除源文件失败 {}: {}；恢复原目标失败: {}；原目标保留在 {}",
                    from.display(),
                    source_remove_error,
                    restore_error,
                    previous_file.display()
                ));
            }
        }

        discard_move_file_staging_directory(&staging_directory);
        return Err(format!(
            "删除源文件失败 {}: {}；已恢复原目标文件",
            from.display(),
            source_remove_error
        ));
    }

    if destination_exists {
        if let Err(error) = fs::remove_file(&previous_file) {
            return Err(format!(
                "文件已移动到 {}，但删除旧目标备份失败 {}: {}",
                to.display(),
                previous_file.display(),
                error
            ));
        }
    }

    if let Err(error) = fs::remove_dir(&staging_directory) {
        log::warn!(
            "文件已移动，但清理暂存目录失败 path={} error={}",
            staging_directory.display(),
            error
        );
    }

    log::debug!(
        "已移动文件(copy+remove): {} -> {}",
        from.display(),
        to.display()
    );
    Ok(())
}

/// 移动单个文件。
///
/// 先尝试同卷 rename；失败时先复制到目标旁的暂存位置，再替换目标并删除源文件。
/// 复制或安装失败时保留源文件；已有目标在复制完成前不会移除。
pub fn move_file(from: &Path, to: &Path) -> Result<(), String> {
    if !from.is_file() {
        return Err(format!("源文件不存在或不是文件: {}", from.display()));
    }

    if from == to
        || fs::canonicalize(from)
            .ok()
            .zip(fs::canonicalize(to).ok())
            .is_some_and(|(source, destination)| source == destination)
    {
        return Ok(());
    }

    if to.is_dir() {
        return Err(format!("移动目标已存在且不是文件: {}", to.display()));
    }

    if let Some(parent) = to.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        fs::create_dir_all(parent).map_err(|e| format!("创建目标目录失败: {}", e))?;
    }

    match fs::rename(from, to) {
        Ok(()) => {
            log::debug!("已移动文件(rename): {} -> {}", from.display(), to.display());
            Ok(())
        }
        Err(rename_error) => move_file_after_rename_failure(from, to, rename_error),
    }
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn copy_file(src: String, dst: String) -> Result<(), String> {
    let src_path = Path::new(&src);
    let dst_path = Path::new(&dst);

    if !src_path.exists() {
        return Err(format!("源文件不存在: {}", src));
    }

    if let Some(parent) = dst_path.parent()
        && !parent.exists()
    {
        fs::create_dir_all(parent).map_err(|e| format!("无法创建目标目录的父目录: {}", e))?;
    }
    fs::copy(src_path, dst_path).map_err(|e| format!("无法复制文件: {}", e))?;
    Ok(())
}

/// 判断指定文件是否存在。
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn file_exists(path: String) -> Result<bool, String> {
    Ok(Path::new(&path).is_file())
}

/// 将前端导入的图片字节写入应用媒体目录。
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn write_file_bytes(path: String, bytes: Vec<u8>) -> Result<(), String> {
    let target = Path::new(&path);
    if let Some(parent) = target.parent()
        && !parent.exists()
    {
        fs::create_dir_all(parent).map_err(|e| format!("无法创建目标目录: {}", e))?;
    }
    fs::write(target, bytes).map_err(|e| format!("无法写入文件: {}", e))?;
    Ok(())
}

/// 读取文件字节
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    tokio::fs::read(&path)
        .await
        .map_err(|e| format!("无法读取文件: {}", e))
}

/// 判断指定路径是否为目录
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn is_directory(path: String) -> Result<bool, String> {
    Ok(Path::new(&path).is_dir())
}

/// 遍历目录下的所有文件相对路径
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn list_directory_files(path: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || list_regular_files(&PathBuf::from(path)))
        .await
        .map_err(|error| format!("遍历目录失败: {error}"))?
}

fn list_regular_files(base: &Path) -> Result<Vec<String>, String> {
    if !base.is_dir() {
        return Err("指定路径不是目录".to_string());
    }
    let root_metadata = fs::symlink_metadata(base)
        .map_err(|error| format!("检查目录失败 {}: {error}", base.display()))?;
    if is_reparse_point(&root_metadata) {
        return Err(format!("指定路径不是普通目录: {}", base.display()));
    }

    let mut directories = vec![base.to_path_buf()];
    let mut files = Vec::new();
    while let Some(directory) = directories.pop() {
        let mut entries = fs::read_dir(&directory)
            .map_err(|error| format!("读取目录失败 {}: {error}", directory.display()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("读取目录项失败 {}: {error}", directory.display()))?;
        entries.sort_unstable_by_key(|entry| entry.file_name());

        for entry in entries {
            let entry_path = entry.path();
            let metadata = fs::symlink_metadata(&entry_path)
                .map_err(|error| format!("检查目录项失败 {}: {error}", entry_path.display()))?;
            if is_reparse_point(&metadata) {
                continue;
            }
            if metadata.is_dir() {
                directories.push(entry_path);
            } else if metadata.is_file() {
                let relative_path = entry_path.strip_prefix(base).map_err(|error| {
                    format!("解析相对文件路径失败 {}: {error}", entry_path.display())
                })?;
                files.push(relative_path.to_string_lossy().replace('\\', "/"));
            }
        }
    }

    files.sort_unstable_by(|left, right| {
        left.to_lowercase()
            .cmp(&right.to_lowercase())
            .then_with(|| left.cmp(right))
    });
    Ok(files)
}

fn is_reparse_point(metadata: &fs::Metadata) -> bool {
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

/// 删除文件
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn delete_file(file_path: String) -> Result<(), String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Ok(()); // 文件不存在，视为成功
    }

    fs::remove_file(path).map_err(|e| format!("无法删除文件: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod file_move_tests {
    use super::*;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            loop {
                let sequence = MOVE_FILE_STAGE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
                let path = std::env::temp_dir().join(format!(
                    "skerry-move-file-test-{}-{sequence}",
                    std::process::id()
                ));
                match fs::create_dir(&path) {
                    Ok(()) => return Self(path),
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(error) => panic!("test directory should be created: {error}"),
                }
            }
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn assert_no_move_staging_directory(&self) {
            let has_staging_directory = fs::read_dir(self.path())
                .expect("test directory should be readable")
                .filter_map(Result::ok)
                .any(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".skerry-move-")
                });
            assert!(
                !has_staging_directory,
                "move staging directory was left behind"
            );
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn recursive_file_listing_is_stable_and_uses_forward_slashes() {
        let directory = TestDirectory::new();
        fs::create_dir_all(directory.path().join("zeta")).unwrap();
        fs::create_dir_all(directory.path().join("Alpha")).unwrap();
        fs::write(directory.path().join("zeta/slot.sav"), b"save").unwrap();
        fs::write(directory.path().join("Alpha/info.json"), b"{}").unwrap();
        fs::write(directory.path().join("root.txt"), b"readme").unwrap();

        let files = list_regular_files(directory.path()).unwrap();

        assert_eq!(files, ["Alpha/info.json", "root.txt", "zeta/slot.sav"]);
    }

    #[test]
    fn recursive_file_listing_rejects_a_file_as_its_root() {
        let directory = TestDirectory::new();
        let file = directory.path().join("not-a-directory.txt");
        fs::write(&file, b"file").unwrap();

        assert_eq!(list_regular_files(&file).unwrap_err(), "指定路径不是目录");
    }

    #[tokio::test]
    async fn resolving_a_directory_with_one_executable_selects_that_file() {
        let directory = TestDirectory::new();
        let executable = directory.path().join("game.EXE");
        fs::write(&executable, b"test executable").expect("executable should be created");

        let result = resolve_dropped_local_path(directory.path().to_string_lossy().into_owned())
            .await
            .expect("directory should resolve");

        assert!(matches!(
            result.kind,
            DroppedLocalPathKind::SingleExecutable
        ));
        assert_eq!(
            result.path.as_deref(),
            Some(executable.to_string_lossy().as_ref())
        );
        assert_eq!(
            result.directory.as_deref(),
            Some(directory.path().to_string_lossy().as_ref())
        );
    }

    #[tokio::test]
    async fn resolving_a_directory_stops_as_multiple_after_two_executables() {
        let directory = TestDirectory::new();
        fs::write(directory.path().join("first.exe"), b"first")
            .expect("first executable should be created");
        fs::write(directory.path().join("second.cmd"), b"second")
            .expect("second executable should be created");

        let result = resolve_dropped_local_path(directory.path().to_string_lossy().into_owned())
            .await
            .expect("directory should resolve");

        assert!(matches!(
            result.kind,
            DroppedLocalPathKind::MultipleExecutables
        ));
        assert_eq!(result.path, None);
        assert_eq!(
            result.directory.as_deref(),
            Some(directory.path().to_string_lossy().as_ref())
        );
    }

    #[tokio::test]
    async fn resolving_a_directory_only_checks_direct_supported_files() {
        let directory = TestDirectory::new();
        fs::write(directory.path().join("readme.txt"), b"not executable")
            .expect("text file should be created");
        let nested = directory.path().join("nested");
        fs::create_dir(&nested).expect("nested directory should be created");
        fs::write(nested.join("game.exe"), b"nested executable")
            .expect("nested executable should be created");

        let result = resolve_dropped_local_path(directory.path().to_string_lossy().into_owned())
            .await
            .expect("directory should resolve");

        assert!(matches!(result.kind, DroppedLocalPathKind::NoExecutable));
        assert_eq!(result.path, None);
    }

    #[tokio::test]
    async fn resolving_a_supported_executable_file_keeps_its_parent_directory() {
        let directory = TestDirectory::new();
        let executable = directory.path().join("game.CmD");
        fs::write(&executable, b"test executable").expect("executable should be created");

        let result = resolve_dropped_local_path(executable.to_string_lossy().into_owned())
            .await
            .expect("executable should resolve");

        assert!(matches!(result.kind, DroppedLocalPathKind::Executable));
        assert_eq!(
            result.path.as_deref(),
            Some(executable.to_string_lossy().as_ref())
        );
        assert_eq!(
            result.directory.as_deref(),
            Some(directory.path().to_string_lossy().as_ref())
        );
    }

    #[tokio::test]
    async fn resolving_an_unsupported_file_is_invalid_but_retains_its_parent() {
        let directory = TestDirectory::new();
        let unsupported = directory.path().join("game.txt");
        fs::write(&unsupported, b"not executable").expect("text file should be created");

        let result = resolve_dropped_local_path(unsupported.to_string_lossy().into_owned())
            .await
            .expect("existing unsupported file should resolve as invalid");

        assert!(matches!(result.kind, DroppedLocalPathKind::Invalid));
        assert_eq!(result.path, None);
        assert_eq!(
            result.directory.as_deref(),
            Some(directory.path().to_string_lossy().as_ref())
        );
    }

    #[test]
    fn moving_to_an_existing_file_replaces_it_and_removes_the_source() {
        let directory = TestDirectory::new();
        let source = directory.path().join("source.png");
        let destination = directory.path().join("destination.png");
        fs::write(&source, b"new cover").expect("source should be created");
        fs::write(&destination, b"old cover").expect("destination should be created");

        move_file(&source, &destination).expect("file move should replace the destination");

        assert!(!source.exists());
        assert_eq!(fs::read(&destination).unwrap(), b"new cover");
        directory.assert_no_move_staging_directory();
    }

    #[test]
    fn copy_fallback_replaces_the_destination_only_after_staging_the_source() {
        let directory = TestDirectory::new();
        let source = directory.path().join("source.png");
        let destination = directory.path().join("destination.png");
        fs::write(&source, b"new cover").expect("source should be created");
        fs::write(&destination, b"old cover").expect("destination should be created");

        move_file_after_rename_failure(&source, &destination, io::Error::other("test fallback"))
            .expect("copy fallback should replace the destination");

        assert!(!source.exists());
        assert_eq!(fs::read(&destination).unwrap(), b"new cover");
        directory.assert_no_move_staging_directory();
    }

    #[test]
    fn copy_fallback_keeps_the_destination_when_the_source_cannot_be_copied() {
        let directory = TestDirectory::new();
        let missing_source = directory.path().join("missing.png");
        let destination = directory.path().join("destination.png");
        fs::write(&destination, b"existing cover").expect("destination should be created");

        let result = move_file_after_rename_failure(
            &missing_source,
            &destination,
            io::Error::other("test fallback"),
        );

        assert!(result.is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"existing cover");
        directory.assert_no_move_staging_directory();
    }

    #[test]
    fn moving_a_file_to_itself_keeps_it_in_place() {
        let directory = TestDirectory::new();
        let file = directory.path().join("cover.png");
        fs::write(&file, b"cover").expect("file should be created");

        move_file(&file, &file).expect("moving a file to itself should be a no-op");

        assert_eq!(fs::read(&file).unwrap(), b"cover");
        directory.assert_no_move_staging_directory();
    }

    #[test]
    fn a_directory_destination_does_not_remove_the_source_file() {
        let directory = TestDirectory::new();
        let source = directory.path().join("source.png");
        let destination = directory.path().join("destination");
        fs::write(&source, b"cover").expect("source should be created");
        fs::create_dir(&destination).expect("destination directory should be created");

        assert!(move_file(&source, &destination).is_err());

        assert_eq!(fs::read(&source).unwrap(), b"cover");
        assert!(destination.is_dir());
        directory.assert_no_move_staging_directory();
    }
}
