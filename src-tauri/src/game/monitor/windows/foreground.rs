//! Windows 前台窗口轮询与游戏会话焦点状态更新。

use super::MonitorState;
use super::processes::{ProcessImage, get_process_image, is_path_in_directory_tree};
use log::{debug, info};
use parking_lot::RwLock;
#[cfg(test)]
use std::path::PathBuf;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::{
    path::Path,
    time::{Duration, Instant},
};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

/// Hook 线程守卫，确保线程在任何退出情况下都能正确停止
///
/// 使用 RAII 模式，在析构时自动发送停止信号
pub(super) struct HookGuard {
    stop_signal: Arc<AtomicBool>,
}

#[derive(Default)]
pub(super) struct ForegroundPathProbe {
    unresolved: Option<UnresolvedForegroundPid>,
}

pub(super) trait ForegroundProcessObservation {
    fn executable_path(&self) -> &Path;
    fn is_running(&self) -> Option<bool>;
}

impl ForegroundProcessObservation for ProcessImage {
    fn executable_path(&self) -> &Path {
        self.path()
    }

    fn is_running(&self) -> Option<bool> {
        ProcessImage::is_running(self)
    }
}

#[cfg(test)]
impl ForegroundProcessObservation for PathBuf {
    fn executable_path(&self) -> &Path {
        self
    }

    fn is_running(&self) -> Option<bool> {
        Some(true)
    }
}

struct UnresolvedForegroundPid {
    pid: u32,
    last_checked_at: Instant,
}

impl ForegroundPathProbe {
    fn should_check(&self, pid: u32, observed_at: Instant) -> bool {
        self.unresolved.as_ref().is_none_or(|cached| {
            cached.pid != pid
                || observed_at.duration_since(cached.last_checked_at)
                    >= Duration::from_secs(super::MONITOR_CHECK_INTERVAL_SECS)
        })
    }

    pub(super) fn remember_unresolved(&mut self, pid: u32, observed_at: Instant) {
        self.unresolved = Some(UnresolvedForegroundPid {
            pid,
            last_checked_at: observed_at,
        });
    }

    fn clear(&mut self) {
        self.unresolved = None;
    }

    #[cfg(test)]
    pub(super) fn is_empty(&self) -> bool {
        self.unresolved.is_none()
    }
}

impl HookGuard {
    pub(super) fn new(stop_signal: Arc<AtomicBool>) -> Self {
        Self { stop_signal }
    }
}

impl Drop for HookGuard {
    fn drop(&mut self) {
        // 无论函数如何退出（正常返回、?, panic 等），都会触发停止信号
        self.stop_signal.store(true, Ordering::Release);
        debug!("HookGuard 析构：已发送停止信号");
    }
}

// ============================================================================
// Hook 线程 - 前台窗口监听
// ============================================================================

/// 启动前台窗口变化的 Hook 线程（Windows 平台）
///
/// 使用 tokio::task::spawn_blocking 在阻塞线程池中运行，与 Tokio 运行时统一管理。
///
/// # Arguments
/// * `state` - 线程安全的共享监控状态
/// * `candidate_pids` - 共享的候选 PID 列表
/// * `game_directory` - 游戏目录路径，用于检测逃逸进程（Steam 启动等场景）
/// * `app_handle` - Tauri 应用句柄，用于发送进程切换事件
/// * `game_id` - 游戏 ID
/// * `stop_signal` - 停止信号，用于通知线程停止运行
///
/// # Hook 逻辑
/// 1. 每 200ms 检查一次前台窗口
/// 2. 获取前台窗口的 PID
/// 3. 检查已知 PID 的当前映像是否仍在游戏目录下
/// 4. 对未知 PID 检查可执行文件路径，并将符合目录约束的逃逸进程纳入候选
/// 5. 向共享状态转换器提交前台观测，并将逃逸进程加入候选列表
pub(super) fn start_foreground_hook(
    state: Arc<RwLock<MonitorState>>,
    game_directory: String,
    stop_signal: Arc<AtomicBool>,
) {
    // 使用 tokio::task::spawn_blocking 统一运行时管理
    tokio::task::spawn_blocking(move || {
        debug!("前台窗口 Hook 线程已启动");

        let mut path_probe = ForegroundPathProbe::default();

        // 保留配置路径，并缓存物理路径以识别目录别名。
        let game_directory_path = Path::new(&game_directory);
        let canonical_game_dir = game_directory_path.canonicalize().ok();

        // 主循环：检查停止信号
        while !stop_signal.load(Ordering::Acquire) {
            // 200ms 检查一次，平衡响应速度和性能
            std::thread::sleep(Duration::from_millis(200));

            update_foreground_state(
                &state,
                game_directory_path,
                canonical_game_dir.as_deref(),
                &mut path_probe,
                get_foreground_pid(),
                get_process_image,
            );
        }

        debug!("前台窗口 Hook 线程已停止");
    });
}

