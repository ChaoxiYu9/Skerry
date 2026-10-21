use super::game_stats_calculation::{
    SessionFact, StatisticsProjection, calculate_statistics, custom_error,
    local_date_from_timestamp, manual_session_end_time,
};
#[cfg(test)]
use super::game_stats_calculation::{
    apply_session_delete, apply_session_insert, parse_daily_stats,
};
use crate::entity::prelude::*;
use crate::entity::{game_sessions, game_statistics};
use chrono::Local;
use sea_orm::sea_query::OnConflict;
use sea_orm::*;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, FromQueryResult)]
pub struct GameLastPlayed {
    pub game_id: i32,
    pub last_played: Option<i32>,
}

fn session_fact_from_model(session: &game_sessions::Model) -> SessionFact {
    SessionFact {
        start_time: session.start_time,
        end_time: session.end_time,
        duration: session.duration,
    }
}

/// 游戏统计仓库
pub struct GameStatsRepository;

impl GameStatsRepository {
    // ==================== 游戏会话操作 ====================

    async fn insert_session<C>(
        db: &C,
        game_id: i32,
        start_time: i32,
        end_time: i32,
        duration: i32,
        date: String,
    ) -> Result<game_sessions::Model, DbErr>
    where
        C: ConnectionTrait,
    {
        game_sessions::ActiveModel {
            session_id: NotSet,
            game_id: Set(game_id),
            start_time: Set(start_time),
            end_time: Set(end_time),
            duration: Set(duration),
            date: Set(date),
        }
        .insert(db)
        .await
    }

    /// 在同一事务内写入事实会话并从事实重建其统计投影。
    pub async fn record_session_with_statistics(
        db: &DatabaseConnection,
        game_id: i32,
        start_time: i32,
        end_time: i32,
        duration: i32,
    ) -> Result<game_sessions::Model, DbErr> {
        let date = local_date_from_timestamp(end_time)?;
        let transaction = db.begin().await?;
        let session =
            Self::insert_session(&transaction, game_id, start_time, end_time, duration, date)
                .await?;

        let projection = Self::calculate_projection(&transaction, game_id).await?;
        Self::upsert_projection(&transaction, game_id, projection).await?;
        transaction.commit().await?;
        Ok(session)
    }

    /// 根据开始时间和分钟数创建手动会话
    pub async fn create_manual_session(
        db: &DatabaseConnection,
        game_id: i32,
        start_time: i32,
        duration: i32,
    ) -> Result<game_sessions::Model, DbErr> {
        if game_id <= 0 {
            return Err(custom_error("游戏 ID 必须大于零"));
        }

        let current_time = super::current_database_timestamp()?;
        let end_time = manual_session_end_time(start_time, duration, current_time)?;

        Self::record_session_with_statistics(db, game_id, start_time, end_time, duration).await
    }

    /// 从事实会话重建指定游戏的统计投影
    pub async fn rebuild_statistics(db: &DatabaseConnection, game_id: i32) -> Result<(), DbErr> {
        if game_id <= 0 {
            return Err(custom_error("游戏 ID 必须大于零"));
        }

        let transaction = db.begin().await?;
        let projection = Self::calculate_projection(&transaction, game_id).await?;
        Self::upsert_projection(&transaction, game_id, projection).await?;
        transaction.commit().await
    }

    /// 获取游戏会话历史，按开始时间和记录 ID 倒序稳定分页
    pub async fn get_sessions(
        db: &DatabaseConnection,
        game_id: i32,
        limit: u64,
        offset: u64,
    ) -> Result<Vec<game_sessions::Model>, DbErr> {
        GameSessions::find()
            .filter(game_sessions::Column::GameId.eq(game_id))
            .order_by_desc(game_sessions::Column::StartTime)
            .order_by_desc(game_sessions::Column::SessionId)
            .limit(limit)
            .offset(offset)
            .all(db)
            .await
    }

