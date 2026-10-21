use crate::database::repository::game_stats_repository::GameStatsRepository;
use log::{error, info, warn};
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};

const MIN_SESSION_SECONDS: u64 = 60;
const SESSION_ENDED_EVENT: &str = "game-session-ended";

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TimeTrackingMode {
    Playtime,
    Elapsed,
}

fn round_seconds_to_minutes(seconds: u64) -> u64 {
    seconds / 60 + u64::from(seconds % 60 >= 30)
}

pub(crate) struct MonitoredSession {
    pub time_tracking_mode: TimeTrackingMode,
    pub game_id: u32,
    pub process_id: u32,
    pub start_time: u64,
    pub end_time: u64,
    pub accumulated_seconds: u64,
    pub confirmed_started: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DatabaseSessionInput {
    game_id: i32,
    start_time: i32,
    end_time: i32,
    duration_minutes: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SkipReason {
    LaunchNotConfirmed,
    BelowMinimumDuration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RejectionReason {
    EndBeforeStart,
    DatabaseIntegerRange,
}

impl RejectionReason {
    fn message(self) -> &'static str {
        match self {
            Self::EndBeforeStart => "会话结束时间早于开始时间",
            Self::DatabaseIntegerRange => "游戏会话数据超出数据库整数范围",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum SessionDecision {
    Skip(SkipReason),
    Reject {
        duration_minutes: u64,
        reason: RejectionReason,
    },
    Record {
        input: DatabaseSessionInput,
        duration_minutes: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionEndedEvent {
    game_id: u32,
    start_time: u64,
    end_time: u64,
    total_minutes: u64,
    total_seconds: u64,
    process_id: u32,
    recorded: bool,
    session_id: Option<i32>,
    duration_minutes: u64,
    record_error: Option<String>,
}

fn effective_session_seconds(session: &MonitoredSession) -> Result<u64, RejectionReason> {
    match session.time_tracking_mode {
        TimeTrackingMode::Playtime => Ok(session.accumulated_seconds),
        TimeTrackingMode::Elapsed => session
            .end_time
            .checked_sub(session.start_time)
            .ok_or(RejectionReason::EndBeforeStart),
    }
}

fn database_session_input(
    session: &MonitoredSession,
    duration_minutes: u64,
) -> Result<DatabaseSessionInput, RejectionReason> {
    Ok(DatabaseSessionInput {
        game_id: i32::try_from(session.game_id)
            .map_err(|_| RejectionReason::DatabaseIntegerRange)?,
        start_time: i32::try_from(session.start_time)
            .map_err(|_| RejectionReason::DatabaseIntegerRange)?,
        end_time: i32::try_from(session.end_time)
            .map_err(|_| RejectionReason::DatabaseIntegerRange)?,
        duration_minutes: i32::try_from(duration_minutes)
            .map_err(|_| RejectionReason::DatabaseIntegerRange)?,
    })
}

fn decide_session(session: &MonitoredSession) -> SessionDecision {
    if !session.confirmed_started {
        return SessionDecision::Skip(SkipReason::LaunchNotConfirmed);
    }

    let effective_seconds = match effective_session_seconds(session) {
        Ok(seconds) => seconds,
        Err(reason) => {
            return SessionDecision::Reject {
                duration_minutes: 0,
                reason,
            };
        }
    };
    if effective_seconds < MIN_SESSION_SECONDS {
        return SessionDecision::Skip(SkipReason::BelowMinimumDuration);
    }

    let duration_minutes = round_seconds_to_minutes(effective_seconds);
    match database_session_input(session, duration_minutes) {
        Ok(input) => SessionDecision::Record {
            input,
            duration_minutes,
        },
        Err(reason) => SessionDecision::Reject {
            duration_minutes,
            reason,
        },
    }
}

async fn settle_monitored_session(
    db: &DatabaseConnection,
    session: MonitoredSession,
) -> SessionEndedEvent {
    let decision = decide_session(&session);
    let total_minutes = round_seconds_to_minutes(session.accumulated_seconds);

    let (recorded, session_id, duration_minutes, record_error) = match decision {
        SessionDecision::Skip(SkipReason::LaunchNotConfirmed) => {
            info!(
                "游戏会话未确认启动: game_id={}, mode={:?}",
                session.game_id, session.time_tracking_mode
            );
            (false, None, 0, None)
        }
        SessionDecision::Skip(SkipReason::BelowMinimumDuration) => {
            info!(
                "游戏会话低于记录阈值: game_id={}, mode={:?}",
                session.game_id, session.time_tracking_mode
            );
            (false, None, 0, None)
        }
        SessionDecision::Reject {
            duration_minutes,
            reason,
        } => {
            let message = reason.message().to_string();
            match reason {
                RejectionReason::EndBeforeStart => {
                    error!("计算游戏会话时长失败: {message}");
                }
                RejectionReason::DatabaseIntegerRange => error!("{message}"),
            }
            (false, None, duration_minutes, Some(message))
        }
        SessionDecision::Record {
            input,
            duration_minutes,
        } => match GameStatsRepository::record_session_with_statistics(
            db,
            input.game_id,
            input.start_time,
            input.end_time,
            input.duration_minutes,
        )
        .await
        {
            Ok(recorded_session) => {
                info!(
                    "游戏会话已记录: game_id={}, session_id={}, duration={}分钟",
                    input.game_id, recorded_session.session_id, input.duration_minutes
                );
                (
                    true,
                    Some(recorded_session.session_id),
                    duration_minutes,
                    None,
                )
            }
            Err(error) => {
                let message = format!("记录游戏会话失败: {error}");
                error!("{message}");
                (false, None, duration_minutes, Some(message))
            }
        },
    };

    SessionEndedEvent {
        game_id: session.game_id,
        start_time: session.start_time,
        end_time: session.end_time,
        total_minutes,
        total_seconds: session.accumulated_seconds,
        process_id: session.process_id,
        recorded,
        session_id,
        duration_minutes,
        record_error,
    }
}

pub(crate) async fn finalize_monitored_session<R: Runtime>(
    app_handle: &AppHandle<R>,
    db: &DatabaseConnection,
    session: MonitoredSession,
) {
    let event = settle_monitored_session(db, session).await;

    if let Err(error) = app_handle.emit(SESSION_ENDED_EVENT, event) {
        warn!("无法发送 game-session-ended 事件: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::{ConnectionTrait, Database};

    fn monitored_session(
        mode: TimeTrackingMode,
        start_time: u64,
        end_time: u64,
        accumulated_seconds: u64,
        confirmed_started: bool,
    ) -> MonitoredSession {
        MonitoredSession {
            time_tracking_mode: mode,
            game_id: 1,
            process_id: 7,
            start_time,
            end_time,
            accumulated_seconds,
            confirmed_started,
        }
    }

    #[test]
    fn playtime_mode_uses_accumulated_foreground_time() {
        assert_eq!(
            decide_session(&monitored_session(
                TimeTrackingMode::Playtime,
                100,
                1000,
                95,
                true
            )),
            SessionDecision::Record {
                input: DatabaseSessionInput {
                    game_id: 1,
                    start_time: 100,
                    end_time: 1000,
                    duration_minutes: 2,
                },
                duration_minutes: 2,
            }
        );
    }

    #[test]
    fn elapsed_mode_uses_wall_clock_time() {
        assert_eq!(
            decide_session(&monitored_session(
                TimeTrackingMode::Elapsed,
                100,
                195,
                10,
                true
            )),
            SessionDecision::Record {
                input: DatabaseSessionInput {
                    game_id: 1,
                    start_time: 100,
                    end_time: 195,
                    duration_minutes: 2,
                },
                duration_minutes: 2,
            }
        );
    }

    #[test]
    fn duration_below_threshold_is_not_recorded() {
        assert_eq!(
            decide_session(&monitored_session(
                TimeTrackingMode::Playtime,
                100,
                159,
                59,
                true
            )),
            SessionDecision::Skip(SkipReason::BelowMinimumDuration)
        );
    }

    #[test]
    fn unconfirmed_launch_is_not_recorded_in_elapsed_mode() {
        assert_eq!(
            decide_session(&monitored_session(
                TimeTrackingMode::Elapsed,
                100,
                200,
                0,
                false
            )),
            SessionDecision::Skip(SkipReason::LaunchNotConfirmed)
        );
    }

    #[test]
    fn minute_rounding_keeps_existing_half_minute_boundary() {
        for (seconds, expected_minutes) in [(60, 1), (89, 1), (90, 2)] {
            let decision = decide_session(&monitored_session(
                TimeTrackingMode::Playtime,
                100,
                200,
                seconds,
                true,
            ));

            assert!(matches!(
                decision,
                SessionDecision::Record {
                    duration_minutes,
                    ..
                } if duration_minutes == expected_minutes
            ));
        }
    }

    #[test]
    fn elapsed_time_reversal_is_rejected_without_a_duration() {
        assert_eq!(
            decide_session(&monitored_session(
                TimeTrackingMode::Elapsed,
                200,
                100,
                0,
                true
            )),
            SessionDecision::Reject {
                duration_minutes: 0,
                reason: RejectionReason::EndBeforeStart,
            }
        );
    }

    #[test]
    fn database_range_rejection_keeps_the_calculated_event_duration() {
        let mut session = monitored_session(TimeTrackingMode::Playtime, 100, 200, 90, true);
        session.game_id = u32::MAX;

        assert_eq!(
            decide_session(&session),
            SessionDecision::Reject {
                duration_minutes: 2,
                reason: RejectionReason::DatabaseIntegerRange,
            }
        );
    }

    #[test]
    fn database_fields_accept_the_i32_upper_boundary() {
        let maximum = u64::try_from(i32::MAX).expect("i32 上界应可转为 u64");
        let maximum_game_id = u32::try_from(i32::MAX).expect("i32 上界应可转为 u32");
        let maximum_duration_seconds = maximum * 60;
        let mut session = monitored_session(
            TimeTrackingMode::Playtime,
            maximum,
            maximum,
            maximum_duration_seconds,
            true,
        );
        session.game_id = maximum_game_id;

        assert_eq!(
            decide_session(&session),
            SessionDecision::Record {
                input: DatabaseSessionInput {
                    game_id: i32::MAX,
                    start_time: i32::MAX,
                    end_time: i32::MAX,
                    duration_minutes: i32::MAX,
                },
                duration_minutes: maximum,
            }
        );
    }

    #[test]
    fn database_fields_above_i32_upper_boundary_are_rejected() {
        let maximum = u64::try_from(i32::MAX).expect("i32 上界应可转为 u64");
        let maximum_game_id = u32::try_from(i32::MAX).expect("i32 上界应可转为 u32");
        let over_maximum_game_id = maximum_game_id + 1;
        let over_maximum_duration_seconds = maximum * 60 + 30;
        let mut game_id_overflow =
            monitored_session(TimeTrackingMode::Playtime, 100, 200, 90, true);
        game_id_overflow.game_id = over_maximum_game_id;
        let mut start_time_overflow =
            monitored_session(TimeTrackingMode::Playtime, maximum + 1, 200, 90, true);
        start_time_overflow.game_id = 1;
        let mut end_time_overflow =
            monitored_session(TimeTrackingMode::Playtime, 100, maximum + 1, 90, true);
        end_time_overflow.game_id = 1;
        let duration_overflow = monitored_session(
            TimeTrackingMode::Playtime,
            100,
            200,
            over_maximum_duration_seconds,
            true,
        );

        for session in [
            game_id_overflow,
            start_time_overflow,
            end_time_overflow,
            duration_overflow,
        ] {
            assert!(matches!(
                decide_session(&session),
                SessionDecision::Reject { .. }
            ));
        }
    }

    #[tokio::test]
    async fn rejected_database_range_never_attempts_storage_and_keeps_event_duration() {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("内存数据库应连接成功");
        let mut session = monitored_session(TimeTrackingMode::Playtime, 100, 200, 90, true);
        session.game_id = u32::MAX;

        let event = settle_monitored_session(&db, session).await;

        assert!(!event.recorded);
        assert_eq!(event.session_id, None);
        assert_eq!(event.duration_minutes, 2);
        assert_eq!(
            event.record_error.as_deref(),
            Some("游戏会话数据超出数据库整数范围")
        );
    }

    async fn settlement_database() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("内存数据库应连接成功");
        db.execute_unprepared("CREATE TABLE games (id INTEGER PRIMARY KEY, id_type TEXT NOT NULL)")
            .await
            .expect("应创建 games 表");
        db.execute_unprepared(
            "CREATE TABLE game_sessions (session_id INTEGER PRIMARY KEY AUTOINCREMENT, game_id INTEGER NOT NULL, start_time INTEGER NOT NULL, end_time INTEGER NOT NULL, duration INTEGER NOT NULL, date TEXT NOT NULL)",
        )
        .await
        .expect("应创建 game_sessions 表");
        db.execute_unprepared(
            "CREATE TABLE game_statistics (game_id INTEGER PRIMARY KEY, total_time INTEGER, session_count INTEGER, last_played INTEGER, daily_stats TEXT)",
        )
        .await
        .expect("应创建 game_statistics 表");
        db.execute_unprepared("INSERT INTO games (id, id_type) VALUES (1, 'custom')")
            .await
            .expect("应插入测试游戏");
        db
    }

    #[tokio::test]
    async fn successful_settlement_returns_the_database_identity_and_event_contract() {
        let db = settlement_database().await;
        let event = settle_monitored_session(
            &db,
            monitored_session(
                TimeTrackingMode::Elapsed,
                1_000_000_000,
                1_000_000_095,
                10,
                true,
            ),
        )
        .await;

        assert!(event.recorded);
        assert_eq!(event.session_id, Some(1));
        assert_eq!(event.duration_minutes, 2);
        assert_eq!(event.total_seconds, 10);

        let payload = serde_json::to_value(event).expect("结束事件应可序列化");
        assert_eq!(payload["gameId"], 1);
        assert_eq!(payload["startTime"], 1_000_000_000_u64);
        assert_eq!(payload["endTime"], 1_000_000_095_u64);
        assert_eq!(payload["totalMinutes"], 0);
        assert_eq!(payload["totalSeconds"], 10);
        assert_eq!(payload["processId"], 7);
        assert_eq!(payload["recorded"], true);
        assert_eq!(payload["sessionId"], 1);
        assert_eq!(payload["durationMinutes"], 2);
        assert!(payload["recordError"].is_null());
    }

    #[tokio::test]
    async fn database_failure_keeps_candidate_duration_and_returns_a_visible_error() {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("内存数据库应连接成功");
        let event = settle_monitored_session(
            &db,
            monitored_session(TimeTrackingMode::Playtime, 100, 200, 90, true),
        )
        .await;

        assert!(!event.recorded);
        assert_eq!(event.session_id, None);
        assert_eq!(event.duration_minutes, 2);
        assert!(
            event
                .record_error
                .as_deref()
                .is_some_and(|message| message.starts_with("记录游戏会话失败:"))
        );
    }
}
