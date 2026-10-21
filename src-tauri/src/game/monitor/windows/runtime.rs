use super::foreground::{HookGuard, start_foreground_hook};
use super::processes::CandidateProcess;
use super::{
    ActiveSession, ForegroundPlaytime, MonitorState, ProcessLiveness, ProcessProgress,
    TimeTrackingMode, WindowsMonitorProgress, apply_recovery_selection,
    get_all_candidate_processes, get_timestamp, observe_process_liveness, register_session,
    select_recovery_pid, unregister_session,
};
use crate::game::monitor::session::{MonitoredSession, finalize_monitored_session};
use log::{debug, info, warn};
use sea_orm::DatabaseConnection;
use serde_json::json;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::time::{Instant, MissedTickBehavior, interval};

const INITIAL_SETTLE: Duration = Duration::from_secs(3);
const STOP_POLL: Duration = Duration::from_millis(200);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(super::STARTUP_TIMEOUT_SECS);

struct SessionRegistration {
    game_id: u32,
    active: bool,
}

impl SessionRegistration {
    fn new(game_id: u32) -> Self {
        Self {
            game_id,
            active: true,
        }
    }

    fn clear(&mut self) {
        if self.active {
            unregister_session(self.game_id);
            self.active = false;
        }
    }
}

impl Drop for SessionRegistration {
    fn drop(&mut self) {
        self.clear();
    }
}

pub(super) async fn run_game_monitor<R: Runtime>(
    app_handle: AppHandle<R>,
    db: DatabaseConnection,
    time_tracking_mode: TimeTrackingMode,
    game_id: u32,
    initial_pid: u32,
    detection_dir: String,
) -> Result<(), String> {
    let started_at = Instant::now();
    let start_time = get_timestamp();
    let game_directory = PathBuf::from(&detection_dir);
    let canonical_directory = game_directory.canonicalize().ok();
    let initial_candidates =
        initial_process_candidates(initial_pid, &game_directory, canonical_directory.as_deref());
    let state = Arc::new(parking_lot::RwLock::new(MonitorState::new(
        initial_pid,
        initial_candidates.clone(),
    )));
    let stop_signal = Arc::new(AtomicBool::new(false));

    register_session(
        game_id,
        ActiveSession {
            stop_signal: stop_signal.clone(),
            game_directory: game_directory.clone(),
            canonical_game_directory: canonical_directory.clone(),
            monitor_state: state.clone(),
        },
    );
    let mut registration = SessionRegistration::new(game_id);
    let _hook_guard = HookGuard::new(stop_signal.clone());
    start_foreground_hook(state.clone(), detection_dir.clone(), stop_signal.clone());

    info!(
        "开始监控游戏: ID={}, 初始 PID={}, 候选进程组={:?}, 游戏目录={}",
        game_id, initial_pid, initial_candidates, detection_dir
    );
    wait_for_initial_settle(&stop_signal).await;
    if !stop_signal.load(Ordering::Acquire) {
        merge_initial_process_scan(game_id, &detection_dir, &state);
    }
    publish_session_started(&app_handle, game_id, start_time, &state, &stop_signal);

    let mut process_health = WindowsMonitorProgress::new(state.read().snapshot().best_pid);
    let mut playtime = ForegroundPlaytime::default();
    let mut checks = interval(Duration::from_secs(super::MONITOR_CHECK_INTERVAL_SECS));
    checks.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        checks.tick().await;
        if stop_signal.load(Ordering::Acquire) {
            debug!("收到停止信号，结束监控游戏 {}", game_id);
            break;
        }

        let snapshot = state.read().snapshot();
        if !snapshot.has_started() && started_at.elapsed() >= STARTUP_TIMEOUT {
            info!(
                "游戏启动等待超过 {} 秒，结束监控",
                STARTUP_TIMEOUT.as_secs()
            );
            break;
        }

        let liveness = observe_process_liveness(
            snapshot.best_pid,
            Path::new(&detection_dir),
            canonical_directory.as_deref(),
        );
        if let ProcessLiveness::Unknown(message) = &liveness {
            debug!(
                "无法确认游戏进程 {} 状态，保留本轮监控状态: {message}",
                snapshot.best_pid
            );
        }
        let time_update = playtime.observe(
            Instant::now(),
            liveness == ProcessLiveness::Running && snapshot.is_foreground(),
        );

        match process_health.observe_process(snapshot.best_pid, &liveness) {
            ProcessProgress::Running { previous_best_pid } => {
                if let Some(previous_best_pid) = previous_best_pid {
                    debug!(
                        "检测到进程切换: {} -> {}",
                        previous_best_pid, snapshot.best_pid
                    );
                }
                if let Some(total_seconds) = time_update {
                    emit_time_update(
                        &app_handle,
                        game_id,
                        start_time,
                        snapshot.best_pid,
                        total_seconds,
                    );
                }
            }
            ProcessProgress::Missing {
                failure_count,
                recovery_due,
            } => {
                debug!(
                    "最佳进程 {} 检查失败次数: {}/{}",
                    snapshot.best_pid,
                    failure_count,
                    super::MAX_CONSECUTIVE_FAILURES
                );
                if recovery_due
                    && recover_monitor_anchor(
                        game_id,
                        &detection_dir,
                        started_at,
                        snapshot,
                        &state,
                        &mut process_health,
                    )
                {
                    continue;
                }
                if recovery_due {
                    info!("未找到可切换的活动候选进程，结束监控会话");
                    break;
                }
            }
            ProcessProgress::LivenessUnknown => continue,
        }
    }

    registration.clear();
    let confirmed_started = state.read().snapshot().has_started();
    let session = MonitoredSession {
        time_tracking_mode,
        game_id,
        process_id: process_health.last_best_pid,
        start_time,
        end_time: get_timestamp(),
        accumulated_seconds: playtime.total_seconds(),
        confirmed_started,
    };
    finalize_monitored_session(&app_handle, &db, session).await;
    Ok(())
}