    /// 获取指定游戏范围内的全局最近会话，按开始时间和记录 ID 倒序稳定分页
    pub async fn get_recent_sessions_for_all(
        db: &DatabaseConnection,
        game_ids: Vec<i32>,
        limit: u64,
        offset: u64,
    ) -> Result<Vec<game_sessions::Model>, DbErr> {
        if game_ids.is_empty() {
            return Ok(Vec::new());
        }

        let sessions = GameSessions::find()
            .filter(game_sessions::Column::GameId.is_in(game_ids))
            .order_by_desc(game_sessions::Column::StartTime)
            .order_by_desc(game_sessions::Column::SessionId)
            .limit(limit)
            .offset(offset)
            .all(db)
            .await?;

        Ok(sessions)
    }

    /// 在同一事务内删除事实会话并从剩余事实重建统计投影
    pub async fn delete_session_with_statistics(
        db: &DatabaseConnection,
        session_id: i32,
    ) -> Result<i32, DbErr> {
        let transaction = db.begin().await?;
        let session = GameSessions::find_by_id(session_id)
            .one(&transaction)
            .await?
            .ok_or_else(|| DbErr::RecordNotFound(format!("会话不存在: {session_id}")))?;
        GameSessions::delete_by_id(session_id)
            .exec(&transaction)
            .await?;
        let projection = Self::calculate_projection(&transaction, session.game_id).await?;
        Self::upsert_projection(&transaction, session.game_id, projection).await?;
        transaction.commit().await?;
        Ok(session.game_id)
    }

    // ==================== 游戏统计操作 ====================

    async fn calculate_projection<C>(db: &C, game_id: i32) -> Result<StatisticsProjection, DbErr>
    where
        C: ConnectionTrait,
    {
        let sessions = GameSessions::find()
            .filter(game_sessions::Column::GameId.eq(game_id))
            .all(db)
            .await?;

        let session_facts = sessions
            .iter()
            .map(session_fact_from_model)
            .collect::<Vec<_>>();
        calculate_statistics(&session_facts, &Local)
    }

    async fn upsert_projection(
        db: &DatabaseTransaction,
        game_id: i32,
        projection: StatisticsProjection,
    ) -> Result<(), DbErr> {
        let daily_stats = serde_json::to_string(&projection.daily_stats)
            .map_err(|error| custom_error(format!("序列化每日统计失败: {error}")))?;

        let statistics = game_statistics::ActiveModel {
            game_id: Set(game_id),
            total_time: Set(Some(projection.total_time)),
            session_count: Set(Some(projection.session_count)),
            last_played: Set(projection.last_played),
            daily_stats: Set(Some(daily_stats)),
        };

        GameStatistics::insert(statistics)
            .on_conflict(
                OnConflict::column(game_statistics::Column::GameId)
                    .update_columns([
                        game_statistics::Column::TotalTime,
                        game_statistics::Column::SessionCount,
                        game_statistics::Column::LastPlayed,
                        game_statistics::Column::DailyStats,
                    ])
                    .to_owned(),
            )
            .exec(db)
            .await?;
        Ok(())
    }

    /// 获取游戏统计信息
    pub async fn get_statistics(
        db: &DatabaseConnection,
        game_id: i32,
    ) -> Result<Option<game_statistics::Model>, DbErr> {
        GameStatistics::find_by_id(game_id).one(db).await
    }

    /// 获取所有游戏统计数据
    pub async fn get_all_statistics(
        db: &DatabaseConnection,
    ) -> Result<Vec<game_statistics::Model>, DbErr> {
        GameStatistics::find().all(db).await
    }

