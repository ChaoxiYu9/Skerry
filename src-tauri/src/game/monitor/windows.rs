//! 游戏监控模块
//!
//! 使用事件驱动架构监控游戏进程的运行状态，追踪游戏时间。
//! 包含前台窗口检测、进程切换处理、逃逸进程检测等功能。

use super::TimeTrackingMode;
use sea_orm::DatabaseConnection;

// ============================================================================
// 外部依赖导入
// ============================================================================
use log::{debug, error, info};
use std::path::Path;
use std::path::PathBuf;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::SystemTime;
use std::time::{Duration, UNIX_EPOCH};
use tauri::{AppHandle, Runtime};
use tokio::time::Instant;

use {log::warn, parking_lot::RwLock, std::collections::HashSet, std::sync::OnceLock};

// ============================================================================
// 常量定义
// ============================================================================

/// 连续失败次数阈值，超过此值认为进程已结束
const MAX_CONSECUTIVE_FAILURES: u32 = 3;

/// 监控循环检查间隔（秒）
const MONITOR_CHECK_INTERVAL_SECS: u64 = 1;

/// 等待游戏正式获得前台窗口的最长时间（秒）
const STARTUP_TIMEOUT_SECS: u64 = 60;

/// 等待监控会话注册的最长时间（秒）
const SESSION_REGISTRATION_TIMEOUT_SECS: u64 = 10;

/// Magpie 等待游戏监控状态的最长观察间隔。
const MAGPIE_READINESS_POLL_INTERVAL: Duration = Duration::from_millis(200);

// ============================================================================
// 数据结构定义
// ============================================================================

/// 活跃的监控会话信息
pub struct ActiveSession {
    /// 停止信号，用于通知监控线程停止
    pub stop_signal: Arc<AtomicBool>,
    /// 用于在停止前重新确认 PID 仍属于本游戏的目录。
    game_directory: PathBuf,
    canonical_game_directory: Option<PathBuf>,
    /// 前台观察、候选资格和恢复共同使用的会话状态。
    monitor_state: Arc<RwLock<MonitorState>>,
}

/// Windows 会话监控可观察到的业务阶段。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MonitorPhase {
    AwaitingFirstForeground,
    Foreground,
    Background,
}

/// Hook 与监控循环提交给唯一状态转换器的事实。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MonitorEvent {
    GameForeground(u32),
    NoGameForeground,
    CandidateRecovered(u32),
    CandidateInvalidated(u32),
}

/// 同一把读锁下取得的一致状态视图。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MonitorSnapshot {
    phase: MonitorPhase,
    best_pid: u32,
}

impl MonitorSnapshot {
    fn has_started(self) -> bool {
        self.phase != MonitorPhase::AwaitingFirstForeground
    }

    fn is_foreground(self) -> bool {
        self.phase == MonitorPhase::Foreground
    }
}

/// 监控状态（线程安全的共享状态）。所有阶段变化由 `apply` 归约事件，
/// 避免 Hook、重扫和 Magpie 消费者各自维护互相独立的布尔组合。
#[derive(Debug)]
struct MonitorState {
    candidate_pids: HashSet<u32>,
    phase: MonitorPhase,
    best_pid: u32,
}

impl MonitorState {
    fn new(initial_pid: u32, candidate_pids: HashSet<u32>) -> Self {
        Self {
            candidate_pids,
            phase: MonitorPhase::AwaitingFirstForeground,
            best_pid: initial_pid,
        }
    }

    fn contains_candidate(&self, pid: u32) -> bool {
        self.candidate_pids.contains(&pid)
    }

    fn insert_candidate(&mut self, pid: u32) {
        self.candidate_pids.insert(pid);
    }

    fn remove_candidate(&mut self, pid: u32) {
        self.candidate_pids.remove(&pid);
    }

    fn extend_candidates(&mut self, candidates: impl IntoIterator<Item = u32>) {
        self.candidate_pids.extend(candidates);
    }

    fn replace_candidates(&mut self, candidates: impl IntoIterator<Item = u32>) {
        self.candidate_pids.clear();
        self.extend_candidates(candidates);
    }

    fn candidate_snapshot(&self) -> Vec<u32> {
        self.candidate_pids.iter().copied().collect()
    }

    fn apply(&mut self, event: MonitorEvent) {
        match event {
            MonitorEvent::GameForeground(pid) => {
                if self.phase == MonitorPhase::AwaitingFirstForeground {
                    info!("检测到游戏前台窗口，确认游戏正式启动");
                }
                self.phase = MonitorPhase::Foreground;
                self.best_pid = pid;
            }
            MonitorEvent::NoGameForeground => {
                if self.phase == MonitorPhase::Foreground {
                    self.phase = MonitorPhase::Background;
                }
            }
            MonitorEvent::CandidateRecovered(pid) => {
                self.best_pid = pid;
                if self.phase == MonitorPhase::Foreground {
                    self.phase = MonitorPhase::Background;
                }
            }
            MonitorEvent::CandidateInvalidated(pid) => {
                if self.best_pid == pid {
                    self.best_pid = 0;
                    if self.phase == MonitorPhase::Foreground {
                        self.phase = MonitorPhase::Background;
                    }
                }
            }
        }
    }