/// 获取当前前台窗口所属的进程 PID。
pub(super) fn get_foreground_pid() -> Option<u32> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }

        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        (pid != 0).then_some(pid)
    }
}

/// 根据当前前台 PID 更新单个游戏会话的状态。
pub(super) fn update_foreground_state<P: ForegroundProcessObservation>(
    state: &RwLock<MonitorState>,
    game_directory: &Path,
    canonical_game_dir: Option<&Path>,
    path_probe: &mut ForegroundPathProbe,
    foreground_pid: Option<u32>,
    mut process_image_for_pid: impl FnMut(u32) -> Option<P>,
) {
    let Some(new_pid) = foreground_pid else {
        // 无有效窗口时失效负向查询缓存，确保同一 PID 恢复后会重新判断。
        path_probe.clear();
        state.write().apply(super::MonitorEvent::NoGameForeground);
        return;
    };

    // Candidate membership and lifecycle state share one lock; release it before
    // querying Win32 so a slow image lookup cannot block recovery or stop.
    if state.read().contains_candidate(new_pid) {
        path_probe.clear();
        let Some(process_image) = process_image_for_pid(new_pid) else {
            // 暂时无法确认映像时，不计入前台时间；保留候选，下一轮重试。
            state.write().apply(super::MonitorEvent::NoGameForeground);
            return;
        };
        if process_image.is_running() != Some(true) {
            // PID 已退出或状态未知时，不把残留前台窗口计入游戏时间；保留候选供后续恢复检查。
            state.write().apply(super::MonitorEvent::NoGameForeground);
            return;
        }
        let exe_path = process_image.executable_path();
        if !is_path_in_directory_tree(exe_path, game_directory)
            && !canonical_game_dir.is_some_and(|canonical_game_dir| {
                is_path_in_directory_tree(exe_path, canonical_game_dir)
            })
        {
            // 候选集合保存的是 PID 而非进程句柄。每次观察已知前台 PID 时重新核对
            // 当前映像，避免 PID 被复用后继续被当作原游戏进程。
            let mut session = state.write();
            session.remove_candidate(new_pid);
            session.apply(super::MonitorEvent::CandidateInvalidated(new_pid));
            path_probe.clear();
            return;
        }

        let mut session = state.write();
        session.insert_candidate(new_pid);
        let previous_pid = session.snapshot().best_pid;
        session.apply(super::MonitorEvent::GameForeground(new_pid));
        drop(session);
        if previous_pid != new_pid {
            debug!("前台窗口切换到已知游戏进程: PID {}", new_pid);
        }
        return;
    }
    // 对未登记 PID 按监控周期重复确认：一次暂时不可查的映像不能永久阻止游戏被发现。
    let observed_at = Instant::now();
    if !path_probe.should_check(new_pid, observed_at) {
        return;
    }

    let matching_executable = process_image_for_pid(new_pid).filter(|process_image| {
        process_image.is_running() == Some(true)
            && (is_path_in_directory_tree(process_image.executable_path(), game_directory)
                || canonical_game_dir.is_some_and(|canonical_game_dir| {
                    is_path_in_directory_tree(process_image.executable_path(), canonical_game_dir)
                }))
    });

    if let Some(process_image) = matching_executable {
        info!(
            "检测到新的游戏进程（逃逸）: PID {}, 路径: {}",
            new_pid,
            process_image.executable_path().display()
        );
        // Candidate membership and foreground state commit through one session owner.
        let mut session = state.write();
        session.insert_candidate(new_pid);
        path_probe.clear();
        session.apply(super::MonitorEvent::GameForeground(new_pid));
        return;
    }

    // A scan or recovery may have admitted this PID while its image path was being
    // queried. Recheck and submit the resulting state event under the session owner.
    let mut session = state.write();
    let became_candidate_during_lookup = session.contains_candidate(new_pid);
    if became_candidate_during_lookup {
        path_probe.clear();
    } else {
        path_probe.remember_unresolved(new_pid, observed_at);
    }
    // Admission during a failed image lookup is not enough to identify the current
    // process. The next hook observation revalidates the now-known candidate.
    session.apply(super::MonitorEvent::NoGameForeground);
}