    /// 获取所有游戏的最近游玩时间，不包含 daily_stats 大字段。
    pub async fn get_all_last_played(
        db: &DatabaseConnection,
    ) -> Result<Vec<GameLastPlayed>, DbErr> {
        GameStatistics::find()
            .select_only()
            .column(game_statistics::Column::GameId)
            .column(game_statistics::Column::LastPlayed)
            .into_model::<GameLastPlayed>()
            .all(db)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::super::game_stats_calculation::{DailyStats, SessionFact};
    use super::*;
    use chrono::{FixedOffset, TimeZone};
    use sea_orm::{Database, Statement, TransactionTrait};

    fn timezone() -> FixedOffset {
        FixedOffset::east_opt(8 * 60 * 60).expect("固定时区应有效")
    }

    fn timestamp(day: u32, hour: u32) -> i32 {
        timezone()
            .with_ymd_and_hms(2026, 1, day, hour, 0, 0)
            .single()
            .expect("测试日期应有效")
            .timestamp()
            .try_into()
            .expect("测试时间戳应在 i32 范围内")
    }

    fn session(start_time: i32, end_time: i32, duration: i32) -> SessionFact {
        SessionFact {
            start_time,
            end_time,
            duration,
        }
    }

    async fn test_database() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("内存数据库应连接成功");
        db.execute_unprepared("PRAGMA foreign_keys = ON")
            .await
            .expect("应启用外键");
        db.execute_unprepared(
            r#"CREATE TABLE games (
                id INTEGER PRIMARY KEY,
                id_type TEXT NOT NULL
            )"#,
        )
        .await
        .expect("应创建 games 表");
        db.execute_unprepared(
            r#"CREATE TABLE game_sessions (
                session_id INTEGER PRIMARY KEY AUTOINCREMENT,
                game_id INTEGER NOT NULL,
                start_time INTEGER NOT NULL,
                end_time INTEGER NOT NULL,
                duration INTEGER NOT NULL,
                date TEXT NOT NULL,
                FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE
            )"#,
        )
        .await
        .expect("应创建 game_sessions 表");
        db.execute_unprepared(
            r#"CREATE TABLE game_statistics (
                game_id INTEGER PRIMARY KEY,
                total_time INTEGER,
                session_count INTEGER,
                last_played INTEGER,
                daily_stats TEXT,
                FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE
            )"#,
        )
        .await
        .expect("应创建 game_statistics 表");
        db.execute(Statement::from_string(
            DatabaseBackend::Sqlite,
            "INSERT INTO games (id, id_type) VALUES (1, 'custom')",
        ))
        .await
        .expect("应插入测试游戏");
        db
    }

    #[test]
    fn same_day_session_belongs_to_start_date() {
        let session = session(timestamp(1, 10), timestamp(1, 12), 90);

        let projection = calculate_statistics(&[session], &timezone()).expect("统计应成功");

        assert_eq!(
            projection.daily_stats,
            vec![DailyStats {
                date: "2026-01-01".to_string(),
                playtime: 90,
            }]
        );
    }

    #[test]
    fn multi_day_distribution_preserves_total_duration() {
        let session = session(timestamp(1, 23), timestamp(3, 1), 120);

        let projection = calculate_statistics(&[session.clone()], &timezone()).expect("统计应成功");

        assert_eq!(
            projection.daily_stats,
            vec![
                DailyStats {
                    date: "2026-01-03".to_string(),
                    playtime: 5,
                },
                DailyStats {
                    date: "2026-01-02".to_string(),
                    playtime: 110,
                },
                DailyStats {
                    date: "2026-01-01".to_string(),
                    playtime: 5,
                },
            ]
        );
        assert_eq!(
            projection
                .daily_stats
                .iter()
                .map(|item| item.playtime)
                .sum::<i32>(),
            session.duration
        );
    }

    #[test]
    fn incremental_insert_matches_full_calculation() {
        let sessions = vec![
            session(timestamp(1, 10), timestamp(1, 12), 90),
            session(timestamp(1, 23), timestamp(3, 1), 120),
            session(timestamp(3, 9), timestamp(3, 10), 45),
        ];
        let mut incremental = StatisticsProjection {
            total_time: 0,
            session_count: 0,
            last_played: None,
            daily_stats: Vec::new(),
        };

        for session in &sessions {
            apply_session_insert(&mut incremental, session, &timezone()).expect("增量统计应成功");
        }

        let complete = calculate_statistics(&sessions, &timezone()).expect("完整统计应成功");
        assert_eq!(incremental, complete);
        assert_eq!(complete.total_time, 255);
        assert_eq!(complete.session_count, 3);
        assert_eq!(complete.last_played, Some(timestamp(3, 10)));
    }

    #[test]
    fn incremental_delete_matches_remaining_sessions() {
        let sessions = vec![
            session(timestamp(1, 10), timestamp(1, 12), 90),
            session(timestamp(1, 23), timestamp(3, 1), 120),
            session(timestamp(3, 9), timestamp(3, 10), 45),
        ];
        let mut projection = calculate_statistics(&sessions, &timezone()).expect("完整统计应成功");

        apply_session_delete(
            &mut projection,
            &sessions[2],
            Some(sessions[1].end_time),
            &timezone(),
        )
        .expect("删除统计应成功");

        let expected = calculate_statistics(&sessions[..2], &timezone()).expect("完整统计应成功");
        assert_eq!(projection, expected);
    }

    #[test]
    fn deleting_a_non_latest_session_preserves_last_played() {
        let sessions = vec![
            session(timestamp(1, 10), timestamp(1, 12), 90),
            session(timestamp(2, 10), timestamp(2, 12), 120),
        ];
        let mut projection = calculate_statistics(&sessions, &timezone()).expect("完整统计应成功");

        apply_session_delete(&mut projection, &sessions[0], None, &timezone())
            .expect("删除较早会话应成功");

        let expected = calculate_statistics(&sessions[1..], &timezone()).expect("完整统计应成功");
        assert_eq!(projection, expected);
    }

    #[test]
    fn deleting_only_session_clears_projection() {
        let only_session = session(timestamp(1, 10), timestamp(1, 12), 90);
        let mut projection = calculate_statistics(std::slice::from_ref(&only_session), &timezone())
            .expect("完整统计应成功");

        apply_session_delete(&mut projection, &only_session, None, &timezone())
            .expect("删除统计应成功");

        assert_eq!(
            projection,
            StatisticsProjection {
                total_time: 0,
                session_count: 0,
                last_played: None,
                daily_stats: Vec::new(),
            }
        );
    }

    #[test]
    fn complete_calculation_has_no_session_limit() {
        let sessions = (1..=1001)
            .map(|_| session(timestamp(1, 10), timestamp(1, 11), 1))
            .collect::<Vec<_>>();

        let projection = calculate_statistics(&sessions, &timezone()).expect("完整统计应成功");

        assert_eq!(projection.total_time, 1001);
        assert_eq!(projection.session_count, 1001);
        assert_eq!(
            projection.daily_stats,
            vec![DailyStats {
                date: "2026-01-01".to_string(),
                playtime: 1001,
            }]
        );
    }

    #[test]
    fn full_calculation_merges_repeated_local_dates_and_sorts_newest_first() {
        let sessions = [
            session(timestamp(2, 10), timestamp(2, 11), 30),
            session(timestamp(1, 8), timestamp(1, 9), 45),
            session(timestamp(1, 22), timestamp(2, 2), 61),
        ];

        let projection = calculate_statistics(&sessions, &timezone()).expect("完整统计应成功");

        assert_eq!(projection.total_time, 136);
        assert_eq!(projection.session_count, 3);
        assert_eq!(projection.last_played, Some(timestamp(2, 11)));
        assert_eq!(
            projection.daily_stats,
            vec![
                DailyStats {
                    date: "2026-01-02".to_string(),
                    playtime: 60,
                },
                DailyStats {
                    date: "2026-01-01".to_string(),
                    playtime: 76,
                },
            ]
        );
    }

    #[test]
    fn invalid_projection_is_rejected_before_deletion() {
        let target = session(timestamp(1, 10), timestamp(1, 12), 90);
        let mut projection = StatisticsProjection {
            total_time: 10,
            session_count: 1,
            last_played: Some(target.end_time),
            daily_stats: vec![DailyStats {
                date: "2026-01-01".to_string(),
                playtime: 10,
            }],
        };

        assert!(apply_session_delete(&mut projection, &target, None, &timezone()).is_err());
    }

    #[test]
    fn failed_incremental_delete_leaves_the_input_projection_unchanged() {
        let target = session(timestamp(1, 10), timestamp(1, 12), 90);
        let mut projection = StatisticsProjection {
            total_time: 90,
            session_count: 1,
            last_played: Some(target.end_time),
            daily_stats: vec![DailyStats {
                date: "2026-01-01".to_string(),
                playtime: 89,
            }],
        };
        let original = projection.clone();

        assert!(apply_session_delete(&mut projection, &target, None, &timezone()).is_err());
        assert_eq!(projection, original);
    }

    #[test]
    fn manual_session_calculates_end_time() {
        assert_eq!(
            manual_session_end_time(1_700_000_000, 90, 1_700_010_000).expect("结束时间应可计算"),
            1_700_005_400
        );
    }

    fn manual_session_error_message(start_time: i32, duration: i32, current_time: i32) -> String {
        match manual_session_end_time(start_time, duration, current_time)
            .expect_err("手动会话输入应返回预期错误")
        {
            DbErr::Custom(message) => message,
            error => panic!("应返回自定义业务错误，实际为 {error:?}"),
        }
    }

    #[test]
    fn manual_session_rejects_future_end_time_and_overflow() {
        assert_eq!(
            manual_session_error_message(1_700_000_000, 90, 1_700_000_100),
            "结束时间不能晚于当前时间"
        );
        assert_eq!(
            manual_session_error_message(i32::MAX - 30, 1, i32::MAX),
            "结束时间超出支持范围"
        );
    }

    #[test]
    fn manual_session_end_time_preserves_minute_and_timestamp_boundaries() {
        assert_eq!(
            manual_session_end_time(100, 1, 160).expect("结束时间等于当前时间应可创建"),
            160
        );
        assert_eq!(
            manual_session_error_message(100, 1, 159),
            "结束时间不能晚于当前时间"
        );

        assert_eq!(
            manual_session_end_time(i32::MAX - 60, 1, i32::MAX)
                .expect("i32 时间戳上界应可精确表示"),
            i32::MAX
        );
        assert_eq!(
            manual_session_error_message(1, i32::MAX, i32::MAX),
            "游玩时长超出支持范围"
        );
    }

    #[test]
    fn manual_session_end_time_rejects_nonpositive_inputs() {
        assert_eq!(
            manual_session_error_message(0, 1, 100),
            "开始时间必须大于零"
        );
        assert!(manual_session_end_time(-1, 1, 100).is_err());
        assert_eq!(
            manual_session_error_message(1, 0, 100),
            "游玩时长必须大于零"
        );
        assert!(manual_session_end_time(1, -1, 100).is_err());
    }

    #[tokio::test]
    async fn manual_session_creation_persists_the_calculated_end_and_projection() {
        let db = test_database().await;
        let current_time =
            super::super::current_database_timestamp().expect("当前测试时间应可写入数据库");
        let start_time = current_time
            .checked_sub(60)
            .expect("测试开始时间应保持在数据库时间戳范围内");

        let inserted = GameStatsRepository::create_manual_session(&db, 1, start_time, 1)
            .await
            .expect("有效手动会话应写入");
        let projection = GameStatistics::find_by_id(1)
            .one(&db)
            .await
            .expect("统计投影查询应成功")
            .expect("手动会话应建立统计投影");

        assert_eq!(inserted.start_time, start_time);
        assert_eq!(inserted.end_time, start_time + 60);
        assert_eq!(inserted.duration, 1);
        assert_eq!(projection.total_time, Some(1));
        assert_eq!(projection.session_count, Some(1));
        assert_eq!(projection.last_played, Some(inserted.end_time));

        let daily_stats = parse_daily_stats(
            projection
                .daily_stats
                .as_deref()
                .expect("手动会话应写入每日统计"),
        )
        .expect("每日统计应保持有效格式");
        assert_eq!(daily_stats.len(), 1);
        assert_eq!(daily_stats[0].playtime, 1);
    }

    #[tokio::test]
    async fn session_insert_and_delete_update_statistics_atomically() {
        let db = test_database().await;
        let start_time = timestamp(1, 10);
        let end_time = timestamp(1, 12);

        let inserted =
            GameStatsRepository::record_session_with_statistics(&db, 1, start_time, end_time, 90)
                .await
                .expect("会话和统计应同时写入");
        let statistics = GameStatistics::find_by_id(1)
            .one(&db)
            .await
            .expect("统计查询应成功")
            .expect("统计记录应存在");

        assert_eq!(statistics.total_time, Some(90));
        assert_eq!(statistics.session_count, Some(1));
        assert_eq!(statistics.last_played, Some(end_time));

        GameStatsRepository::delete_session_with_statistics(&db, inserted.session_id)
            .await
            .expect("会话和统计应同时更新");
        let statistics = GameStatistics::find_by_id(1)
            .one(&db)
            .await
            .expect("统计查询应成功")
            .expect("统计记录应保留");

        assert_eq!(statistics.total_time, Some(0));
        assert_eq!(statistics.session_count, Some(0));
        assert_eq!(statistics.last_played, None);
        assert_eq!(statistics.daily_stats.as_deref(), Some("[]"));
    }

    #[tokio::test]
    async fn projection_upsert_inserts_and_replaces_every_derived_field() {
        let db = test_database().await;
        let transaction = db.begin().await.expect("事务应创建");
        let first = StatisticsProjection {
            total_time: 90,
            session_count: 1,
            last_played: Some(timestamp(1, 12)),
            daily_stats: vec![DailyStats {
                date: "2026-01-01".to_string(),
                playtime: 90,
            }],
        };
        GameStatsRepository::upsert_projection(&transaction, 1, first)
            .await
            .expect("首次应插入投影");

        let replacement = StatisticsProjection {
            total_time: 120,
            session_count: 2,
            last_played: None,
            daily_stats: vec![DailyStats {
                date: "2026-01-02".to_string(),
                playtime: 120,
            }],
        };
        GameStatsRepository::upsert_projection(&transaction, 1, replacement.clone())
            .await
            .expect("冲突时应替换同一统计投影");
        transaction.commit().await.expect("统计投影应提交");

        let stored = GameStatistics::find_by_id(1)
            .one(&db)
            .await
            .expect("投影查询应成功")
            .expect("统计行应存在");
        assert_eq!(stored.total_time, Some(replacement.total_time));
        assert_eq!(stored.session_count, Some(replacement.session_count));
        assert_eq!(stored.last_played, replacement.last_played);
        assert_eq!(
            stored.daily_stats,
            Some(serde_json::to_string(&replacement.daily_stats).expect("JSON 应序列化"))
        );
        assert_eq!(GameStatistics::find().all(&db).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn session_history_keeps_equal_start_times_in_id_order_across_pages() {
        let db = test_database().await;
        let start_time = timestamp(1, 10);
        let inserted_ids = [
            GameStatsRepository::insert_session(
                &db,
                1,
                start_time,
                start_time + 300,
                5,
                "2026-01-01".to_string(),
            )
            .await
            .expect("第一条会话应写入")
            .session_id,
            GameStatsRepository::insert_session(
                &db,
                1,
                start_time,
                start_time + 600,
                10,
                "2026-01-01".to_string(),
            )
            .await
            .expect("第二条会话应写入")
            .session_id,
            GameStatsRepository::insert_session(
                &db,
                1,
                start_time,
                start_time + 900,
                15,
                "2026-01-01".to_string(),
            )
            .await
            .expect("第三条会话应写入")
            .session_id,
        ];

        let game_history = GameStatsRepository::get_sessions(&db, 1, 1, 1)
            .await
            .expect("游戏会话分页应成功");
        assert_eq!(game_history[0].session_id, inserted_ids[1]);

        let first_page = GameStatsRepository::get_recent_sessions_for_all(&db, vec![1], 2, 0)
            .await
            .expect("首页活动第一页应成功");
        let second_page = GameStatsRepository::get_recent_sessions_for_all(&db, vec![1], 2, 2)
            .await
            .expect("首页活动第二页应成功");

        assert_eq!(
            first_page
                .iter()
                .map(|session| session.session_id)
                .collect::<Vec<_>>(),
            vec![inserted_ids[2], inserted_ids[1]]
        );
        assert_eq!(
            second_page
                .iter()
                .map(|session| session.session_id)
                .collect::<Vec<_>>(),
            vec![inserted_ids[0]]
        );
    }

    #[tokio::test]
    async fn statistics_failure_rolls_back_session_insert() {
        let db = test_database().await;
        db.execute_unprepared(
            r#"CREATE TRIGGER reject_statistics_insert
               BEFORE INSERT ON game_statistics
               BEGIN
                   SELECT RAISE(FAIL, 'forced statistics failure');
               END"#,
        )
        .await
        .expect("应创建失败触发器");

        let result = GameStatsRepository::record_session_with_statistics(
            &db,
            1,
            timestamp(1, 10),
            timestamp(1, 12),
            90,
        )
        .await;

        assert!(result.is_err());
        assert_eq!(
            GameSessions::find()
                .count(&db)
                .await
                .expect("会话计数应成功"),
            0
        );
    }

    #[tokio::test]
    async fn rebuild_statistics_repairs_existing_projection() {
        let db = test_database().await;
        let end_time = timestamp(1, 12);
        GameStatsRepository::record_session_with_statistics(&db, 1, timestamp(1, 10), end_time, 90)
            .await
            .expect("会话写入应成功");
        db.execute(Statement::from_string(
            DatabaseBackend::Sqlite,
            "UPDATE game_statistics SET total_time = 1, session_count = 99",
        ))
        .await
        .expect("应写入错误投影");

        GameStatsRepository::rebuild_statistics(&db, 1)
            .await
            .expect("单游戏统计应重建成功");
        let statistics = GameStatistics::find_by_id(1)
            .one(&db)
            .await
            .expect("统计查询应成功")
            .expect("统计记录应存在");

        assert_eq!(statistics.total_time, Some(90));
        assert_eq!(statistics.session_count, Some(1));
        assert_eq!(statistics.last_played, Some(end_time));
    }

    #[tokio::test]
    async fn recording_repairs_an_invalid_projection_from_session_facts() {
        let db = test_database().await;
        GameStatsRepository::record_session_with_statistics(
            &db,
            1,
            timestamp(1, 10),
            timestamp(1, 12),
            90,
        )
        .await
        .expect("首条会话和投影应写入");
        db.execute(Statement::from_string(
            DatabaseBackend::Sqlite,
            "UPDATE game_statistics SET daily_stats = 'not-json'",
        ))
        .await
        .expect("应注入损坏的每日投影");

        let second_end = timestamp(1, 15);
        GameStatsRepository::record_session_with_statistics(
            &db,
            1,
            timestamp(1, 14),
            second_end,
            45,
        )
        .await
        .expect("损坏投影应从事实会话重建后继续记录");

        let statistics = GameStatistics::find_by_id(1)
            .one(&db)
            .await
            .expect("统计查询应成功")
            .expect("重建后的投影应存在");
        assert_eq!(statistics.total_time, Some(135));
        assert_eq!(statistics.session_count, Some(2));
        assert_eq!(statistics.last_played, Some(second_end));
        let daily_stats: Vec<DailyStats> =
            serde_json::from_str(statistics.daily_stats.as_deref().expect("每日投影应存在"))
                .expect("每日投影 JSON 应有效");
        assert_eq!(daily_stats.iter().map(|day| day.playtime).sum::<i32>(), 135);
    }

    #[tokio::test]
    async fn deleting_with_an_inconsistent_projection_rebuilds_from_remaining_sessions() {
        let db = test_database().await;
        let first_end = timestamp(1, 12);
        let first = GameStatsRepository::record_session_with_statistics(
            &db,
            1,
            timestamp(1, 10),
            first_end,
            90,
        )
        .await
        .expect("第一条会话应写入");
        let second = GameStatsRepository::record_session_with_statistics(
            &db,
            1,
            timestamp(2, 10),
            timestamp(2, 12),
            120,
        )
        .await
        .expect("第二条会话应写入");
        db.execute(Statement::from_string(
            DatabaseBackend::Sqlite,
            "UPDATE game_statistics SET daily_stats = '[]'",
        ))
        .await
        .expect("应使每日投影不一致");

        GameStatsRepository::delete_session_with_statistics(&db, second.session_id)
            .await
            .expect("投影不一致时删除应从剩余事实会话重算");

        let statistics = GameStatistics::find_by_id(1)
            .one(&db)
            .await
            .expect("统计查询应成功")
            .expect("统计记录应存在");
        assert_eq!(statistics.total_time, Some(90));
        assert_eq!(statistics.session_count, Some(1));
        assert_eq!(statistics.last_played, Some(first_end));
        let daily_stats: Vec<serde_json::Value> =
            serde_json::from_str(statistics.daily_stats.as_deref().expect("每日统计应存在"))
                .expect("每日统计 JSON 应有效");
        assert_eq!(daily_stats.len(), 1);
        assert_eq!(daily_stats[0]["playtime"], 90);
        assert!(
            GameSessions::find_by_id(first.session_id)
                .one(&db)
                .await
                .expect("剩余会话查询应成功")
                .is_some()
        );
    }
}
