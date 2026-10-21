//! Skerry's application data and portable-mode path contract.
//!
//! Installed mode keeps data under the platform data directory and the stable
//! `local.skerry.app` identifier. Portable mode keeps it beside the executable
//! in `resources/`. These locations are persisted user-data behavior; changing
//! them requires a separate migration plan.

use std::path::{Path, PathBuf};

/// 数据库相关路径常量
pub const DB_DATA_DIR: &str = "data";
pub const DB_FILE_NAME: &str = "skerry.db";

// 基础数据目录下的子目录名称
pub const BACKUP_SUBDIR: &str = "backups";
pub const RESOURCE_DIR: &str = "resources";
const APP_DATA_DIRECTORY: &str = "local.skerry.app";

#[derive(Debug, PartialEq, Eq)]
enum BaseDataLocation {
    Portable(PathBuf),
    Installed(PathBuf),
}

fn portable_base_data_dir(executable_path: &Path) -> Result<PathBuf, String> {
    let executable_dir = executable_path
        .parent()
        .ok_or_else(|| "无法获取可执行文件父目录".to_string())?;
    Ok(executable_dir.join(RESOURCE_DIR))
}

fn marked_portable_base_data_dir(executable_path: &Path) -> Option<PathBuf> {
    let base_dir = portable_base_data_dir(executable_path).ok()?;
    base_dir.join(DB_DATA_DIR).is_dir().then_some(base_dir)
}

fn installed_base_data_dir() -> Result<PathBuf, String> {
    use directories::BaseDirs;

    let base_dirs = BaseDirs::new().ok_or_else(|| "无法获取系统目录信息".to_string())?;
    Ok(base_dirs.data_dir().join(APP_DATA_DIRECTORY))
}

fn resolve_base_data_location(
    executable_path: Option<&Path>,
    installed_location: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<BaseDataLocation, String> {
    if let Some(base_dir) = executable_path.and_then(marked_portable_base_data_dir) {
        return Ok(BaseDataLocation::Portable(base_dir));
    }

    installed_location().map(BaseDataLocation::Installed)
}

fn materialize_base_data_location(location: BaseDataLocation) -> Result<PathBuf, String> {
    match location {
        BaseDataLocation::Portable(base_dir) => Ok(base_dir),
        BaseDataLocation::Installed(base_dir) => {
            std::fs::create_dir_all(&base_dir).map_err(|error| {
                format!("无法创建系统数据目录 {}: {}", base_dir.display(), error)
            })?;
            Ok(base_dir)
        }
    }
}

/// 判断是否处于便携模式（纯 Rust 版本）
///
/// 检测逻辑：检查可执行文件同级目录下是否存在 resources/data 目录。
pub fn is_portable_mode() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|executable_path| marked_portable_base_data_dir(&executable_path))
        .is_some()
}

/// 获取基础数据根目录。
///
/// 该目录是应用非数据库资源的统一根目录：
/// - 便携模式: `<exe>/resources`
/// - 安装模式: `<system-data>/<identifier>`
///
/// 数据库属于该根目录下的专用子目录 `<base>/data`，不要把本函数当作数据库目录使用。
pub fn get_base_data_dir() -> Result<PathBuf, String> {
    let executable_path = std::env::current_exe().ok();
    let location = resolve_base_data_location(executable_path.as_deref(), installed_base_data_dir)?;
    materialize_base_data_location(location)
}

/// 获取指定模式下的基础数据根目录。
///
/// 返回值语义与 `get_base_data_dir` 一致：
/// - 便携模式: `<exe>/resources`
/// - 安装模式: `<system-data>/<identifier>`
pub fn get_base_data_dir_for_mode(portable: bool) -> Result<PathBuf, String> {
    if portable {
        let executable_path =
            std::env::current_exe().map_err(|e| format!("无法获取可执行文件路径: {}", e))?;
        portable_base_data_dir(&executable_path)
    } else {
        installed_base_data_dir()
    }
}

/// 获取数据库专用目录 `<base>/data`。
pub fn get_db_data_dir() -> Result<PathBuf, String> {
    Ok(get_base_data_dir()?.join(DB_DATA_DIR))
}