#[cfg(test)]
mod tests {
    use super::super::{MonitorEvent, MonitorPhase, MonitorState};
    use super::{ForegroundPathProbe, ForegroundProcessObservation, update_foreground_state};
    use parking_lot::RwLock;
    use std::{
        collections::HashSet,
        path::{Path, PathBuf},
        time::{Duration, Instant},
    };

    struct TestProcessImage {
        path: PathBuf,
        running: Option<bool>,
        on_drop: Option<Box<dyn FnOnce()>>,
    }

    impl ForegroundProcessObservation for TestProcessImage {
        fn executable_path(&self) -> &Path {
            &self.path
        }

        fn is_running(&self) -> Option<bool> {
            self.running
        }
    }

    impl Drop for TestProcessImage {
        fn drop(&mut self) {
            if let Some(on_drop) = self.on_drop.take() {
                on_drop();
            }
        }
    }

    #[test]
    fn unresolved_foreground_pid_is_rechecked_on_the_monitor_cadence() {
        let observed_at = Instant::now();
        let mut probe = ForegroundPathProbe::default();

        assert!(probe.should_check(42, observed_at));
        probe.remember_unresolved(42, observed_at);

        assert!(!probe.should_check(42, observed_at + Duration::from_millis(999)));
        assert!(probe.should_check(42, observed_at + Duration::from_secs(1)));
        assert!(probe.should_check(43, observed_at + Duration::from_millis(200)));

        probe.clear();
        assert!(probe.should_check(42, observed_at + Duration::from_millis(200)));
    }

    #[test]
    fn exited_or_unconfirmed_process_is_not_admitted_as_a_foreground_game() {
        for running in [Some(false), None] {
            let mut initial_state = MonitorState::new(10, HashSet::from([10]));
            initial_state.apply(MonitorEvent::GameForeground(10));
            let state = RwLock::new(initial_state);
            let mut path_probe = ForegroundPathProbe::default();

            update_foreground_state(
                &state,
                Path::new(r"C:\Games\Example"),
                None,
                &mut path_probe,
                Some(20),
                |_| {
                    Some(TestProcessImage {
                        path: PathBuf::from(r"C:\Games\Example\game.exe"),
                        running,
                        on_drop: None,
                    })
                },
            );

            let snapshot = state.read().snapshot();
            assert_eq!(state.read().candidate_pids, HashSet::from([10]));
            assert_eq!(snapshot.phase, MonitorPhase::Background);
            assert_eq!(snapshot.best_pid, 10);
            assert!(!path_probe.is_empty());
        }
    }

    #[test]
    fn process_observation_lives_until_foreground_state_is_committed() {
        let mut initial_state = MonitorState::new(10, HashSet::from([10]));
        initial_state.apply(MonitorEvent::GameForeground(10));
        let state = std::sync::Arc::new(RwLock::new(initial_state));
        let mut path_probe = ForegroundPathProbe::default();
        let state_at_drop = state.clone();

        update_foreground_state(
            &state,
            Path::new(r"C:\Games\Example"),
            None,
            &mut path_probe,
            Some(20),
            move |_| {
                let state_at_drop = state_at_drop.clone();
                Some(TestProcessImage {
                    path: PathBuf::from(r"C:\Games\Example\escaped.exe"),
                    running: Some(true),
                    on_drop: Some(Box::new(move || {
                        let committed = state_at_drop.read();
                        assert!(committed.contains_candidate(20));
                        assert_eq!(committed.snapshot().phase, MonitorPhase::Foreground);
                        assert_eq!(committed.snapshot().best_pid, 20);
                    })),
                })
            },
        );

        assert!(state.read().snapshot().is_foreground());
    }
}

// ============================================================================
// 进程管理 - 进程查询与检测
// ============================================================================
