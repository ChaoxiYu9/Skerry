import type { GameTimeStats } from "@/types";

export type TimeRange = "7D" | "30D" | "MONTH" | "1Y" | "ALL";

export interface GameTimeChartData {
	date: string;
	playtime: number;
	[key: string]: string | number;
}

interface ChartBucketProjection {
	keys: string[];
	playtimeByKey: ReadonlyMap<string, number>;
}

const ALL_TIME_DAILY_POINT_LIMIT = 60;
const ALL_TIME_DAILY_SPAN_LIMIT_DAYS = 180;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const SEVEN_DAY_WINDOW_DAYS = 7;
const THIRTY_DAY_WINDOW_DAYS = 30;
const MONTHS_IN_YEAR = 12;

export function buildGameTimeChartData(
	dailyStats: GameTimeStats["daily_stats"],
	timeRange: TimeRange,
	selectedMonth: string,
	now = new Date(),
): GameTimeChartData[] {
	const playtimeByDate = new Map<string, number>();
	for (const item of dailyStats ?? []) {
		playtimeByDate.set(item.date, item.playtime);
	}

	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const projection = planChartBuckets(
		playtimeByDate,
		timeRange,
		selectedMonth,
		today,
	);
	return projection.keys.map((key) => ({
		date: key,
		playtime: projection.playtimeByKey.get(key) ?? 0,
	}));
}

function planChartBuckets(
	playtimeByDate: ReadonlyMap<string, number>,
	timeRange: TimeRange,
	selectedMonth: string,
	today: Date,
): ChartBucketProjection {
	switch (timeRange) {
		case "7D":
			return {
				keys: calendarDayKeysEndingAt(today, SEVEN_DAY_WINDOW_DAYS),
				playtimeByKey: playtimeByDate,
			};
		case "30D":
			return {
				keys: calendarDayKeysEndingAt(today, THIRTY_DAY_WINDOW_DAYS),
				playtimeByKey: playtimeByDate,
			};
		case "MONTH":
			return {
				keys: calendarDayKeysForMonth(selectedMonth),
				playtimeByKey: playtimeByDate,
			};
		case "1Y":
			return {
				keys: lastTwelveMonthKeys(today),
				playtimeByKey: aggregateDailyPlaytimeByMonth(playtimeByDate),
			};
		case "ALL": {
			const sortedDates = Array.from(playtimeByDate.keys()).sort();
			if (!shouldUseMonthlyAllTimeBuckets(sortedDates)) {
				return { keys: sortedDates, playtimeByKey: playtimeByDate };
			}

			const monthlyPlaytime = aggregateDailyPlaytimeByMonth(playtimeByDate);
			return {
				keys: Array.from(monthlyPlaytime.keys()).sort(),
				playtimeByKey: monthlyPlaytime,
			};
		}
	}
}

function calendarDayKeysEndingAt(today: Date, dayCount: number): string[] {
	const keys: string[] = [];
	for (let daysAgo = dayCount - 1; daysAgo >= 0; daysAgo--) {
		const date = new Date(today);
		date.setDate(today.getDate() - daysAgo);
		keys.push(formatLocalDateKey(date));
	}
	return keys;
}

function calendarDayKeysForMonth(selectedMonth: string): string[] {
	const [year, month] = selectedMonth.split("-").map(Number);
	const daysInMonth = new Date(year, month, 0).getDate();
	const keys: string[] = [];
	for (let day = 1; day <= daysInMonth; day++) {
		keys.push(
			`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
		);
	}
	return keys;
}

function lastTwelveMonthKeys(today: Date): string[] {
	const keys: string[] = [];
	for (let monthsAgo = MONTHS_IN_YEAR - 1; monthsAgo >= 0; monthsAgo--) {
		const month = new Date(
			today.getFullYear(),
			today.getMonth() - monthsAgo,
			1,
		);
		keys.push(
			`${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}`,
		);
	}
	return keys;
}

function formatLocalDateKey(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function shouldUseMonthlyAllTimeBuckets(
	sortedDates: readonly string[],
): boolean {
	if (sortedDates.length > ALL_TIME_DAILY_POINT_LIMIT) {
		return true;
	}
	if (sortedDates.length <= 1) {
		return false;
	}

	const firstDate = new Date(sortedDates[0]).getTime();
	const lastDate = new Date(sortedDates[sortedDates.length - 1]).getTime();
	const spanDays = Math.ceil((lastDate - firstDate) / MILLISECONDS_PER_DAY);
	return spanDays > ALL_TIME_DAILY_SPAN_LIMIT_DAYS;
}

function aggregateDailyPlaytimeByMonth(
	playtimeByDate: ReadonlyMap<string, number>,
): Map<string, number> {
	const monthlyMap = new Map<string, number>();
	for (const [date, playtime] of playtimeByDate) {
		const monthKey = date.substring(0, 7);
		monthlyMap.set(monthKey, (monthlyMap.get(monthKey) ?? 0) + playtime);
	}
	return monthlyMap;
}