/// 获取指定模式下的数据库专用目录 `<base>/data`。
pub fn get_db_data_dir_for_mode(portable: bool) -> Result<PathBuf, String> {
    Ok(get_base_data_dir_for_mode(portable)?.join(DB_DATA_DIR))
}

/// 获取数据库文件路径 `<base>/data/skerry.db`。
pub fn get_db_path() -> Result<PathBuf, String> {
    Ok(get_db_data_dir()?.join(DB_FILE_NAME))
}

/// 获取默认的数据库备份路径
pub fn get_default_db_backup_path() -> Result<PathBuf, String> {
    Ok(get_db_data_dir()?.join(BACKUP_SUBDIR))
}

/// 获取默认的存档备份路径
pub fn get_default_savedata_backup_path() -> Result<PathBuf, String> {
    Ok(get_base_data_dir()?.join(BACKUP_SUBDIR))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEMP_DIR: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            loop {
                let id = NEXT_TEMP_DIR.fetch_add(1, Ordering::Relaxed);
                let path =
                    std::env::temp_dir().join(format!("skerry-path-{}-{id}", std::process::id()));
                match std::fs::create_dir(&path) {
                    Ok(()) => return Self(path),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(error) => panic!("create test directory: {error}"),
                }
            }
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn executable_path(root: &Path) -> PathBuf {
        root.join("bin").join("skerry.exe")
    }

    #[test]
    fn marked_portable_location_uses_resource_root_without_resolving_installed_path() {
        let root = TestDirectory::new();
        let executable_path = executable_path(&root.0);
        let portable_data_dir = root.0.join("bin").join(RESOURCE_DIR).join(DB_DATA_DIR);
        std::fs::create_dir_all(&portable_data_dir).expect("create portable marker");

        let location = resolve_base_data_location(Some(&executable_path), || {
            panic!("installed location must stay lazy in portable mode")
        })
        .expect("resolve portable location");

        assert_eq!(
            location,
            BaseDataLocation::Portable(root.0.join("bin").join(RESOURCE_DIR))
        );
    }

    #[test]
    fn missing_portable_marker_uses_installed_location_once() {
        let root = TestDirectory::new();
        let executable_path = executable_path(&root.0);
        let installed_dir = root.0.join("installed");
        let calls = Cell::new(0);

        let location = resolve_base_data_location(Some(&executable_path), || {
            calls.set(calls.get() + 1);
            Ok(installed_dir.clone())
        })
        .expect("resolve installed location");

        assert_eq!(calls.get(), 1);
        assert_eq!(location, BaseDataLocation::Installed(installed_dir));
    }

    #[test]
    fn unavailable_executable_uses_installed_location() {
        let root = TestDirectory::new();
        let installed_dir = root.0.join("installed");

        let location = resolve_base_data_location(None, || Ok(installed_dir.clone()))
            .expect("resolve installed location without executable path");

        assert_eq!(location, BaseDataLocation::Installed(installed_dir));
    }

    #[test]
    fn installed_location_is_created_while_portable_location_is_returned_unchanged() {
        let root = TestDirectory::new();
        let installed_dir = root.0.join("installed");
        let result =
            materialize_base_data_location(BaseDataLocation::Installed(installed_dir.clone()))
                .expect("create installed location");

        assert_eq!(result, installed_dir);
        assert!(result.is_dir());

        let portable_dir = root.0.join("portable").join(RESOURCE_DIR);
        let result =
            materialize_base_data_location(BaseDataLocation::Portable(portable_dir.clone()))
                .expect("return portable location");

        assert_eq!(result, portable_dir);
        assert!(!result.exists());
    }

    #[test]
    fn explicit_portable_base_does_not_require_the_detection_marker() {
        let root = TestDirectory::new();
        let executable_path = executable_path(&root.0);

        assert_eq!(
            portable_base_data_dir(&executable_path).expect("resolve explicit portable base"),
            root.0.join("bin").join(RESOURCE_DIR)
        );
        assert!(!root
            .0
            .join("bin")
            .join(RESOURCE_DIR)
            .join(DB_DATA_DIR)
            .exists());
    }
}
