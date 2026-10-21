//! Skerry 的会话事实到统计投影转换。
//!
//! 会话行是唯一事实来源。统计只按事实重算：同日会话的分钟数归到开始日期，
//! 跨日会话按各本地日实际覆盖秒数分配，累计半入舍入，保证每日合计等于记录时长。

use chrono::{Local, LocalResult, NaiveTime, TimeZone};
use sea_orm::DbErr;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct DailyStats {
    pub(super) date: String,
    pub(super) playtime: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct StatisticsProjection {
    pub(super) total_time: i32,
    pub(super) session_count: i32,
    pub(super) last_played: Option<i32>,
    pub(super) daily_stats: Vec<DailyStats>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SessionFact {
    pub(super) start_time: i32,
    pub(super) end_time: i32,
    pub(super) duration: i32,
}

struct SessionContribution {
    daily_stats: Vec<DailyStats>,
}

pub(super) fn custom_error(message: impl Into<String>) -> DbErr {
    DbErr::Custom(message.into())
}

fn timestamp_in_timezone<Tz: TimeZone>(
    timezone: &Tz,
    timestamp: i32,
) -> Result<chrono::DateTime<Tz>, DbErr> {
    match timezone.timestamp_opt(i64::from(timestamp), 0) {
        LocalResult::Single(datetime) => Ok(datetime),
        _ => Err(custom_error(format!("无效时间戳: {timestamp}"))),
    }
}

pub(super) fn local_date_from_timestamp(timestamp: i32) -> Result<String, DbErr> {
    Ok(timestamp_in_timezone(&Local, timestamp)?
        .format("%Y-%m-%d")
        .to_string())
}

pub(super) fn manual_session_end_time(
    start_time: i32,
    duration: i32,
    current_time: i32,
) -> Result<i32, DbErr> {
    if start_time <= 0 {
        return Err(custom_error("开始时间必须大于零"));
    }
    if duration <= 0 {
        return Err(custom_error("游玩时长必须大于零"));
    }

    let duration_seconds = i64::from(duration) * 60;
    let duration_seconds =
        i32::try_from(duration_seconds).map_err(|_| custom_error("游玩时长超出支持范围"))?;
    let end_time = i64::from(start_time) + i64::from(duration_seconds);
    let end_time = i32::try_from(end_time).map_err(|_| custom_error("结束时间超出支持范围"))?;
    if end_time > current_time {
        return Err(custom_error("结束时间不能晚于当前时间"));
    }
    Ok(end_time)
}

fn next_midnight_timestamp<Tz: TimeZone>(
    timezone: &Tz,
    date: chrono::NaiveDate,
) -> Result<i64, DbErr> {
    let next_date = date
        .succ_opt()
        .ok_or_else(|| custom_error("计算下一日期时溢出"))?;
    timezone
        .from_local_datetime(&next_date.and_time(NaiveTime::MIN))
        .earliest()
        .map(|datetime| datetime.timestamp())
        .ok_or_else(|| custom_error(format!("无法解析本地日期: {next_date}")))
}

fn cumulative_minutes(
    elapsed_seconds: i128,
    total_seconds: i128,
    duration_minutes: i32,
) -> Result<i32, DbErr> {
    if elapsed_seconds < 0 || total_seconds <= 0 || elapsed_seconds > total_seconds {
        return Err(custom_error("每日统计分配区间无效"));
    }

    let weighted = elapsed_seconds
        .checked_mul(i128::from(duration_minutes))
        .ok_or_else(|| custom_error("每日时长分配计算溢出"))?;
    let whole = weighted / total_seconds;
    let remainder = weighted % total_seconds;
    let half_up_threshold = total_seconds / 2 + total_seconds % 2;
    let rounded = whole + if remainder >= half_up_threshold { 1 } else { 0 };
    i32::try_from(rounded).map_err(|_| custom_error("分钟数超出 i32 范围"))
}

#[cfg(test)]
fn allocate_segment_minutes(
    segment_seconds: i128,
    duration_minutes: i32,
    total_seconds: i128,
    rounding_remainder: &mut i128,
) -> Result<i32, DbErr> {
    if segment_seconds < 0 || total_seconds <= 0 {
        return Err(custom_error("取整参数必须为非负数且分母必须大于零"));
    }
    let weighted = segment_seconds
        .checked_mul(i128::from(duration_minutes))
        .and_then(|value| value.checked_add(*rounding_remainder))
        .ok_or_else(|| custom_error("每日时长分配计算溢出"))?;
    let minutes = weighted / total_seconds;
    *rounding_remainder = weighted % total_seconds;
    i32::try_from(minutes).map_err(|_| custom_error("分钟数超出 i32 范围"))
}

fn session_contribution<Tz: TimeZone>(
    session: &SessionFact,
    timezone: &Tz,
) -> Result<SessionContribution, DbErr> {
    if session.start_time <= 0 || session.end_time <= session.start_time {
        return Err(custom_error("会话起止时间无效"));
    }
    if session.duration <= 0 {
        return Err(custom_error("会话时长必须大于零"));
    }

    let start = timestamp_in_timezone(timezone, session.start_time)?;
    let end = timestamp_in_timezone(timezone, session.end_time)?;
    let start_date = start.date_naive();
    let end_date = end.date_naive();
    if start_date == end_date {
        return Ok(SessionContribution {
            daily_stats: vec![DailyStats {
                date: start_date.format("%Y-%m-%d").to_string(),
                playtime: session.duration,
            }],
        });
    }

    let total_seconds = i128::from(i64::from(session.end_time) - i64::from(session.start_time));
    let mut assigned_minutes = 0_i32;
    let mut current_date = start_date;
    let mut daily_stats = Vec::new();

    while current_date < end_date {
        let boundary =
            next_midnight_timestamp(timezone, current_date)?.min(i64::from(session.end_time));
        let elapsed = i128::from(boundary - i64::from(session.start_time));
        let cumulative = cumulative_minutes(elapsed, total_seconds, session.duration)?;
        let segment_minutes = cumulative
            .checked_sub(assigned_minutes)
            .ok_or_else(|| custom_error("每日时长分配顺序无效"))?;
        if segment_minutes > 0 {
            daily_stats.push(DailyStats {
                date: current_date.format("%Y-%m-%d").to_string(),
                playtime: segment_minutes,
            });
        }
        assigned_minutes = cumulative;
        current_date = current_date
            .succ_opt()
            .ok_or_else(|| custom_error("计算下一日期时溢出"))?;
    }

    let final_minutes = session
        .duration
        .checked_sub(assigned_minutes)
        .ok_or_else(|| custom_error("每日时长分配顺序无效"))?;
    if final_minutes > 0 {
        daily_stats.push(DailyStats {
            date: end_date.format("%Y-%m-%d").to_string(),
            playtime: final_minutes,
        });
    }

    let distributed = daily_stats.iter().try_fold(0_i32, |sum, day| {
        sum.checked_add(day.playtime)
            .ok_or_else(|| custom_error("每日时长总和溢出"))
    })?;
    if distributed != session.duration {
        return Err(custom_error("每日时长分配总和与会话时长不一致"));
    }
    Ok(SessionContribution { daily_stats })
}

#[cfg(test)]
pub(super) fn daily_stats_map(daily_stats: &[DailyStats]) -> Result<BTreeMap<String, i32>, DbErr> {
    let mut by_date = BTreeMap::new();
    for day in daily_stats {
        if day.playtime < 0 {
            return Err(custom_error("每日统计不能为负数"));
        }
        if by_date.insert(day.date.clone(), day.playtime).is_some() {
            return Err(custom_error(format!("每日统计包含重复日期: {}", day.date)));
        }
    }
    Ok(by_date)
}

fn daily_stats_from_map(by_date: BTreeMap<String, i32>) -> Vec<DailyStats> {
    by_date
        .into_iter()
        .rev()
        .filter_map(|(date, playtime)| (playtime > 0).then_some(DailyStats { date, playtime }))
        .collect()
}

pub(super) fn calculate_statistics<Tz: TimeZone>(
    sessions: &[SessionFact],
    timezone: &Tz,
) -> Result<StatisticsProjection, DbErr> {
    let mut total_time = 0_i32;
    let mut session_count = 0_i32;
    let mut last_played = None;
    let mut daily_by_date = BTreeMap::<String, i32>::new();

    for session in sessions {
        let contribution = session_contribution(session, timezone)?;
        total_time = total_time
            .checked_add(session.duration)
            .ok_or_else(|| custom_error("总游玩时长溢出"))?;
        session_count = session_count
            .checked_add(1)
            .ok_or_else(|| custom_error("会话次数溢出"))?;
        last_played = Some(last_played.map_or(session.end_time, |previous: i32| {
            previous.max(session.end_time)
        }));

        for day in contribution.daily_stats {
            let total = daily_by_date.entry(day.date).or_default();
            *total = total
                .checked_add(day.playtime)
                .ok_or_else(|| custom_error("每日游玩时长溢出"))?;
        }
    }

    Ok(StatisticsProjection {
        total_time,
        session_count,
        last_played,
        daily_stats: daily_stats_from_map(daily_by_date),
    })
}

// These transitions remain testable as contracts; production writes rebuild from session facts.
#[cfg(test)]
pub(super) fn apply_session_insert<Tz: TimeZone>(
    projection: &mut StatisticsProjection,
    session: &SessionFact,
    timezone: &Tz,
) -> Result<(), DbErr> {
    let contribution = session_contribution(session, timezone)?;
    let mut next = projection.clone();
    next.total_time = next
        .total_time
        .checked_add(session.duration)
        .ok_or_else(|| custom_error("总游玩时长溢出"))?;
    next.session_count = next
        .session_count
        .checked_add(1)
        .ok_or_else(|| custom_error("会话次数溢出"))?;
    next.last_played = Some(
        next.last_played
            .map_or(session.end_time, |value| value.max(session.end_time)),
    );
    let mut by_date = daily_stats_map(&next.daily_stats)?;
    for day in contribution.daily_stats {
        let total = by_date.entry(day.date).or_default();
        *total = total
            .checked_add(day.playtime)
            .ok_or_else(|| custom_error("每日游玩时长溢出"))?;
    }
    next.daily_stats = daily_stats_from_map(by_date);
    *projection = next;
    Ok(())
}

#[cfg(test)]
pub(super) fn apply_session_delete<Tz: TimeZone>(
    projection: &mut StatisticsProjection,
    session: &SessionFact,
    remaining_last_played: Option<i32>,
    timezone: &Tz,
) -> Result<(), DbErr> {
    let contribution = session_contribution(session, timezone)?;
    let mut next = projection.clone();
    next.total_time = next
        .total_time
        .checked_sub(session.duration)
        .filter(|value| *value >= 0)
        .ok_or_else(|| custom_error("总游玩时长与会话记录不一致"))?;
    next.session_count = next
        .session_count
        .checked_sub(1)
        .filter(|value| *value >= 0)
        .ok_or_else(|| custom_error("会话次数与会话记录不一致"))?;
    let mut by_date = daily_stats_map(&next.daily_stats)?;
    for day in contribution.daily_stats {
        let total = by_date
            .get_mut(&day.date)
            .ok_or_else(|| custom_error(format!("每日统计缺少日期: {}", day.date)))?;
        *total = total
            .checked_sub(day.playtime)
            .filter(|value| *value >= 0)
            .ok_or_else(|| custom_error(format!("每日统计与会话记录不一致: {}", day.date)))?;
    }
    next.last_played = if next.session_count == 0 {
        None
    } else if next.last_played == Some(session.end_time) {
        Some(remaining_last_played.ok_or_else(|| custom_error("无法确定剩余会话的最近游玩时间"))?)
    } else {
        next.last_played
    };
    next.daily_stats = daily_stats_from_map(by_date);
    *projection = next;
    Ok(())
}

#[cfg(test)]
pub(super) fn parse_daily_stats(daily_stats_json: &str) -> Result<Vec<DailyStats>, String> {
    serde_json::from_str(daily_stats_json)
        .map_err(|error| format!("Failed to parse daily_stats: {error}"))
}
#[cfg(test)]
mod tests {
    use super::allocate_segment_minutes;

    fn cumulative_half_up(numerator: i128, denominator: i128) -> i32 {
        i32::try_from((numerator * 2 + denominator) / (denominator * 2))
            .expect("测试比例应可表示为 i32")
    }

    #[test]
    fn rolling_remainder_matches_cumulative_half_up_for_segment_partitions() {
        for total_seconds in 1_i128..=32 {
            for duration_minutes in 1_i32..=12 {
                for first_boundary in 0_i128..=total_seconds {
                    for second_boundary in first_boundary..=total_seconds {
                        let segments = [
                            first_boundary,
                            second_boundary - first_boundary,
                            total_seconds - second_boundary,
                        ];
                        let mut remainder = total_seconds / 2;
                        let mut elapsed_seconds = 0_i128;
                        let mut expected_allocated = 0_i32;

                        for segment_seconds in segments {
                            let actual = allocate_segment_minutes(
                                segment_seconds,
                                duration_minutes,
                                total_seconds,
                                &mut remainder,
                            )
                            .expect("合法日片段应能分配");
                            elapsed_seconds += segment_seconds;
                            let cumulative = cumulative_half_up(
                                elapsed_seconds * i128::from(duration_minutes),
                                total_seconds,
                            );
                            let expected = cumulative - expected_allocated;

                            assert_eq!(actual, expected);
                            expected_allocated = cumulative;
                        }

                        assert_eq!(expected_allocated, duration_minutes);
                    }
                }
            }
        }
    }

    #[test]
    fn rolling_remainder_accepts_verified_timestamp_and_duration_limits() {
        let total_seconds = i128::from(i32::MAX - 1);
        let duration_minutes = i32::MAX;
        let first_segment = total_seconds / 2;
        let second_segment = total_seconds - first_segment;
        let mut remainder = total_seconds / 2;

        let first_minutes = allocate_segment_minutes(
            first_segment,
            duration_minutes,
            total_seconds,
            &mut remainder,
        )
        .expect("i32 时间和分钟边界应可安全分配");
        let second_minutes = allocate_segment_minutes(
            second_segment,
            duration_minutes,
            total_seconds,
            &mut remainder,
        )
        .expect("剩余时间片应可安全分配");

        assert_eq!(
            i64::from(first_minutes) + i64::from(second_minutes),
            i64::from(duration_minutes)
        );
        assert_eq!(
            first_minutes,
            cumulative_half_up(first_segment * i128::from(duration_minutes), total_seconds)
        );
    }
}
