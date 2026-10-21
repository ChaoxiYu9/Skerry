//! Windows 进程枚举、路径归属、存活状态与终止 API。

use log::{debug, warn};
use std::{
    ffi::OsStr,
    os::windows::ffi::{OsStrExt, OsStringExt},
    path::{Component, Path, PathBuf},
};
use windows::Win32::{
    Foundation::{
        CloseHandle, ERROR_INSUFFICIENT_BUFFER, ERROR_INVALID_PARAMETER, ERROR_NO_MORE_FILES,
        HANDLE,
    },
    System::{
        Diagnostics::ToolHelp::{
            CREATE_TOOLHELP_SNAPSHOT_FLAGS, CreateToolhelp32Snapshot, PROCESSENTRY32W,
            Process32FirstW, Process32NextW,
        },
        Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
            PROCESS_TERMINATE, QueryFullProcessImageNameW, TerminateProcess,
        },
    },
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProcessOpenFailure {
    ProcessExited,
    Other,
}

fn classify_process_open_failure(error: &windows::core::Error) -> ProcessOpenFailure {
    if error.code() == windows::core::HRESULT::from_win32(ERROR_INVALID_PARAMETER.0) {
        ProcessOpenFailure::ProcessExited
    } else {
        ProcessOpenFailure::Other
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum ProcessImageLookupFailure {
    Exited,
    Unknown(String),
}

/// A path lookup failure is only an exited process after the same process handle confirms it.
fn observe_process_image_path(
    pid: u32,
    query_image_path: impl FnOnce() -> Result<PathBuf, String>,
    query_is_running: impl FnOnce() -> Result<bool, String>,
) -> Result<PathBuf, ProcessImageLookupFailure> {
    match query_image_path() {
        Ok(path) => Ok(path),
        Err(path_error) => match query_is_running() {
            Ok(false) => Err(ProcessImageLookupFailure::Exited),
            Ok(true) => Err(ProcessImageLookupFailure::Unknown(format!(
                "无法读取进程 {} 的映像路径: {}; 进程仍在运行",
                pid, path_error
            ))),
            Err(status_error) => Err(ProcessImageLookupFailure::Unknown(format!(
                "无法读取进程 {} 的映像路径: {}; 无法确认进程是否已退出: {}",
                pid, path_error, status_error
            ))),
        },
    }
}

fn process_image_open_failure(pid: u32, error: windows::core::Error) -> ProcessImageLookupFailure {
    match classify_process_open_failure(&error) {
        ProcessOpenFailure::ProcessExited => ProcessImageLookupFailure::Exited,
        ProcessOpenFailure::Other => ProcessImageLookupFailure::Unknown(format!(
            "无法打开进程 {} 并确认其映像: {}",
            pid, error
        )),
    }
}

fn termination_open_failure(pid: u32, error: windows::core::Error) -> Result<bool, String> {
    match classify_process_open_failure(&error) {
        ProcessOpenFailure::ProcessExited => Ok(false),
        ProcessOpenFailure::Other => Err(format!("无法打开候选进程 {}: {}", pid, error)),
    }
}

/// 判断路径是否与目录相同，或位于该目录树下。
///
/// 按 Windows 路径组件比较，ASCII 字母不区分大小写；组件边界避免把 `Game2`
/// 当成 `Game` 的子目录。带 `..` 的路径先按文件系统解析，避免把目录外的进程纳入停止范围。
pub(super) fn is_path_in_directory_tree(path: &Path, directory: &Path) -> bool {
    if path.as_os_str().is_empty() || directory.as_os_str().is_empty() {
        return false;
    }

    let contains_parent_reference = path
        .components()
        .chain(directory.components())
        .any(|component| matches!(component, Component::ParentDir));

    if contains_parent_reference {
        let (Ok(resolved_path), Ok(resolved_directory)) =
            (path.canonicalize(), directory.canonicalize())
        else {
            return false;
        };
        return has_directory_component_prefix(&resolved_path, &resolved_directory);
    }

    has_directory_component_prefix(path, directory)
}

fn has_directory_component_prefix(path: &Path, directory: &Path) -> bool {
    let directory_is_prefix_only =
        matches!(directory.components().next(), Some(Component::Prefix(_)))
            && directory.components().nth(1).is_none();
    let mut path_components = path.components();

    for directory_component in directory.components() {
        let Some(path_component) = path_components.next() else {
            return false;
        };

        if !components_match_ignore_ascii_case(path_component, directory_component) {
            return false;
        }
    }

    if directory_is_prefix_only {
        return matches!(path_components.next(), None | Some(Component::RootDir));
    }

    true
}

fn components_match_ignore_ascii_case(left: Component<'_>, right: Component<'_>) -> bool {
    match (left, right) {
        (Component::Prefix(left), Component::Prefix(right)) => {
            os_strs_match_ignore_ascii_case(left.as_os_str(), right.as_os_str())
        }
        (Component::RootDir, Component::RootDir)
        | (Component::CurDir, Component::CurDir)
        | (Component::ParentDir, Component::ParentDir) => true,
        (Component::Normal(left), Component::Normal(right)) => {
            os_strs_match_ignore_ascii_case(left, right)
        }
        _ => false,
    }
}

fn os_strs_match_ignore_ascii_case(left: &OsStr, right: &OsStr) -> bool {
    let mut left_units = left.encode_wide();
    let mut right_units = right.encode_wide();

    loop {
        match (left_units.next(), right_units.next()) {
            (Some(left_unit), Some(right_unit))
                if fold_ascii_case(left_unit) == fold_ascii_case(right_unit) => {}
            (None, None) => return true,
            _ => return false,
        }
    }
}

fn fold_ascii_case(unit: u16) -> u16 {
    let uppercase_a = u16::from(b'A');
    let uppercase_z = u16::from(b'Z');
    if (uppercase_a..=uppercase_z).contains(&unit) {
        unit + u16::from(b'a' - b'A')
    } else {
        unit
    }
}
// ============================================================================

pub(super) struct CandidateProcess<P> {
    process_id: u32,
    image: P,
}

impl<P> CandidateProcess<P> {
    pub(super) fn new(process_id: u32, image: P) -> Self {
        Self { process_id, image }
    }

    pub(super) fn process_id(&self) -> u32 {
        self.process_id
    }

    pub(super) fn image(&self) -> &P {
        &self.image
    }
}

/// 按快照顺序把完整 PID 迭代映射为游戏目录候选；枚举错误会丢弃本次局部结果。
/// Skerry PID 在查询映像路径前排除，避免无效 Win32 查询。
fn collect_candidate_processes<E, P: AsRef<Path>>(
    process_ids: impl IntoIterator<Item = Result<u32, E>>,
    manager_pid: u32,
    detection_dir: &Path,
    canonical_detection_dir: Option<&Path>,
    mut get_image_path: impl FnMut(u32) -> Option<P>,
) -> Result<Vec<CandidateProcess<P>>, E> {
    let mut candidates = Vec::new();

    for process_id in process_ids {
        let process_id = process_id?;
        if process_id == 0 || process_id == manager_pid {
            continue;
        }

        let Some(image_path) = get_image_path(process_id) else {
            continue;
        };
        let Some(process_dir) = image_path.as_ref().parent() else {
            continue;
        };

        let is_game_process = is_path_in_directory_tree(process_dir, detection_dir)
            || canonical_detection_dir
                .is_some_and(|canonical_dir| is_path_in_directory_tree(process_dir, canonical_dir));
        if is_game_process {
            candidates.push(CandidateProcess::new(process_id, image_path));
        }
    }

    Ok(candidates)
}

/// 仅 `ERROR_NO_MORE_FILES` 表示快照完整结束；其他 Win32 错误必须向扫描 owner 传播。
fn classify_process_snapshot_step(
    result: windows::core::Result<()>,
    process_id: u32,
) -> Result<Option<u32>, windows::core::Error> {
    match result {
        Ok(()) => Ok(Some(process_id)),
        Err(error) if error.code() == windows::core::HRESULT::from_win32(ERROR_NO_MORE_FILES.0) => {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

/// 使用 ToolHelp 的进程快照查找游戏目录及其子目录中的游戏进程。
///
/// 保留快照顺序以及同一进程映像 handle，使恢复选择可复核扫描命中的具体进程对象。
pub(super) fn get_all_candidate_processes(
    detection_dir: &str,
) -> Result<Vec<CandidateProcess<ProcessImage>>, String> {
    let target_dir = Path::new(detection_dir);
    if !target_dir.is_dir() {
        warn!("检测目录不存在或不是目录: {}", detection_dir);
        debug!(
            "未通过路径 '{}' 找到匹配的进程（已排除管理器）",
            detection_dir
        );
        return Ok(Vec::new());
    }

    // 保留配置路径，同时使用其物理路径兼容目录别名。
    let canonical_target_dir = std::fs::canonicalize(target_dir).ok();
    let manager_pid = std::process::id();

    let snapshot =
        unsafe { CreateToolhelp32Snapshot(CREATE_TOOLHELP_SNAPSHOT_FLAGS(0x00000002), 0) }
            .map_err(|error| format!("创建系统进程快照失败: {error}"))?;
    if snapshot.is_invalid() {
        return Err("创建系统进程快照返回无效句柄".to_string());
    }

    let mut entry = PROCESSENTRY32W {
        dwSize: u32::try_from(std::mem::size_of::<PROCESSENTRY32W>())
            .expect("PROCESSENTRY32W size must fit in Win32 DWORD"),
        ..Default::default()
    };
    let mut first_process = true;
    let candidate_processes_result = collect_candidate_processes(
        std::iter::from_fn(|| {
            let result = unsafe {
                if first_process {
                    first_process = false;
                    Process32FirstW(snapshot, &mut entry)
                } else {
                    Process32NextW(snapshot, &mut entry)
                }
            };
            match classify_process_snapshot_step(result, entry.th32ProcessID) {
                Ok(Some(process_id)) => Some(Ok(process_id)),
                Ok(None) => None,
                Err(error) => Some(Err(error)),
            }
        }),
        manager_pid,
        target_dir,
        canonical_target_dir.as_deref(),
        get_process_image,
    );
    let _ = unsafe { CloseHandle(snapshot) };
    let candidate_processes =
        candidate_processes_result.map_err(|error| format!("枚举系统进程失败: {error}"))?;
    let candidate_pids = candidate_processes
        .iter()
        .map(CandidateProcess::process_id)
        .collect::<Vec<_>>();
    debug!("找到进程目录下的进程 PID 列表: {:?}", candidate_pids);
    if candidate_pids.is_empty() {
        debug!(
            "未通过路径 '{}' 找到匹配的进程（已排除管理器）",
            detection_dir
        );
    } else {
        debug!(
            "找到 {} 个候选进程: {:?}",
            candidate_pids.len(),
            candidate_pids
        );
    }

    Ok(candidate_processes)
}

/// 只有在同一进程句柄确认映像仍属于游戏目录后，才终止该候选进程。
///
/// 路径查询、存活检查和终止使用同一个句柄，避免检查路径后 PID 被复用而误杀其他进程。
pub fn terminate_process_if_in_game_directory(
    pid: u32,
    game_directory: &Path,
) -> Result<bool, String> {
    unsafe {
        let access = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE;
        let handle = match OpenProcess(access, false, pid) {
            Ok(handle) => handle,
            Err(error) => return termination_open_failure(pid, error),
        };

        if handle.is_invalid() {
            return Err(format!("候选进程 {} 的句柄无效", pid));
        }

        let result = terminate_process_after_path_check(
            pid,
            game_directory,
            || {
                read_process_image_path(|buffer, size| {
                    QueryFullProcessImageNameW(
                        handle,
                        PROCESS_NAME_WIN32,
                        windows::core::PWSTR(buffer.as_mut_ptr()),
                        size,
                    )
                })
                .map_err(|error| error.to_string())
            },
            || query_process_is_running(handle).map_err(|error| error.to_string()),
            || {
                TerminateProcess(handle, 1)
                    .map_err(|error| format!("终止候选进程 {} 失败: {}", pid, error))
            },
        );
        CloseHandle(handle).ok();
        result
    }
}

fn terminate_process_after_path_check(
    pid: u32,
    game_directory: &Path,
    mut query_image_path: impl FnMut() -> Result<PathBuf, String>,
    mut is_running: impl FnMut() -> Result<bool, String>,
    mut terminate: impl FnMut() -> Result<(), String>,
) -> Result<bool, String> {
    let image_path = match observe_process_image_path(pid, &mut query_image_path, &mut is_running) {
        Ok(image_path) => image_path,
        Err(ProcessImageLookupFailure::Exited) => return Ok(false),
        Err(ProcessImageLookupFailure::Unknown(error)) => {
            return Err(format!("无法确认候选进程 {} 的目录归属: {}", pid, error));
        }
    };
    if !is_path_in_directory_tree(&image_path, game_directory) {
        return Err(format!("候选进程 {} 当前不属于此游戏目录，已拒绝终止", pid));
    }

    if !is_running().map_err(|error| format!("无法查询候选进程 {} 状态: {}", pid, error))?
    {
        return Ok(false);
    }

    match terminate() {
        Ok(()) => Ok(true),
        Err(termination_error) => match is_running() {
            Ok(false) => Ok(false),
            Ok(true) => Err(termination_error),
            Err(status_error) => Err(format!(
                "{}; 无法确认终止后的进程状态: {}",
                termination_error, status_error
            )),
        },
    }
}

fn query_process_is_running(handle: HANDLE) -> windows::core::Result<bool> {
    let mut exit_code = 0;
    unsafe { GetExitCodeProcess(handle, &mut exit_code).map(|()| exit_code == 259) }
}

/// 保持同一进程对象存活，供前台路径判断与状态提交共享进程身份。
pub(super) struct ProcessImage {
    handle: HANDLE,
    executable_path: PathBuf,
}

impl ProcessImage {
    pub(super) fn path(&self) -> &Path {
        &self.executable_path
    }

    /// `None` 表示 Win32 无法确认状态；调用方必须按未确认处理。
    pub(super) fn is_running(&self) -> Option<bool> {
        self.query_running().ok()
    }

    pub(super) fn query_running(&self) -> windows::core::Result<bool> {
        query_process_is_running(self.handle)
    }
}

impl AsRef<Path> for ProcessImage {
    fn as_ref(&self) -> &Path {
        self.path()
    }
}

impl Drop for ProcessImage {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.handle) };
    }
}

/// 打开一次进程映像观测；调用方持有返回值期间 PID 对应的进程对象不能被释放和复用。
pub(super) fn get_process_image(pid: u32) -> Option<ProcessImage> {
    get_process_image_for_monitoring(pid).ok()
}

pub(super) fn get_process_image_for_monitoring(
    pid: u32,
) -> Result<ProcessImage, ProcessImageLookupFailure> {
    use windows::core::PWSTR;

    unsafe {
        let handle = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(h) => h,
            Err(error) => return Err(process_image_open_failure(pid, error)),
        };

        if handle.is_invalid() {
            return Err(ProcessImageLookupFailure::Unknown(format!(
                "无法打开进程 {} 并确认其映像",
                pid
            )));
        }

        let image_path = observe_process_image_path(
            pid,
            || {
                read_process_image_path(|buffer, size| {
                    QueryFullProcessImageNameW(
                        handle,
                        PROCESS_NAME_WIN32,
                        PWSTR(buffer.as_mut_ptr()),
                        size,
                    )
                })
                .map_err(|error| error.to_string())
            },
            || query_process_is_running(handle).map_err(|error| error.to_string()),
        );
        let executable_path = match image_path {
            Ok(path) => path,
            Err(ProcessImageLookupFailure::Exited) => {
                let _ = CloseHandle(handle);
                return Err(ProcessImageLookupFailure::Exited);
            }
            Err(ProcessImageLookupFailure::Unknown(message)) => {
                let _ = CloseHandle(handle);
                debug!("获取进程 {} 的映像失败: {}", pid, message);
                return Err(ProcessImageLookupFailure::Unknown(message));
            }
        };

        Ok(ProcessImage {
            handle,
            executable_path,
        })
    }
}

const INITIAL_PROCESS_IMAGE_PATH_BUFFER_UNITS: usize = 1_024;

// The Win32 extended-path limit is approximately 32,767 characters; reserve one
// UTF-16 unit for the null terminator required by QueryFullProcessImageNameW.
const MAX_PROCESS_IMAGE_PATH_BUFFER_UNITS: usize = 32_768;

fn read_process_image_path(
    mut query: impl FnMut(&mut [u16], &mut u32) -> windows::core::Result<()>,
) -> Result<PathBuf, String> {
    let mut buffer = vec![0_u16; INITIAL_PROCESS_IMAGE_PATH_BUFFER_UNITS];

    loop {
        let mut path_length = u32::try_from(buffer.len())
            .map_err(|error| format!("映像路径缓冲区长度无效: {}", error))?;
        match query(&mut buffer, &mut path_length) {
            Ok(()) => {
                if path_length == 0 {
                    return Err("系统返回了空映像路径".to_string());
                }
                let path_length = usize::try_from(path_length)
                    .map_err(|error| format!("系统返回的映像路径长度无效: {}", error))?;
                let path_units = buffer
                    .get(..path_length)
                    .ok_or_else(|| "系统返回的映像路径长度超出接收缓冲区".to_string())?;
                return Ok(PathBuf::from(std::ffi::OsString::from_wide(path_units)));
            }
            Err(error)
                if error.code()
                    == windows::core::HRESULT::from_win32(ERROR_INSUFFICIENT_BUFFER.0) =>
            {
                let next_capacity = buffer
                    .len()
                    .checked_mul(2)
                    .ok_or_else(|| "映像路径缓冲区长度溢出".to_string())?
                    .min(MAX_PROCESS_IMAGE_PATH_BUFFER_UNITS);
                if next_capacity == buffer.len() {
                    return Err(format!(
                        "映像路径超过支持的长度上限 ({} 个 UTF-16 单元)",
                        MAX_PROCESS_IMAGE_PATH_BUFFER_UNITS
                    ));
                }
                buffer.resize(next_capacity, 0);
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CandidateProcess, INITIAL_PROCESS_IMAGE_PATH_BUFFER_UNITS,
        MAX_PROCESS_IMAGE_PATH_BUFFER_UNITS, ProcessImageLookupFailure, ProcessOpenFailure,
        classify_process_open_failure, classify_process_snapshot_step, collect_candidate_processes,
        is_path_in_directory_tree, observe_process_image_path, read_process_image_path,
        terminate_process_after_path_check, termination_open_failure,
    };
    use std::{
        cell::RefCell,
        os::windows::ffi::OsStrExt,
        path::{Path, PathBuf},
        sync::atomic::{AtomicUsize, Ordering},
    };
    use windows::{
        Win32::Foundation::{
            E_ACCESSDENIED, ERROR_INSUFFICIENT_BUFFER, ERROR_INVALID_PARAMETER, ERROR_NO_MORE_FILES,
        },
        core::{Error, HRESULT},
    };

    static NEXT_TEST_DIRECTORY: AtomicUsize = AtomicUsize::new(0);

    fn next_test_directory() -> PathBuf {
        let test_id = NEXT_TEST_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "skerry-monitor-path-{}-{test_id}",
            std::process::id()
        ))
    }

    fn snapshot_ids(
        process_ids: impl IntoIterator<Item = u32>,
    ) -> impl Iterator<Item = Result<u32, &'static str>> {
        process_ids.into_iter().map(Ok::<u32, &'static str>)
    }

    fn candidate_ids<E, P>(candidates: Result<Vec<CandidateProcess<P>>, E>) -> Result<Vec<u32>, E> {
        candidates.map(|candidates| {
            candidates
                .into_iter()
                .map(|candidate| candidate.process_id())
                .collect()
        })
    }

    #[test]
    fn candidate_scan_keeps_only_game_directory_processes_in_snapshot_order() {
        let candidates = collect_candidate_processes(
            snapshot_ids([17, 4, 11, 9]),
            999,
            Path::new(r"C:\Games\MyGame"),
            None,
            |pid| match pid {
                17 => Some(PathBuf::from(r"C:\Games\MyGame\bin\game.exe")),
                4 => Some(PathBuf::from(r"C:\Games\MyGame2\game.exe")),
                11 => Some(PathBuf::from(r"C:\Games\MyGame\game.exe")),
                9 => Some(PathBuf::from(r"D:\Games\MyGame\game.exe")),
                _ => None,
            },
        );

        assert_eq!(candidate_ids(candidates), Ok(vec![17, 11]));
    }

    #[test]
    fn candidate_scan_skips_manager_and_zero_pid_before_image_path_lookup() {
        let queried_pids = RefCell::new(Vec::new());
        let candidates = collect_candidate_processes(
            snapshot_ids([0, 12, 2, 3]),
            2,
            Path::new(r"C:\Games\MyGame"),
            None,
            |pid| {
                queried_pids.borrow_mut().push(pid);
                match pid {
                    3 => Some(PathBuf::from(r"C:\Games\MyGame\game.exe")),
                    _ => None,
                }
            },
        );

        assert_eq!(candidate_ids(candidates), Ok(vec![3]));
        assert_eq!(*queried_pids.borrow(), [12, 3]);
    }

    #[test]
    fn candidate_scan_accepts_a_complete_empty_snapshot() {
        let candidates = collect_candidate_processes(
            std::iter::empty::<Result<u32, &'static str>>(),
            999,
            Path::new(r"C:\Games\MyGame"),
            None,
            |_| None::<PathBuf>,
        );

        assert_eq!(candidate_ids(candidates), Ok(Vec::new()));
    }

    #[test]
    fn candidate_scan_does_not_publish_matches_before_snapshot_failure() {
        let queried_pids = RefCell::new(Vec::new());
        let process_ids = [Ok::<_, &'static str>(12), Err("snapshot read failed")];

        let result = collect_candidate_processes(
            process_ids,
            999,
            Path::new(r"C:\Games\MyGame"),
            None,
            |pid| {
                queried_pids.borrow_mut().push(pid);
                Some(PathBuf::from(r"C:\Games\MyGame\game.exe"))
            },
        );

        assert!(matches!(result, Err("snapshot read failed")));
        assert_eq!(*queried_pids.borrow(), [12]);
    }

    #[test]
    fn no_more_files_is_the_only_successful_snapshot_end_marker() {
        let end_of_snapshot = Error::from_hresult(HRESULT::from_win32(ERROR_NO_MORE_FILES.0));

        assert!(matches!(
            classify_process_snapshot_step(Err(end_of_snapshot), 12),
            Ok(None)
        ));
    }

    #[test]
    fn process_snapshot_api_failure_is_not_treated_as_end_of_snapshot() {
        let enumeration_failure = Error::from_hresult(E_ACCESSDENIED);

        assert!(matches!(
            classify_process_snapshot_step(Err(enumeration_failure), 12),
            Err(error) if error.code() == E_ACCESSDENIED
        ));
    }

    #[test]
    fn invalid_parameter_from_open_process_means_the_pid_has_exited() {
        let missing_process = Error::from_hresult(HRESULT::from_win32(ERROR_INVALID_PARAMETER.0));

        assert_eq!(
            classify_process_open_failure(&missing_process),
            ProcessOpenFailure::ProcessExited
        );
        assert_eq!(
            super::process_image_open_failure(42, missing_process),
            ProcessImageLookupFailure::Exited
        );
    }

    #[test]
    fn stopping_a_pid_that_no_longer_exists_is_already_successful() {
        let missing_process = Error::from_hresult(HRESULT::from_win32(ERROR_INVALID_PARAMETER.0));

        assert_eq!(termination_open_failure(42, missing_process), Ok(false));
    }

    #[test]
    fn access_denied_remains_a_real_stop_failure() {
        let access_denied = Error::from_hresult(E_ACCESSDENIED);

        assert!(matches!(
            termination_open_failure(42, access_denied),
            Err(message) if message.starts_with("无法打开候选进程 42: ")
        ));
    }

    #[test]
    fn candidate_scan_uses_canonical_detection_directory_as_fallback() {
        let candidates = collect_candidate_processes(
            snapshot_ids([21]),
            999,
            Path::new(r"C:\Games\Archive\..\MyGame"),
            Some(Path::new(r"C:\Games\MyGame")),
            |_| Some(PathBuf::from(r"C:\Games\MyGame\game.exe")),
        );

        assert_eq!(candidate_ids(candidates), Ok(vec![21]));
    }

    #[test]
    fn directory_itself_is_in_its_tree() {
        let directory = Path::new(r"C:\Games\MyGame");

        assert!(is_path_in_directory_tree(directory, directory));
    }

    #[test]
    fn descendant_matches_across_separator_and_ascii_case_differences() {
        let executable = Path::new(r"c:/games/MYGAME/bin/game.exe");
        let directory = Path::new(r"C:\Games\MyGame\");

        assert!(is_path_in_directory_tree(executable, directory));
    }

    #[test]
    fn similarly_named_sibling_is_outside_directory_tree() {
        let executable = Path::new(r"C:\Games\MyGame2\game.exe");
        let directory = Path::new(r"C:\Games\MyGame");

        assert!(!is_path_in_directory_tree(executable, directory));
    }

    #[test]
    fn another_drive_is_outside_directory_tree() {
        let executable = Path::new(r"D:\Games\MyGame\game.exe");
        let directory = Path::new(r"C:\Games\MyGame");

        assert!(!is_path_in_directory_tree(executable, directory));
    }

    #[test]
    fn drive_prefix_requires_a_path_boundary() {
        let drive_relative_executable = Path::new(r"C:Games\game.exe");
        let drive_prefix = Path::new(r"C:");
        let rooted_executable = Path::new(r"C:\Games\game.exe");

        assert!(!is_path_in_directory_tree(
            drive_relative_executable,
            drive_prefix
        ));
        assert!(is_path_in_directory_tree(rooted_executable, drive_prefix));
    }

    #[test]
    fn parent_segments_are_resolved_before_candidate_qualification() {
        let root = next_test_directory();
        let game_directory = root.join("MyGame");
        let sibling_directory = root.join("Sibling");
        std::fs::create_dir_all(game_directory.join("nested")).expect("create game directory");
        std::fs::create_dir_all(&sibling_directory).expect("create sibling directory");
        let game_executable = game_directory.join("game.exe");
        let sibling_executable = sibling_directory.join("game.exe");
        std::fs::write(&game_executable, []).expect("create game executable fixture");
        std::fs::write(&sibling_executable, []).expect("create sibling executable fixture");

        let in_tree_path = game_directory.join("nested").join("..").join("game.exe");
        let escaped_path = game_directory.join("..").join("Sibling").join("game.exe");

        assert!(is_path_in_directory_tree(&in_tree_path, &game_directory));
        assert!(!is_path_in_directory_tree(&escaped_path, &game_directory));

        std::fs::remove_dir_all(root).expect("remove test directory");
    }

    fn insufficient_buffer_error() -> Error {
        Error::from_hresult(HRESULT::from_win32(ERROR_INSUFFICIENT_BUFFER.0))
    }

    #[test]
    fn retries_a_long_process_path_and_preserves_its_utf16_value() {
        let mut components = (0..12)
            .map(|index| format!("folder{index}-{}", "a".repeat(100)))
            .collect::<Vec<_>>();
        components.push("游戏".to_string());
        let mut expected_path = PathBuf::from(r"C:\Games");
        for component in components {
            expected_path.push(component);
        }
        expected_path.push("game.exe");
        let expected_units = expected_path.as_os_str().encode_wide().collect::<Vec<_>>();
        let mut attempted_capacities = Vec::new();

        let actual_path = read_process_image_path(|buffer, path_length| {
            attempted_capacities.push(buffer.len());
            if expected_units.len() >= buffer.len() {
                return Err(insufficient_buffer_error());
            }

            buffer[..expected_units.len()].copy_from_slice(&expected_units);
            buffer[expected_units.len()] = 0;
            *path_length = u32::try_from(expected_units.len()).expect("fixture fits a Win32 DWORD");
            Ok(())
        })
        .expect("long image path should be retried and returned");

        assert_eq!(actual_path, expected_path);
        assert_eq!(
            attempted_capacities,
            [
                INITIAL_PROCESS_IMAGE_PATH_BUFFER_UNITS,
                INITIAL_PROCESS_IMAGE_PATH_BUFFER_UNITS * 2
            ]
        );
    }

    #[test]
    fn stops_at_the_supported_extended_path_buffer_limit() {
        let mut attempted_capacities = Vec::new();

        let path = read_process_image_path(|buffer, _| {
            attempted_capacities.push(buffer.len());
            Err(insufficient_buffer_error())
        });

        assert!(path.is_err());
        assert_eq!(
            attempted_capacities.last(),
            Some(&MAX_PROCESS_IMAGE_PATH_BUFFER_UNITS)
        );
        assert!(
            attempted_capacities
                .windows(2)
                .all(|pair| pair[1] > pair[0])
        );
    }

    #[test]
    fn does_not_retry_process_image_access_denied() {
        let mut attempts = 0;

        let path = read_process_image_path(|_, _| {
            attempts += 1;
            Err(Error::from_hresult(E_ACCESSDENIED))
        });

        assert!(path.is_err());
        assert_eq!(attempts, 1);
    }

    #[test]
    fn failed_image_lookup_is_an_exit_only_when_the_same_process_is_not_running() {
        use std::cell::RefCell;

        let operations = RefCell::new(Vec::new());
        let result = observe_process_image_path(
            42,
            || {
                operations.borrow_mut().push("image");
                Err("QueryFullProcessImageNameW failed".to_string())
            },
            || {
                operations.borrow_mut().push("liveness");
                Ok(false)
            },
        );

        assert_eq!(result, Err(ProcessImageLookupFailure::Exited));
        assert_eq!(operations.into_inner(), ["image", "liveness"]);
    }

    #[test]
    fn failed_image_lookup_keeps_a_live_process_unresolved() {
        let result =
            observe_process_image_path(42, || Err("access denied".to_string()), || Ok(true));

        assert_eq!(
            result,
            Err(ProcessImageLookupFailure::Unknown(
                "无法读取进程 42 的映像路径: access denied; 进程仍在运行".to_string()
            ))
        );
    }

    #[test]
    fn failed_image_and_liveness_queries_preserve_both_errors() {
        let result = observe_process_image_path(
            42,
            || Err("image query failed".to_string()),
            || Err("status query failed".to_string()),
        );

        assert_eq!(
            result,
            Err(ProcessImageLookupFailure::Unknown(
                "无法读取进程 42 的映像路径: image query failed; 无法确认进程是否已退出: status query failed"
                    .to_string()
            ))
        );
    }

    #[test]
    fn stopping_an_exited_candidate_after_path_failure_is_successful() {
        use std::cell::RefCell;

        let operations = RefCell::new(Vec::new());
        let result = terminate_process_after_path_check(
            42,
            Path::new(r"C:\Games\Example"),
            || {
                operations.borrow_mut().push("image");
                Err("process image is unavailable".to_string())
            },
            || {
                operations.borrow_mut().push("liveness");
                Ok(false)
            },
            || {
                operations.borrow_mut().push("terminate");
                panic!("an exited process must not be terminated")
            },
        );

        assert_eq!(result, Ok(false));
        assert_eq!(operations.into_inner(), ["image", "liveness"]);
    }

    #[test]
    fn stopping_a_live_candidate_with_unreadable_path_remains_refused() {
        use std::cell::RefCell;

        let operations = RefCell::new(Vec::new());
        let result = terminate_process_after_path_check(
            42,
            Path::new(r"C:\Games\Example"),
            || {
                operations.borrow_mut().push("image");
                Err("access denied".to_string())
            },
            || {
                operations.borrow_mut().push("liveness");
                Ok(true)
            },
            || {
                operations.borrow_mut().push("terminate");
                Ok(())
            },
        );

        assert!(matches!(
            result,
            Err(message)
                if message.contains("无法确认候选进程 42 的目录归属")
                    && message.contains("access denied")
                    && message.contains("进程仍在运行")
        ));
        assert_eq!(operations.into_inner(), ["image", "liveness"]);
    }

    #[test]
    fn reused_pid_outside_game_directory_is_not_terminated() {
        let mut termination_attempted = false;

        let result = terminate_process_after_path_check(
            42,
            Path::new(r"C:\Games\Example"),
            || Ok(PathBuf::from(r"C:\Tools\other.exe")),
            || panic!("a path mismatch must stop before querying termination state"),
            || {
                termination_attempted = true;
                Ok(())
            },
        );

        assert_eq!(
            result,
            Err("候选进程 42 当前不属于此游戏目录，已拒绝终止".to_string())
        );
        assert!(!termination_attempted);
    }

    #[test]
    fn matching_process_is_terminated_only_after_path_and_liveness_checks() {
        use std::cell::RefCell;

        let operations = RefCell::new(Vec::new());

        let result = terminate_process_after_path_check(
            42,
            Path::new(r"C:\Games\Example"),
            || {
                operations.borrow_mut().push("image");
                Ok(PathBuf::from(r"C:\Games\Example\game.exe"))
            },
            || {
                operations.borrow_mut().push("liveness");
                Ok(true)
            },
            || {
                operations.borrow_mut().push("terminate");
                Ok(())
            },
        );

        assert_eq!(result, Ok(true));
        assert_eq!(operations.into_inner(), ["image", "liveness", "terminate"]);
    }

    #[test]
    fn process_exit_during_failed_termination_is_not_reported_as_failure() {
        use std::cell::RefCell;

        let operations = RefCell::new(Vec::new());
        let mut liveness_checks = 0;

        let result = terminate_process_after_path_check(
            42,
            Path::new(r"C:\Games\Example"),
            || {
                operations.borrow_mut().push("image");
                Ok(PathBuf::from(r"C:\Games\Example\game.exe"))
            },
            || {
                operations.borrow_mut().push("liveness");
                liveness_checks += 1;
                Ok(liveness_checks == 1)
            },
            || {
                operations.borrow_mut().push("terminate");
                Err("termination raced with process exit".to_string())
            },
        );

        assert_eq!(result, Ok(false));
        assert_eq!(
            operations.into_inner(),
            ["image", "liveness", "terminate", "liveness"]
        );
    }
}