    fn snapshot(&self) -> MonitorSnapshot {
        MonitorSnapshot {
            phase: self.phase,
            best_pid: self.best_pid,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProcessProgress {
    Running {
        previous_best_pid: Option<u32>,
    },
    Missing {
        failure_count: u32,
        recovery_due: bool,
    },
    LivenessUnknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ProcessLiveness {
    Running,
    Exited,
    OutsideGameDirectory,
    NoProcessIdentity,
    Unknown(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RecoverySelection {
    Selected(u32),
    NoLiveCandidate,
    Indeterminate(Vec<UnknownCandidate>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct UnknownCandidate {
    pid: u32,
    error: String,
}

/// 管理 Windows 监控循环的逐秒进度、进程失活计数和恢复决定。
struct WindowsMonitorProgress {
    consecutive_failures: u32,
    last_best_pid: u32,
}

impl WindowsMonitorProgress {
    fn new(initial_best_pid: u32) -> Self {
        Self {
            consecutive_failures: 0,
            last_best_pid: initial_best_pid,
        }
    }

    fn observe_process(
        &mut self,
        current_best_pid: u32,
        liveness: &ProcessLiveness,
    ) -> ProcessProgress {
        if matches!(liveness, ProcessLiveness::Unknown(_)) {
            self.consecutive_failures = 0;
            return ProcessProgress::LivenessUnknown;
        }

        if matches!(
            liveness,
            ProcessLiveness::Exited
                | ProcessLiveness::OutsideGameDirectory
                | ProcessLiveness::NoProcessIdentity
        ) {
            self.consecutive_failures += 1;
            return ProcessProgress::Missing {
                failure_count: self.consecutive_failures,
                recovery_due: self.consecutive_failures >= MAX_CONSECUTIVE_FAILURES,
            };
        }

        self.consecutive_failures = 0;
        let previous_best_pid =
            (current_best_pid != self.last_best_pid).then_some(self.last_best_pid);
        self.last_best_pid = current_best_pid;
        ProcessProgress::Running { previous_best_pid }
    }

    fn may_retry_recovery_before_startup_timeout(
        &mut self,
        has_started: bool,
        startup_timeout_expired: bool,
    ) -> bool {
        if has_started || startup_timeout_expired {
            return false;
        }

        self.consecutive_failures = 0;
        true
    }

    fn candidate_recovered(&mut self, candidate_pid: u32) {
        self.consecutive_failures = 0;
        self.last_best_pid = candidate_pid;
    }
}

#[derive(Default)]
struct ForegroundPlaytime {
    accumulated: Duration,
    last_foreground_sample: Option<Instant>,
    last_reported_seconds: u64,
}

impl ForegroundPlaytime {
    fn observe(&mut self, observed_at: Instant, is_foreground: bool) -> Option<u64> {
        if !is_foreground {
            self.last_foreground_sample = None;
            return None;
        }

        if let Some(previous_sample) = self.last_foreground_sample {
            self.accumulated = self
                .accumulated
                .saturating_add(observed_at.saturating_duration_since(previous_sample));
        }
        self.last_foreground_sample = Some(observed_at);

        let seconds = self.accumulated.as_secs();
        if seconds <= self.last_reported_seconds {
            return None;
        }
        self.last_reported_seconds = seconds;
        Some(seconds)
    }

    fn total_seconds(&self) -> u64 {
        self.accumulated.as_secs()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MagpieSessionObservation {
    Missing,
    Present {
        stop_requested: bool,
        live_foreground: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MagpieReadinessOutcome {
    ContinueWaiting,
    Ready,
    SessionStopped,
    SessionEnded,
    RegistrationTimedOut,
    ForegroundTimedOut,
}

/// Terminal status of the monitor's wait for a live foreground game.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GameForegroundWaitOutcome {
    Ready,
    SessionStopped,
    SessionEnded,
    RegistrationTimedOut,
    ForegroundTimedOut,
}

/// Tracks the two distinct waits required before Magpie may receive its hotkey:
/// monitor registration, then a live foreground game process.
struct MagpieReadinessProgress {
    registration_started_at: Instant,
    foreground_wait_started_at: Option<Instant>,
    has_seen_session: bool,
}

impl MagpieReadinessProgress {
    fn new(started_at: Instant) -> Self {
        Self {
            registration_started_at: started_at,
            foreground_wait_started_at: None,
            has_seen_session: false,
        }
    }

    fn observe(
        &mut self,
        observed_at: Instant,
        session: MagpieSessionObservation,
    ) -> MagpieReadinessOutcome {
        match session {
            MagpieSessionObservation::Present {
                stop_requested,
                live_foreground,
            } => {
                self.has_seen_session = true;
                self.foreground_wait_started_at.get_or_insert(observed_at);

                if stop_requested {
                    return MagpieReadinessOutcome::SessionStopped;
                }
                if live_foreground {
                    return MagpieReadinessOutcome::Ready;
                }
            }
            MagpieSessionObservation::Missing if self.has_seen_session => {
                return MagpieReadinessOutcome::SessionEnded;
            }
            MagpieSessionObservation::Missing
                if observed_at.duration_since(self.registration_started_at)
                    >= Duration::from_secs(SESSION_REGISTRATION_TIMEOUT_SECS) =>
            {
                return MagpieReadinessOutcome::RegistrationTimedOut;
            }
            MagpieSessionObservation::Missing => {}
        }

        if self.foreground_wait_started_at.is_some_and(|started_at| {
            observed_at.duration_since(started_at) >= Duration::from_secs(STARTUP_TIMEOUT_SECS)
        }) {
            return MagpieReadinessOutcome::ForegroundTimedOut;
        }

        MagpieReadinessOutcome::ContinueWaiting
    }

    fn next_poll_delay(&self, observed_at: Instant) -> Duration {
        let (wait_started_at, timeout) = match self.foreground_wait_started_at {
            Some(started_at) => (started_at, Duration::from_secs(STARTUP_TIMEOUT_SECS)),
            None => (
                self.registration_started_at,
                Duration::from_secs(SESSION_REGISTRATION_TIMEOUT_SECS),
            ),
        };
        let remaining =
            timeout.saturating_sub(observed_at.saturating_duration_since(wait_started_at));
        remaining.min(MAGPIE_READINESS_POLL_INTERVAL)
    }
}

// ============================================================================
// 全局会话管理
// ============================================================================

/// 全局会话存储（使用 parking_lot::RwLock 保护 HashMap）
static ACTIVE_SESSIONS: OnceLock<RwLock<std::collections::HashMap<u32, ActiveSession>>> =
    OnceLock::new();

/// 获取全局会话存储的引用
fn get_sessions() -> &'static RwLock<std::collections::HashMap<u32, ActiveSession>> {
    ACTIVE_SESSIONS.get_or_init(|| RwLock::new(std::collections::HashMap::new()))
}
/// 注册新的监控会话
fn register_session(game_id: u32, session: ActiveSession) {
    get_sessions().write().insert(game_id, session);
}

/// 移除监控会话
fn unregister_session(game_id: u32) {
    get_sessions().write().remove(&game_id);
}

// ============================================================================
// 公共 API
// ============================================================================

/// 停止指定游戏的监控并终止所有相关进程
///
/// # Arguments
/// * `game_id` - 游戏 ID
///
/// # Returns
/// 成功返回终止的进程数量，失败返回错误信息
pub async fn stop_game_session(game_id: u32) -> Result<u32, String> {
    // 获取会话信息
    let sessions = get_sessions().read();
    let Some(session) = sessions.get(&game_id) else {
        info!("游戏 {} 当前没有监控会话，视为已经停止", game_id);
        return Ok(0);
    };

    let stop_signal = session.stop_signal.clone();
    let game_directory = session.game_directory.clone();

    // Snapshot the session's process candidates before releasing the registry lock.
    let candidate_pids = session.monitor_state.read().candidate_snapshot();

    // 释放读锁
    drop(sessions);

    let terminated_count = terminate_candidate_processes(
        candidate_pids,
        |pid| terminate_process_if_in_game_directory(pid, &game_directory),
        &stop_signal,
    )?;

    info!(
        "游戏 {} 停止监控成功，实际终止 {} 个进程",
        game_id, terminated_count
    );
    Ok(terminated_count)
}

/// Terminate a stable PID-ordered snapshot so failures can be reproduced from logs.
fn terminate_candidate_processes(
    mut candidate_pids: Vec<u32>,
    mut terminate_candidate: impl FnMut(u32) -> Result<bool, String>,
    stop_signal: &AtomicBool,
) -> Result<u32, String> {
    candidate_pids.sort_unstable();

    let mut terminated_count = 0u32;
    let mut failures = Vec::new();
    for pid in candidate_pids {
        match terminate_candidate(pid) {
            Ok(true) => {
                info!("成功终止进程 PID: {}", pid);
                terminated_count += 1;
            }
            Ok(false) => debug!("候选进程 {} 已退出", pid),
            Err(error) => {
                warn!("停止候选进程 {} 失败: {}", pid, error);
                failures.push(format!("PID {pid}: {error}"));
            }
        }
    }

    if failures.is_empty() {
        stop_signal.store(true, Ordering::Release);
        Ok(terminated_count)
    } else {
        Err(format!(
            "已终止 {terminated_count} 个进程，但仍有 {} 个进程未能终止：{}",
            failures.len(),
            failures.join("；")
        ))
    }
}

/// 等待游戏确认启动并处于前台，供 Magpie 安全触发放大。
///
/// 最多等待 10 秒注册会话；会话出现后继续等待游戏启动超时时间。
/// 会话停止或在观察到之后消失时提前返回。
pub async fn wait_for_game_foreground(game_id: u32) -> GameForegroundWaitOutcome {
    let mut progress = MagpieReadinessProgress::new(Instant::now());

    loop {
        let session = get_sessions().read().get(&game_id).map(|session| {
            (
                session.stop_signal.clone(),
                session.monitor_state.clone(),
                session.game_directory.clone(),
                session.canonical_game_directory.clone(),
            )
        });
        let observation = match session {
            Some((stop_signal, monitor_state, game_directory, canonical_game_directory)) => {
                let stop_requested = stop_signal.load(Ordering::Acquire);
                let live_foreground = !stop_requested
                    && monitor_has_live_foreground(
                        &monitor_state,
                        &game_directory,
                        canonical_game_directory.as_deref(),
                    );
                MagpieSessionObservation::Present {
                    stop_requested,
                    live_foreground,
                }
            }
            None => MagpieSessionObservation::Missing,
        };

        let observed_at = Instant::now();
        match progress.observe(observed_at, observation) {
            MagpieReadinessOutcome::ContinueWaiting => {
                tokio::time::sleep(progress.next_poll_delay(observed_at)).await;
            }
            MagpieReadinessOutcome::Ready => return GameForegroundWaitOutcome::Ready,
            MagpieReadinessOutcome::SessionStopped => {
                return GameForegroundWaitOutcome::SessionStopped;
            }
            MagpieReadinessOutcome::SessionEnded => {
                return GameForegroundWaitOutcome::SessionEnded;
            }
            MagpieReadinessOutcome::RegistrationTimedOut => {
                return GameForegroundWaitOutcome::RegistrationTimedOut;
            }
            MagpieReadinessOutcome::ForegroundTimedOut => {
                return GameForegroundWaitOutcome::ForegroundTimedOut;
            }
        }
    }
}

fn monitor_has_live_foreground(
    monitor_state: &RwLock<MonitorState>,
    game_directory: &Path,
    canonical_game_directory: Option<&Path>,
) -> bool {
    let snapshot = monitor_state.read().snapshot();
    snapshot.has_started()
        && snapshot.is_foreground()
        && observe_process_liveness(snapshot.best_pid, game_directory, canonical_game_directory)
            == ProcessLiveness::Running
}

fn observe_process_liveness(
    pid: u32,
    game_directory: &Path,
    canonical_game_directory: Option<&Path>,
) -> ProcessLiveness {
    observe_process_liveness_with(
        pid,
        game_directory,
        canonical_game_directory,
        get_process_image_for_monitoring,
    )
}

fn observe_process_liveness_with<P: foreground::ForegroundProcessObservation>(
    pid: u32,
    game_directory: &Path,
    canonical_game_directory: Option<&Path>,
    mut process_image_for_pid: impl FnMut(u32) -> Result<P, ProcessImageLookupFailure>,
) -> ProcessLiveness {
    // Steam launch sessions deliberately use monitor PID 0; it means "no initial
    // process identity, recover from the configured directory" rather than an OS query.
    if pid == 0 {
        return ProcessLiveness::NoProcessIdentity;
    }

    let process_image = match process_image_for_pid(pid) {
        Ok(process_image) => process_image,
        Err(ProcessImageLookupFailure::Exited) => return ProcessLiveness::Exited,
        Err(ProcessImageLookupFailure::Unknown(message)) => {
            return ProcessLiveness::Unknown(message);
        }
    };
    let image_path = process_image.executable_path();
    if !is_path_in_directory_tree(image_path, game_directory)
        && !canonical_game_directory
            .is_some_and(|directory| is_path_in_directory_tree(image_path, directory))
    {
        return ProcessLiveness::OutsideGameDirectory;
    }

    match process_image.is_running() {
        Some(true) => ProcessLiveness::Running,
        Some(false) => ProcessLiveness::Exited,
        None => ProcessLiveness::Unknown(format!("无法查询进程 {} 状态", pid)),
    }
}

/// 判断游戏当前是否仍可安全接收 Magpie 放大快捷键。
pub fn is_game_foreground(game_id: u32) -> bool {
    let session = {
        let sessions = get_sessions().read();
        sessions.get(&game_id).map(|session| {
            (
                session.stop_signal.load(Ordering::Acquire),
                session.monitor_state.clone(),
                session.game_directory.clone(),
                session.canonical_game_directory.clone(),
            )
        })
    };
    let Some((stop_requested, monitor_state, game_directory, canonical_game_directory)) = session
    else {
        return false;
    };
    !stop_requested
        && monitor_has_live_foreground(
            &monitor_state,
            &game_directory,
            canonical_game_directory.as_deref(),
        )
}

/// 启动指定游戏进程的监控
///
/// 这是模块的主入口函数，由外部调用以开始监控一个游戏进程。
///
/// # Arguments
/// * `app_handle` - Tauri 应用句柄，用于发送事件到前端
/// * `game_id` - 游戏的唯一标识符
/// * `process_id` - 要开始监控的游戏进程的初始 PID
/// * `detection_dir` - 游戏检测目录，用于在进程重启或切换后重新查找
///
/// # 工作流程
/// 1. 创建 System 实例用于进程查询
/// 2. 在异步任务中启动实际的监控循环
/// 3. 监控循环会持续运行直到游戏进程结束
pub async fn monitor_game<R: Runtime>(
    app_handle: AppHandle<R>,
    db: DatabaseConnection,
    time_tracking_mode: TimeTrackingMode,
    game_id: u32,
    process_id: u32,
    detection_dir: String,
) {
    let app_handle_clone = app_handle.clone();

    tauri::async_runtime::spawn(async move {
        if let Err(e) = runtime::run_game_monitor(
            app_handle_clone,
            db,
            time_tracking_mode,
            game_id,
            process_id,
            detection_dir,
        )
        .await
        {
            error!("游戏监控任务 (game_id: {}) 出错: {}", game_id, e);
        }
    });
}

// ============================================================================
// 核心监控逻辑
// ============================================================================

/// 将目录重扫的选择结果提交到共享候选集、会话阶段和监控进度。
fn apply_recovery_selection(
    discovered_candidates: &[u32],
    selected_pid: Option<u32>,
    monitor_state: &RwLock<MonitorState>,
    progress: &mut WindowsMonitorProgress,
) -> Option<u32> {
    let mut state = monitor_state.write();
    let Some(selected_pid) = selected_pid else {
        state.replace_candidates([]);
        state.apply(MonitorEvent::NoGameForeground);
        return None;
    };

    state.replace_candidates(discovered_candidates.iter().copied());
    state.apply(MonitorEvent::CandidateRecovered(selected_pid));
    drop(state);
    progress.candidate_recovered(selected_pid);
    Some(selected_pid)
}

/// 选择失效后的监控锚点：优先使用当前前台的活动候选，否则选活动 PID 最小者。
///
/// 前台事实决定实际正在使用的候选；没有前台候选时，PID 顺序只负责给等价候选
/// 一个可复现的监控锚点，不表示游戏进程的产品优先级。
fn select_recovery_pid<P>(
    candidates: &[CandidateProcess<P>],
    foreground_pid: Option<u32>,
    mut observe_liveness: impl FnMut(&CandidateProcess<P>) -> ProcessLiveness,
) -> RecoverySelection {
    let mut lowest_live_pid: Option<u32> = None;
    let mut unknown_candidates = Vec::new();

    for candidate in candidates {
        let candidate_pid = candidate.process_id();
        match observe_liveness(candidate) {
            ProcessLiveness::Running if Some(candidate_pid) == foreground_pid => {
                return RecoverySelection::Selected(candidate_pid);
            }
            ProcessLiveness::Running => {
                lowest_live_pid = Some(match lowest_live_pid {
                    Some(current_lowest) => current_lowest.min(candidate_pid),
                    None => candidate_pid,
                });
            }
            ProcessLiveness::Exited
            | ProcessLiveness::OutsideGameDirectory
            | ProcessLiveness::NoProcessIdentity => {}
            ProcessLiveness::Unknown(error) => unknown_candidates.push(UnknownCandidate {
                pid: candidate_pid,
                error,
            }),
        }
    }
    unknown_candidates.sort_unstable_by_key(|candidate| candidate.pid);

    if foreground_pid.is_some_and(|pid| {
        unknown_candidates
            .iter()
            .any(|candidate| candidate.pid == pid)
    }) {
        return RecoverySelection::Indeterminate(unknown_candidates);
    }

    match lowest_live_pid {
        Some(selected_pid)
            if unknown_candidates
                .iter()
                .any(|candidate| candidate.pid < selected_pid) =>
        {
            RecoverySelection::Indeterminate(unknown_candidates)
        }
        Some(selected_pid) => RecoverySelection::Selected(selected_pid),
        None if unknown_candidates.is_empty() => RecoverySelection::NoLiveCandidate,
        None => RecoverySelection::Indeterminate(unknown_candidates),
    }
}

mod foreground;
mod runtime;

mod processes;
pub use processes::terminate_process_if_in_game_directory;
use processes::{
    CandidateProcess, ProcessImageLookupFailure, get_all_candidate_processes,
    get_process_image_for_monitoring, is_path_in_directory_tree,
};

// ============================================================================
// 工具函数
// ============================================================================

/// 获取当前的 Unix 时间戳（秒）
///
/// # Returns
/// 返回当前时间的 Unix 时间戳（秒）
///
/// # Panics
/// 如果系统时间早于 UNIX_EPOCH（1970-01-01 00:00:00 UTC），会 panic
fn get_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("系统时间错误: 时间回溯")
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::foreground::{ForegroundPathProbe, update_foreground_state};
    use super::*;

    fn recovery_candidates(process_ids: &[u32]) -> Vec<CandidateProcess<u32>> {
        process_ids
            .iter()
            .copied()
            .map(|pid| CandidateProcess::new(pid, pid))
            .collect()
    }

    struct DropCheckProcessImage(Option<Box<dyn FnOnce()>>);

    impl Drop for DropCheckProcessImage {
        fn drop(&mut self) {
            if let Some(check) = self.0.take() {
                check();
            }
        }
    }
    use std::{
        path::{Path, PathBuf},
        sync::atomic::AtomicU32,
    };

    static NEXT_TEST_GAME_ID: AtomicU32 = AtomicU32::new(u32::MAX);

    fn next_test_game_id() -> u32 {
        NEXT_TEST_GAME_ID.fetch_sub(1, std::sync::atomic::Ordering::Relaxed)
    }

    #[test]
    fn magpie_readiness_keeps_the_session_registration_deadline() {
        let started_at = Instant::now();
        let mut progress = MagpieReadinessProgress::new(started_at);

        assert_eq!(
            progress.next_poll_delay(started_at),
            MAGPIE_READINESS_POLL_INTERVAL
        );
        assert_eq!(
            progress.observe(
                started_at + Duration::from_secs(SESSION_REGISTRATION_TIMEOUT_SECS - 1),
                MagpieSessionObservation::Missing,
            ),
            MagpieReadinessOutcome::ContinueWaiting
        );
        assert_eq!(
            progress.next_poll_delay(
                started_at + Duration::from_secs(SESSION_REGISTRATION_TIMEOUT_SECS)
                    - Duration::from_millis(50),
            ),
            Duration::from_millis(50)
        );
        assert_eq!(
            progress.observe(
                started_at + Duration::from_secs(SESSION_REGISTRATION_TIMEOUT_SECS),
                MagpieSessionObservation::Missing,
            ),
            MagpieReadinessOutcome::RegistrationTimedOut
        );
    }

    #[test]
    fn magpie_readiness_starts_foreground_deadline_when_session_is_observed() {
        let started_at = Instant::now();
        let mut progress = MagpieReadinessProgress::new(started_at);
        let session_started_at =
            started_at + Duration::from_secs(SESSION_REGISTRATION_TIMEOUT_SECS + 2);

        assert_eq!(
            progress.observe(
                session_started_at,
                MagpieSessionObservation::Present {
                    stop_requested: false,
                    live_foreground: false,
                },
            ),
            MagpieReadinessOutcome::ContinueWaiting
        );
        assert_eq!(
            progress.next_poll_delay(session_started_at),
            MAGPIE_READINESS_POLL_INTERVAL
        );
        assert_eq!(
            progress.observe(
                session_started_at + Duration::from_secs(STARTUP_TIMEOUT_SECS - 1),
                MagpieSessionObservation::Present {
                    stop_requested: false,
                    live_foreground: false,
                },
            ),
            MagpieReadinessOutcome::ContinueWaiting
        );
        assert_eq!(
            progress.next_poll_delay(
                session_started_at + Duration::from_secs(STARTUP_TIMEOUT_SECS)
                    - Duration::from_millis(50),
            ),
            Duration::from_millis(50)
        );
        assert_eq!(
            progress.observe(
                session_started_at + Duration::from_secs(STARTUP_TIMEOUT_SECS),
                MagpieSessionObservation::Present {
                    stop_requested: false,
                    live_foreground: false,
                },
            ),
            MagpieReadinessOutcome::ForegroundTimedOut
        );
    }

    #[test]
    fn magpie_readiness_returns_for_live_foreground_and_prioritizes_stop() {
        let started_at = Instant::now();
        let mut ready_progress = MagpieReadinessProgress::new(started_at);
        assert_eq!(
            ready_progress.observe(
                started_at,
                MagpieSessionObservation::Present {
                    stop_requested: false,
                    live_foreground: true,
                },
            ),
            MagpieReadinessOutcome::Ready
        );

        let mut stopped_progress = MagpieReadinessProgress::new(started_at);
        assert_eq!(
            stopped_progress.observe(
                started_at,
                MagpieSessionObservation::Present {
                    stop_requested: true,
                    live_foreground: true,
                },
            ),
            MagpieReadinessOutcome::SessionStopped
        );
    }

    #[test]
    fn magpie_readiness_exits_when_an_observed_session_disappears() {
        let started_at = Instant::now();
        let mut progress = MagpieReadinessProgress::new(started_at);

        assert_eq!(
            progress.observe(
                started_at,
                MagpieSessionObservation::Present {
                    stop_requested: false,
                    live_foreground: false,
                },
            ),
            MagpieReadinessOutcome::ContinueWaiting
        );
        assert_eq!(
            progress.observe(
                started_at + Duration::from_secs(1),
                MagpieSessionObservation::Missing,
            ),
            MagpieReadinessOutcome::SessionEnded
        );
    }

    #[test]
    fn process_health_requests_recovery_after_three_misses_and_resets_when_alive() {
        let mut progress = WindowsMonitorProgress::new(10);

        assert_eq!(
            progress.observe_process(10, &ProcessLiveness::Exited),
            ProcessProgress::Missing {
                failure_count: 1,
                recovery_due: false,
            }
        );
        assert_eq!(
            progress.observe_process(10, &ProcessLiveness::Exited),
            ProcessProgress::Missing {
                failure_count: 2,
                recovery_due: false,
            }
        );
        assert_eq!(
            progress.observe_process(10, &ProcessLiveness::Exited),
            ProcessProgress::Missing {
                failure_count: 3,
                recovery_due: true,
            }
        );

        assert_eq!(
            progress.observe_process(10, &ProcessLiveness::Running),
            ProcessProgress::Running {
                previous_best_pid: None,
            }
        );
        assert_eq!(
            progress.observe_process(20, &ProcessLiveness::Running),
            ProcessProgress::Running {
                previous_best_pid: Some(10),
            }
        );
        assert_eq!(
            progress.observe_process(20, &ProcessLiveness::Running),
            ProcessProgress::Running {
                previous_best_pid: None,
            }
        );
        assert_eq!(progress.consecutive_failures, 0);
    }

    #[test]
    fn foreground_playtime_uses_elapsed_time_and_pauses_between_foreground_samples() {
        let started_at = Instant::now();
        let mut playtime = ForegroundPlaytime::default();

        assert_eq!(playtime.observe(started_at, true), None);
        assert_eq!(
            playtime.observe(started_at + Duration::from_millis(1_250), true),
            Some(1)
        );
        assert_eq!(
            playtime.observe(started_at + Duration::from_millis(3_500), true),
            Some(3)
        );
        assert_eq!(
            playtime.observe(started_at + Duration::from_secs(4), false),
            None
        );
        assert_eq!(
            playtime.observe(started_at + Duration::from_secs(8), true),
            None
        );
        assert_eq!(
            playtime.observe(started_at + Duration::from_millis(8_500), true),
            Some(4)
        );
        assert_eq!(playtime.total_seconds(), 4);
    }

    #[test]
    fn unknown_process_liveness_does_not_count_as_exit() {
        let mut progress = WindowsMonitorProgress::new(10);
        progress.observe_process(10, &ProcessLiveness::Exited);
        progress.observe_process(10, &ProcessLiveness::Exited);

        assert_eq!(
            progress.observe_process(10, &ProcessLiveness::Unknown(String::from("access denied")),),
            ProcessProgress::LivenessUnknown
        );
        assert_eq!(progress.consecutive_failures, 0);
        assert_eq!(
            progress.observe_process(10, &ProcessLiveness::Exited),
            ProcessProgress::Missing {
                failure_count: 1,
                recovery_due: false,
            }
        );
    }

    #[test]
    fn steam_zero_monitor_pid_remains_recoverable_without_an_os_query() {
        assert_eq!(
            observe_process_liveness_with(
                0,
                Path::new(""),
                None,
                |_| -> Result<PathBuf, ProcessImageLookupFailure> {
                    panic!("PID 0 must not query a Windows process")
                }
            ),
            ProcessLiveness::NoProcessIdentity
        );

        let mut progress = WindowsMonitorProgress::new(0);
        assert_eq!(
            progress.observe_process(0, &ProcessLiveness::NoProcessIdentity),
            ProcessProgress::Missing {
                failure_count: 1,
                recovery_due: false,
            }
        );
    }

    #[test]
    fn runtime_liveness_requires_current_image_to_remain_in_game_directory() {
        let game_directory = Path::new(r"C:\Games\Example");
        let live_game = observe_process_liveness_with(42, game_directory, None, |_| {
            Ok(PathBuf::from(r"C:\Games\Example\game.exe"))
        });
        let reused_pid_outside_game =
            observe_process_liveness_with(42, game_directory, None, |_| {
                Ok(PathBuf::from(r"C:\Windows\System32\notepad.exe"))
            });

        assert_eq!(live_game, ProcessLiveness::Running);
        assert_eq!(
            reused_pid_outside_game,
            ProcessLiveness::OutsideGameDirectory
        );
    }

    #[test]
    fn runtime_liveness_keeps_unreadable_process_identity_unknown() {
        assert!(matches!(
            observe_process_liveness_with(
                42,
                Path::new(r"C:\Games\Example"),
                None,
                |_| -> Result<PathBuf, ProcessImageLookupFailure> {
                    Err(ProcessImageLookupFailure::Unknown(String::from(
                        "无法打开进程 42 并确认其映像",
                    )))
                },
            ),
            ProcessLiveness::Unknown(_)
        ));
    }

    #[test]
    fn exited_process_open_failure_reaches_session_finalization_threshold() {
        let pid = 42;
        let game_directory = Path::new(r"C:\Games\Example");
        let liveness = observe_process_liveness_with(
            pid,
            game_directory,
            None,
            |_| -> Result<PathBuf, ProcessImageLookupFailure> {
                Err(ProcessImageLookupFailure::Exited)
            },
        );
        assert_eq!(liveness, ProcessLiveness::Exited);

        let mut progress = WindowsMonitorProgress::new(pid);
        assert_eq!(
            progress.observe_process(pid, &liveness),
            ProcessProgress::Missing {
                failure_count: 1,
                recovery_due: false,
            }
        );
        assert_eq!(
            progress.observe_process(pid, &liveness),
            ProcessProgress::Missing {
                failure_count: 2,
                recovery_due: false,
            }
        );
        assert_eq!(
            progress.observe_process(pid, &liveness),
            ProcessProgress::Missing {
                failure_count: 3,
                recovery_due: true,
            }
        );

        let mut started_state = MonitorState::new(pid, HashSet::from([pid]));
        started_state.apply(MonitorEvent::GameForeground(pid));
        let state = RwLock::new(started_state);
        assert_eq!(
            apply_recovery_selection(&[], None, &state, &mut progress),
            None
        );
        assert!(state.read().candidate_snapshot().is_empty());
        assert!(state.read().snapshot().has_started());
        assert!(!progress.may_retry_recovery_before_startup_timeout(true, false));
    }

    #[test]
    fn unresolved_recovery_retries_only_before_first_foreground_and_timeout() {
        let mut progress = WindowsMonitorProgress::new(10);
        for _ in 0..MAX_CONSECUTIVE_FAILURES {
            progress.observe_process(10, &ProcessLiveness::Exited);
        }

        assert!(progress.may_retry_recovery_before_startup_timeout(false, false));
        assert_eq!(
            progress.observe_process(10, &ProcessLiveness::Exited),
            ProcessProgress::Missing {
                failure_count: 1,
                recovery_due: false,
            }
        );
        assert!(!progress.may_retry_recovery_before_startup_timeout(false, true));
        assert!(!progress.may_retry_recovery_before_startup_timeout(true, false));
    }

    #[test]
    fn failed_recovery_clears_stale_hook_candidates_and_keeps_started_phase_sticky() {
        let state = RwLock::new(MonitorState::new(10, HashSet::from([10, 20])));
        state.write().apply(MonitorEvent::GameForeground(10));
        let mut progress = WindowsMonitorProgress::new(10);

        let recovered = apply_recovery_selection(&[30], None, &state, &mut progress);

        assert_eq!(recovered, None);
        assert!(state.read().candidate_snapshot().is_empty());
        let snapshot = state.read().snapshot();
        assert_eq!(snapshot.phase, MonitorPhase::Background);
        assert!(snapshot.has_started());
        assert_eq!(snapshot.best_pid, 10);
    }

    #[test]
    fn successful_recovery_commits_candidates_and_monitor_state_together() {
        let state = RwLock::new(MonitorState::new(10, HashSet::from([10])));
        let mut progress = WindowsMonitorProgress::new(10);
        progress.observe_process(10, &ProcessLiveness::Exited);

        let recovered = apply_recovery_selection(&[20, 30], Some(20), &state, &mut progress);

        assert_eq!(recovered, Some(20));
        assert_eq!(
            state
                .read()
                .candidate_snapshot()
                .into_iter()
                .collect::<HashSet<_>>(),
            HashSet::from([20, 30])
        );
        assert_eq!(state.read().snapshot().best_pid, 20);
        assert_eq!(progress.last_best_pid, 20);
        assert_eq!(progress.consecutive_failures, 0);
    }

    #[test]
    fn recovery_scan_process_observations_live_until_state_commit() {
        let mut initial_state = MonitorState::new(1, HashSet::from([1]));
        initial_state.apply(MonitorEvent::GameForeground(1));
        let state = Arc::new(RwLock::new(initial_state));
        let state_at_drop = state.clone();
        let candidates = [10, 20]
            .into_iter()
            .map(|pid| {
                let state_at_drop = state_at_drop.clone();
                CandidateProcess::new(
                    pid,
                    DropCheckProcessImage(Some(Box::new(move || {
                        let committed = state_at_drop.read();
                        let mut committed_candidates = committed.candidate_snapshot();
                        committed_candidates.sort_unstable();
                        assert_eq!(committed_candidates, [10, 20]);
                        assert_eq!(committed.snapshot().best_pid, 20);
                    }))),
                )
            })
            .collect::<Vec<_>>();
        let selected = select_recovery_pid(&candidates, Some(20), |_| ProcessLiveness::Running);
        let RecoverySelection::Selected(selected_pid) = selected else {
            panic!("the running foreground candidate should be selected");
        };
        let discovered_pids = candidates
            .iter()
            .map(CandidateProcess::process_id)
            .collect::<Vec<_>>();
        let mut progress = WindowsMonitorProgress::new(1);

        assert_eq!(
            apply_recovery_selection(&discovered_pids, Some(selected_pid), &state, &mut progress),
            Some(20)
        );
        drop(candidates);

        assert_eq!(progress.last_best_pid, 20);
    }

    #[test]
    fn recovery_prefers_a_live_foreground_candidate() {
        let live_pids = HashSet::from([10, 30]);
        let candidates = recovery_candidates(&[10, 30]);

        let selected = select_recovery_pid(&candidates, Some(30), |candidate| {
            let pid = *candidate.image();
            if live_pids.contains(&pid) {
                ProcessLiveness::Running
            } else {
                ProcessLiveness::Exited
            }
        });

        assert_eq!(selected, RecoverySelection::Selected(30));
    }

    #[test]
    fn recovery_uses_lowest_live_candidate_when_foreground_is_not_eligible() {
        let live_pids = HashSet::from([10, 40]);
        let candidates = recovery_candidates(&[40, 10]);

        let selected = select_recovery_pid(&candidates, Some(99), |candidate| {
            let pid = *candidate.image();
            if live_pids.contains(&pid) {
                ProcessLiveness::Running
            } else {
                ProcessLiveness::Exited
            }
        });

        assert_eq!(selected, RecoverySelection::Selected(10));
    }

    #[test]
    fn recovery_ignores_a_foreground_candidate_that_has_exited() {
        let live_pids = HashSet::from([10]);
        let candidates = recovery_candidates(&[30, 10]);

        let selected = select_recovery_pid(&candidates, Some(30), |candidate| {
            let pid = *candidate.image();
            if live_pids.contains(&pid) {
                ProcessLiveness::Running
            } else {
                ProcessLiveness::Exited
            }
        });

        assert_eq!(selected, RecoverySelection::Selected(10));
    }

    #[test]
    fn recovery_fallback_is_stable_and_skips_exited_candidates() {
        let live_pids = HashSet::from([20, 40]);
        let candidates_a = recovery_candidates(&[40, 10, 20]);
        let candidates_b = recovery_candidates(&[20, 40, 10]);

        let observe = |candidate: &CandidateProcess<u32>| {
            let pid = *candidate.image();
            if live_pids.contains(&pid) {
                ProcessLiveness::Running
            } else {
                ProcessLiveness::Exited
            }
        };
        let selected_a = select_recovery_pid(&candidates_a, None, observe);
        let selected_b = select_recovery_pid(&candidates_b, None, observe);

        assert_eq!(selected_a, RecoverySelection::Selected(20));
        assert_eq!(selected_b, selected_a);
    }

    #[test]
    fn recovery_returns_none_when_all_candidates_have_exited() {
        let candidates = recovery_candidates(&[10, 20]);
        let selected = select_recovery_pid(&candidates, None, |_| ProcessLiveness::Exited);

        assert_eq!(selected, RecoverySelection::NoLiveCandidate);
    }

    #[test]
    fn recovery_defers_when_an_unknown_pid_could_change_the_selected_anchor() {
        let candidates = recovery_candidates(&[10, 20, 30]);
        let selected =
            select_recovery_pid(&candidates, None, |candidate| match candidate.image() {
                10 => ProcessLiveness::Unknown(String::from("access denied")),
                20 | 30 => ProcessLiveness::Running,
                _ => ProcessLiveness::Exited,
            });

        assert_eq!(
            selected,
            RecoverySelection::Indeterminate(vec![UnknownCandidate {
                pid: 10,
                error: String::from("access denied"),
            }])
        );
    }

    #[test]
    fn recovery_keeps_a_known_anchor_when_unknown_pid_cannot_outrank_it() {
        let candidates = recovery_candidates(&[20, 30, 40]);
        let selected =
            select_recovery_pid(&candidates, None, |candidate| match candidate.image() {
                20 => ProcessLiveness::Running,
                30 => ProcessLiveness::Unknown(String::from("access denied")),
                40 => ProcessLiveness::Running,
                _ => ProcessLiveness::Exited,
            });

        assert_eq!(selected, RecoverySelection::Selected(20));
    }

    #[test]
    fn recovery_defers_when_foreground_candidate_liveness_is_unknown() {
        let candidates = recovery_candidates(&[10, 20]);
        let selected =
            select_recovery_pid(&candidates, Some(20), |candidate| match candidate.image() {
                10 => ProcessLiveness::Running,
                20 => ProcessLiveness::Unknown(String::from("access denied")),
                _ => ProcessLiveness::Exited,
            });

        assert_eq!(
            selected,
            RecoverySelection::Indeterminate(vec![UnknownCandidate {
                pid: 20,
                error: String::from("access denied"),
            }])
        );
    }

    #[test]
    fn monitor_phase_transitions_preserve_sticky_start_and_pid_recovery() {
        let mut state = MonitorState::new(10, HashSet::new());

        state.apply(MonitorEvent::NoGameForeground);
        let snapshot = state.snapshot();
        assert_eq!(snapshot.phase, MonitorPhase::AwaitingFirstForeground);
        assert!(!snapshot.has_started());
        assert!(!snapshot.is_foreground());
        assert_eq!(snapshot.best_pid, 10);

        state.apply(MonitorEvent::GameForeground(20));
        let snapshot = state.snapshot();
        assert_eq!(snapshot.phase, MonitorPhase::Foreground);
        assert!(snapshot.has_started());
        assert!(snapshot.is_foreground());
        assert_eq!(snapshot.best_pid, 20);

        state.apply(MonitorEvent::NoGameForeground);
        let snapshot = state.snapshot();
        assert_eq!(snapshot.phase, MonitorPhase::Background);
        assert!(snapshot.has_started());
        assert!(!snapshot.is_foreground());

        state.apply(MonitorEvent::GameForeground(30));
        let snapshot = state.snapshot();
        assert_eq!(snapshot.phase, MonitorPhase::Foreground);
        assert!(snapshot.has_started());
        assert!(snapshot.is_foreground());
        assert_eq!(snapshot.best_pid, 30);

        state.apply(MonitorEvent::CandidateRecovered(40));
        let snapshot = state.snapshot();
        assert_eq!(snapshot.phase, MonitorPhase::Background);
        assert!(snapshot.has_started());
        assert!(!snapshot.is_foreground());
        assert_eq!(snapshot.best_pid, 40);
    }

    #[test]
    fn candidate_recovery_before_first_foreground_does_not_start_session() {
        let mut state = MonitorState::new(10, HashSet::new());

        state.apply(MonitorEvent::CandidateRecovered(20));

        let snapshot = state.snapshot();
        assert_eq!(snapshot.phase, MonitorPhase::AwaitingFirstForeground);
        assert!(!snapshot.has_started());
        assert!(!snapshot.is_foreground());
        assert_eq!(snapshot.best_pid, 20);
    }

    #[test]
    fn same_pid_recovers_after_foreground_becomes_unavailable() {
        let state = RwLock::new(MonitorState::new(123, HashSet::from([123])));
        let mut path_probe = ForegroundPathProbe::default();

        assert!(!state.read().snapshot().has_started());

        update_foreground_state(
            &state,
            Path::new(r"C:\Games\Example"),
            None,
            &mut path_probe,
            Some(123),
            |_| Some(PathBuf::from(r"C:\Games\Example\game.exe")),
        );
        let snapshot = state.read().snapshot();
        assert!(snapshot.is_foreground());
        assert!(snapshot.has_started());

        update_foreground_state(
            &state,
            Path::new(r"C:\Games\Example"),
            None,
            &mut path_probe,
            None,
            |_| -> Option<PathBuf> {
                panic!("no foreground PID must not query an executable path")
            },
        );
        let snapshot = state.read().snapshot();
        assert!(!snapshot.is_foreground());
        assert!(snapshot.has_started());
        assert!(path_probe.is_empty());

        update_foreground_state(
            &state,
            Path::new(r"C:\Games\Example"),
            None,
            &mut path_probe,
            Some(123),
            |_| Some(PathBuf::from(r"C:\Games\Example\game.exe")),
        );
        assert!(state.read().snapshot().is_foreground());
    }

    #[test]
    fn known_candidate_is_path_checked_after_becoming_candidate() {
        let state = RwLock::new(MonitorState::new(1, HashSet::new()));
        // 模拟该 PID 已按非游戏进程处理，但随后被主监控循环加入候选集。
        let mut path_probe = ForegroundPathProbe::default();
        path_probe.remember_unresolved(123, std::time::Instant::now());
        state.write().insert_candidate(123);

        update_foreground_state(
            &state,
            Path::new(r"C:\Games\Example"),
            None,
            &mut path_probe,
            Some(123),
            |queried_pid| {
                assert_eq!(queried_pid, 123);
                Some(PathBuf::from(r"C:\Games\Example\game.exe"))
            },
        );

        let snapshot = state.read().snapshot();
        assert!(snapshot.is_foreground());
        assert_eq!(snapshot.best_pid, 123);
        assert!(snapshot.has_started());
    }

    #[test]
    fn a_removed_candidate_is_resolved_again_for_the_same_foreground_pid() {
        let state = RwLock::new(MonitorState::new(10, HashSet::from([20])));
        // 已知候选会核对当前映像，并清除负向查询缓存。
        let mut path_probe = ForegroundPathProbe::default();
        path_probe.remember_unresolved(20, std::time::Instant::now());

        update_foreground_state(
            &state,
            Path::new(r"C:\Games\Example"),
            None,
            &mut path_probe,
            Some(20),
            |_| Some(PathBuf::from(r"C:\Games\Example\game.exe")),
        );
        assert!(path_probe.is_empty());

        // 模拟恢复结果把 PID 移出候选集，但前台窗口仍报告同一 PID。
        state.write().remove_candidate(20);
        update_foreground_state(
            &state,
            Path::new(r"C:\Games\Example"),
            None,
            &mut path_probe,
            Some(20),
            |queried_pid| {
                assert_eq!(queried_pid, 20);
                Some(PathBuf::from(r"C:\Games\Example\recovered.exe"))
            },
        );

        assert!(state.read().contains_candidate(20));
        assert!(path_probe.is_empty());
        let snapshot = state.read().snapshot();
        assert_eq!(snapshot.phase, MonitorPhase::Foreground);
        assert_eq!(snapshot.best_pid, 20);
    }

    #[test]
    fn pid_admitted_during_failed_image_lookup_is_rechecked_before_foreground() {
        let mut initial_state = MonitorState::new(10, HashSet::new());
        initial_state.apply(MonitorEvent::GameForeground(10));
        let state = RwLock::new(initial_state);
        let mut path_probe = ForegroundPathProbe::default();
        let mut progress = WindowsMonitorProgress::new(10);

        update_foreground_state(
            &state,
            Path::new(r"C:\Games\Example"),
            None,
            &mut path_probe,
            Some(20),
            |queried_pid| {
                assert_eq!(queried_pid, 20);
                apply_recovery_selection(&[queried_pid], Some(queried_pid), &state, &mut progress);
                None::<PathBuf>
            },
        );

        let snapshot = state.read().snapshot();
        assert_eq!(state.read().candidate_pids, HashSet::from([20]));
        assert_eq!(snapshot.phase, MonitorPhase::Background);
        assert_eq!(snapshot.best_pid, 20);
        assert!(path_probe.is_empty());
        assert_eq!(progress.last_best_pid, 20);

        update_foreground_state(
            &state,
            Path::new(r"C:\Games\Example"),
            None,
            &mut path_probe,
            Some(20),
            |queried_pid| {
                assert_eq!(queried_pid, 20);
                Some(PathBuf::from(r"C:\Games\Example\game.exe"))
            },
        );

        let snapshot = state.read().snapshot();
        assert_eq!(snapshot.phase, MonitorPhase::Foreground);
        assert_eq!(snapshot.best_pid, 20);
    }

    #[test]
    fn matching_escape_path_is_admitted_and_becomes_foreground() {
        let state = RwLock::new(MonitorState::new(10, HashSet::from([10])));
        let mut path_probe = ForegroundPathProbe::default();

        update_foreground_state(
            &state,
            Path::new(r"C:\Games\Example"),
            None,
            &mut path_probe,
            Some(20),
            |queried_pid| {
                assert_eq!(queried_pid, 20);
                Some(PathBuf::from(r"C:\Games\Example\escaped.exe"))
            },
        );

        assert_eq!(state.read().candidate_pids, HashSet::from([10, 20]));
        let snapshot = state.read().snapshot();
        assert_eq!(snapshot.phase, MonitorPhase::Foreground);
        assert_eq!(snapshot.best_pid, 20);
    }

    #[test]
    fn reused_candidate_pid_is_removed_and_invalidates_its_foreground_identity() {
        let mut initial_state = MonitorState::new(123, HashSet::from([123, 456]));
        initial_state.apply(MonitorEvent::GameForeground(123));
        let state = RwLock::new(initial_state);
        let mut path_probe = ForegroundPathProbe::default();

        update_foreground_state(
            &state,
            Path::new(r"C:\Games\Example"),
            None,
            &mut path_probe,
            Some(123),
            |queried_pid| {
                assert_eq!(queried_pid, 123);
                Some(PathBuf::from(r"C:\Windows\System32\notepad.exe"))
            },
        );

        assert_eq!(state.read().candidate_pids, HashSet::from([456]));
        let snapshot = state.read().snapshot();
        assert_eq!(snapshot.phase, MonitorPhase::Background);
        assert_eq!(snapshot.best_pid, 0);
        assert!(snapshot.has_started());
        assert!(path_probe.is_empty());
    }

    #[test]
    fn unavailable_candidate_image_stops_foreground_counting_and_retries() {
        let mut initial_state = MonitorState::new(123, HashSet::from([123]));
        initial_state.apply(MonitorEvent::GameForeground(123));
        let state = RwLock::new(initial_state);
        let mut path_probe = ForegroundPathProbe::default();

        update_foreground_state(
            &state,
            Path::new(r"C:\Games\Example"),
            None,
            &mut path_probe,
            Some(123),
            |_| None::<PathBuf>,
        );

        assert_eq!(state.read().candidate_pids, HashSet::from([123]));
        let snapshot = state.read().snapshot();
        assert_eq!(snapshot.phase, MonitorPhase::Background);
        assert_eq!(snapshot.best_pid, 123);
        assert!(path_probe.is_empty());

        update_foreground_state(
            &state,
            Path::new(r"C:\Games\Example"),
            None,
            &mut path_probe,
            Some(123),
            |_| Some(PathBuf::from(r"C:\Games\Example\game.exe")),
        );

        assert!(state.read().snapshot().is_foreground());
    }

    #[tokio::test]
    async fn stopping_missing_session_is_successful() {
        let game_id = next_test_game_id();
        unregister_session(game_id);

        assert_eq!(stop_game_session(game_id).await, Ok(0));
    }

    #[tokio::test]
    async fn stopping_empty_session_sets_stop_signal() {
        let game_id = next_test_game_id();
        let stop_signal = Arc::new(AtomicBool::new(false));
        register_session(
            game_id,
            ActiveSession {
                stop_signal: stop_signal.clone(),
                game_directory: PathBuf::new(),
                canonical_game_directory: None,
                monitor_state: Arc::new(RwLock::new(MonitorState::new(0, HashSet::new()))),
            },
        );

        let result = stop_game_session(game_id).await;
        unregister_session(game_id);

        assert_eq!(result, Ok(0));
        assert!(stop_signal.load(Ordering::Acquire));
    }

    #[test]
    fn candidate_process_stop_reports_failure_and_keeps_monitor_active() {
        let mut processed_pids = Vec::new();
        let stop_signal = AtomicBool::new(false);

        let result = terminate_candidate_processes(
            vec![30, 20, 10],
            |pid| {
                processed_pids.push(pid);
                match pid {
                    10 => Err("候选进程映像路径查询被拒绝".to_string()),
                    20 => Ok(false),
                    _ => Ok(true),
                }
            },
            &stop_signal,
        );

        assert_eq!(processed_pids, [10, 20, 30]);
        assert_eq!(
            result,
            Err(
                "已终止 1 个进程，但仍有 1 个进程未能终止：PID 10: 候选进程映像路径查询被拒绝"
                    .to_string()
            )
        );
        assert!(!stop_signal.load(Ordering::Acquire));
    }

    #[test]
    fn candidate_process_stop_signals_monitor_after_all_candidates_finish() {
        let stop_signal = AtomicBool::new(false);
        let terminated_count =
            terminate_candidate_processes(vec![30, 10], |_| Ok(true), &stop_signal);

        assert_eq!(terminated_count, Ok(2));
        assert!(stop_signal.load(Ordering::Acquire));
    }

    #[test]
    fn candidate_exit_during_termination_is_not_reported_as_failure() {
        let mut status_checks = 0;
        let stop_signal = AtomicBool::new(false);

        let result = terminate_candidate_processes(
            vec![10],
            |_| {
                status_checks += 1;
                Ok(false)
            },
            &stop_signal,
        );

        assert_eq!(result, Ok(0));
        assert_eq!(status_checks, 1);
        assert!(stop_signal.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn magpie_requires_live_foreground_session() {
        let game_id = next_test_game_id();
        let stop_signal = Arc::new(AtomicBool::new(false));
        let mut state = MonitorState::new(std::process::id(), HashSet::new());
        state.apply(MonitorEvent::GameForeground(std::process::id()));
        let game_directory = std::env::current_exe()
            .expect("test executable path is available")
            .parent()
            .expect("test executable has a parent directory")
            .to_path_buf();
        register_session(
            game_id,
            ActiveSession {
                stop_signal: stop_signal.clone(),
                canonical_game_directory: game_directory.canonicalize().ok(),
                game_directory,
                monitor_state: Arc::new(RwLock::new(state)),
            },
        );

        let ready = wait_for_game_foreground(game_id).await;
        stop_signal.store(true, Ordering::Release);
        let ready_after_stop = is_game_foreground(game_id);
        unregister_session(game_id);

        assert_eq!(ready, GameForegroundWaitOutcome::Ready);
        assert!(!ready_after_stop);
    }
}
