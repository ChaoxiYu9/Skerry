import type { GameStatistics } from "@/types";
import { getLocalDateString } from "../../utils/dateTime.ts";

export interface PlayTimeSummary {
	totalPlayTime: number;
	weekPlayTime: number;
	monthPlayTime: number;
	todayPlayTime: number;
	monthlyDailyPlayTime: Record<string, number>;
	dailyPlayTime: Record<string, number>;
}

export function buildPlayTimeSummary(
	statsList: Iterable<GameStatistics>,
	currentDate = new Date(),
): PlayTimeSummary {
	let totalPlayTime = 0;
	let weekPlayTime = 0;
	let monthPlayTime = 0;
	let todayPlayTime = 0;
	const monthlyDailyPlayTime: Record<string, number> = {};
	const dailyPlayTime: Record<string, number> = {};
	const today = getLocalDateString(Math.floor(currentDate.getTime() / 1000));

	const weekStart = new Date(currentDate);
	const dayOfWeek = currentDate.getDay();
	const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
	weekStart.setDate(currentDate.getDate() - daysFromMonday);
	weekStart.setHours(0, 0, 0, 0);
	const weekStartDateStr = getLocalDateString(
		Math.floor(weekStart.getTime() / 1000),
	);
	const monthStart = new Date(
		currentDate.getFullYear(),
		currentDate.getMonth(),
		1,
	);
	const monthStartDateStr = getLocalDateString(
		Math.floor(monthStart.getTime() / 1000),
	);
	const monthPrefix = monthStartDateStr.slice(0, 7);

	for (const stats of statsList) {
		if (typeof stats.total_time === "number") {
			totalPlayTime += stats.total_time;
		}

		if (!Array.isArray(stats.daily_stats)) {
			continue;
		}

		for (const record of stats.daily_stats) {
			const playTime = record.playtime || 0;

			if (record.date && record.date >= weekStartDateStr) {
				weekPlayTime += playTime;
			}

			if (record.date && record.date >= monthStartDateStr) {
				monthPlayTime += playTime;
			}

			if (record.date?.startsWith(monthPrefix)) {
				monthlyDailyPlayTime[record.date] =
					(monthlyDailyPlayTime[record.date] ?? 0) + playTime;
			}

			if (record.date) {
				dailyPlayTime[record.date] =
					(dailyPlayTime[record.date] ?? 0) + playTime;
			}

			if (record.date === today) {
				todayPlayTime += playTime;
			}
		}
	}

	return {
		totalPlayTime,
		weekPlayTime,
		monthPlayTime,
		todayPlayTime,
		monthlyDailyPlayTime,
		dailyPlayTime,
	};
}