fn initial_process_candidates(
    initial_pid: u32,
    game_directory: &Path,
    canonical_directory: Option<&Path>,
) -> HashSet<u32> {
    match observe_process_liveness(initial_pid, game_directory, canonical_directory) {
        ProcessLiveness::Running => HashSet::from([initial_pid]),
        ProcessLiveness::Exited
        | ProcessLiveness::OutsideGameDirectory
        | ProcessLiveness::NoProcessIdentity => HashSet::new(),
        ProcessLiveness::Unknown(message) => {
            debug!(
                "无法确认初始游戏进程 {} 状态，将由监控循环重试: {message}",
                initial_pid
            );
            HashSet::new()
        }
    }
}

async fn wait_for_initial_settle(stop_signal: &AtomicBool) {
    let delay = tokio::time::sleep(INITIAL_SETTLE);
    tokio::pin!(delay);
    let mut stop_checks = interval(STOP_POLL);
    stop_checks.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = &mut delay => break,
            _ = stop_checks.tick() => {
                if stop_signal.load(Ordering::Acquire) {
                    break;
                }
            }
        }
    }
}

fn merge_initial_process_scan(
    game_id: u32,
    detection_dir: &str,
    state: &parking_lot::RwLock<MonitorState>,
) {
    match get_all_candidate_processes(detection_dir) {
        Ok(candidates) => state
            .write()
            .extend_candidates(candidates.iter().map(CandidateProcess::process_id)),
        Err(message) => warn!(
            "初始游戏进程扫描不完整，保留现有候选并等待监控重试 game_id={}: {}",
            game_id, message
        ),
    }
}

fn publish_session_started<R: Runtime>(
    app_handle: &AppHandle<R>,
    game_id: u32,
    start_time: u64,
    state: &parking_lot::RwLock<MonitorState>,
    stop_signal: &AtomicBool,
) {
    if stop_signal.load(Ordering::Acquire) {
        return;
    }
    let process_id = state.read().snapshot().best_pid;
    if let Err(message) = app_handle.emit(
        "game-session-started",
        json!({ "gameId": game_id, "processId": process_id, "startTime": start_time }),
    ) {
        warn!("无法发送 game-session-started 事件: {message}");
    }
}

fn emit_time_update<R: Runtime>(
    app_handle: &AppHandle<R>,
    game_id: u32,
    start_time: u64,
    process_id: u32,
    total_seconds: u64,
) {
    let payload = json!({
        "gameId": game_id,
        "totalMinutes": total_seconds / 60,
        "totalSeconds": total_seconds,
        "startTime": start_time,
        "currentTime": get_timestamp(),
        "processId": process_id,
    });
    if let Err(message) = app_handle.emit("game-time-update", payload) {
        warn!("无法发送 game-time-update 事件: {message}");
    }
}

fn recover_monitor_anchor(
    game_id: u32,
    detection_dir: &str,
    started_at: Instant,
    current: super::MonitorSnapshot,
    state: &parking_lot::RwLock<MonitorState>,
    progress: &mut WindowsMonitorProgress,
) -> bool {
    let candidates = match get_all_candidate_processes(detection_dir) {
        Ok(candidates) => candidates,
        Err(message) => {
            warn!(
                "游戏候选扫描不完整，保留当前会话并在后续周期重试 game_id={}: {}",
                game_id, message
            );
            return true;
        }
    };
    let foreground_pid = super::foreground::get_foreground_pid();
    let selection = select_recovery_pid(&candidates, foreground_pid, |candidate| {
        match candidate.image().query_running() {
            Ok(true) => ProcessLiveness::Running,
            Ok(false) => ProcessLiveness::Exited,
            Err(message) => ProcessLiveness::Unknown(format!(
                "无法查询进程 {} 状态: {}",
                candidate.process_id(),
                message
            )),
        }
    });
    let selected_pid = match selection {
        super::RecoverySelection::Selected(pid) => Some(pid),
        super::RecoverySelection::NoLiveCandidate => None,
        super::RecoverySelection::Indeterminate(unknown) => {
            debug!(
                "候选进程存活状态未知 {:?}，保留当前会话并在下个监控周期重试",
                unknown
            );
            return true;
        }
    };
    let discovered_pids = candidates
        .iter()
        .map(CandidateProcess::process_id)
        .collect::<Vec<_>>();
    if apply_recovery_selection(&discovered_pids, selected_pid, state, progress).is_some() {
        return true;
    }

    let startup_expired = started_at.elapsed() >= STARTUP_TIMEOUT;
    if progress.may_retry_recovery_before_startup_timeout(current.has_started(), startup_expired) {
        debug!("游戏尚未确认启动，目录暂时无活动候选进程，继续等待");
        return true;
    }
    false
}
