import type { GameData, GameStatistics } from "@/types";
import { PlayStatus } from "@/types/collection";

export interface AnnualReportSummary {
	year: number;
	totalMinutes: number;
	gamesPlayed: number;
	completedGames: number;
	newGames: number;
	totalLibraryGames: number;
	clearRateNumerator: number;
	clearRateDenominator: number;
	clearRatePercent: number;
	activeDays: number;
	longestStreak: number;
	averageActiveDayMinutes: number;
	monthlyMinutes: number[];
	weekdayMinutes: number[];
	topGames: Array<{ game: GameData; minutes: number }>;
	peakDay: { date: string; minutes: number } | null;
}

function toUtcDay(date: string): number | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
	if (!match) return null;
	return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function getLongestStreak(dates: Iterable<string>): number {
	const days = [...dates]
		.map(toUtcDay)
		.filter((day): day is number => day !== null)
		.sort((left, right) => left - right);
	let longest = 0;
	let current = 0;
	let previous: number | null = null;

	for (const day of days) {
		if (day === previous) continue;
		current =
			previous !== null && day - previous === 86_400_000 ? current + 1 : 1;
		longest = Math.max(longest, current);
		previous = day;
	}

	return longest;
}

export function getReportYears(stats: readonly GameStatistics[]): number[] {
	const years = new Set<number>([new Date().getFullYear()]);
	for (const gameStats of stats) {
		for (const record of gameStats.daily_stats ?? []) {
			if (!record || typeof record.date !== "string") continue;
			const year = Number(record.date.slice(0, 4));
			if (Number.isInteger(year) && year >= 2000 && year <= 9999)
				years.add(year);
		}
	}
	return [...years].sort((left, right) => right - left);
}

function getGameAddedYear(game: GameData): number | null {
	if (
		typeof game.created_at !== "number" ||
		!Number.isFinite(game.created_at) ||
		game.created_at <= 0
	) {
		return null;
	}
	const ms =
		game.created_at > 100_000_000_000
			? game.created_at
			: game.created_at * 1000;
	const yr = new Date(ms).getFullYear();
	return Number.isInteger(yr) && yr >= 2000 && yr <= 9999 ? yr : null;
}

export function buildAnnualReport(
	year: number,
	stats: readonly GameStatistics[],
	gamesById: ReadonlyMap<number, GameData>,
): AnnualReportSummary {
	const isAllTime = year === 0;
	const monthlyMinutes = Array.from({ length: 12 }, () => 0);
	const weekdayMinutes = Array.from({ length: 7 }, () => 0);
	const activeDates = new Set<string>();
	const gameMinutes = new Map<number, number>();
	const dayMinutes = new Map<string, number>();
	let totalMinutes = 0;

	// 全历史游玩过的游戏ID集合，以及每款游戏首次产生游玩记录的年份
	const allPlayedGameIds = new Set<number>();
	const firstPlayedYearByGame = new Map<number, number>();

	for (const gameStats of stats) {
		let minutesForGame = 0;
		for (const record of gameStats.daily_stats ?? []) {
			if (
				!record ||
				typeof record.date !== "string" ||
				typeof record.playtime !== "number" ||
				!Number.isFinite(record.playtime) ||
				record.playtime <= 0
			)
				continue;

			allPlayedGameIds.add(gameStats.game_id);
			const recYear = Number(record.date.slice(0, 4));
			if (Number.isInteger(recYear) && recYear >= 2000 && recYear <= 9999) {
				const prevFirst = firstPlayedYearByGame.get(gameStats.game_id);
				if (prevFirst === undefined || recYear < prevFirst) {
					firstPlayedYearByGame.set(gameStats.game_id, recYear);
				}
			}

			if (!isAllTime && !record.date.startsWith(`${String(year)}-`)) continue;

			const day = toUtcDay(record.date);
			if (day === null) continue;
			const date = new Date(day);
			const minutes = Math.max(0, record.playtime);
			monthlyMinutes[date.getUTCMonth()] += minutes;
			weekdayMinutes[date.getUTCDay()] += minutes;
			activeDates.add(record.date);
			dayMinutes.set(record.date, (dayMinutes.get(record.date) ?? 0) + minutes);
			minutesForGame += minutes;
			totalMinutes += minutes;
		}
		if (minutesForGame > 0) gameMinutes.set(gameStats.game_id, minutesForGame);
	}

	const topGames = [...gameMinutes.entries()]
		.map(([gameId, minutes]) => ({ game: gamesById.get(gameId), minutes }))
		.filter((item): item is { game: GameData; minutes: number } =>
			Boolean(item.game),
		)
		.sort((left, right) => right.minutes - left.minutes)
		.slice(0, 20);

	const allLibraryGames = [...gamesById.values()];
	const totalLibraryGames = gamesById.size;
	const allCompletedCount = allLibraryGames.filter(
		(game) => game.clear === PlayStatus.PLAYED,
	).length;

	// 1. 新增游戏 (newGames):
	// 全部年份：全库游戏总数
	// 年度：基于游戏入库时间（created_at 添加时间）判定所属年份，若无添加时间则回退到该游戏最早游玩记录所在年份
	const newGames = isAllTime
		? totalLibraryGames
		: allLibraryGames.filter((game) => {
			const addedYear = getGameAddedYear(game) ?? firstPlayedYearByGame.get(game.id) ?? null;
			return addedYear === year;
		}).length;

	// 2. 玩过的游戏 (gamesPlayed): 打开过的游戏数
	// 全部年份：历史上打开过的游戏数
	// 年度：当年打开过的游戏数
	const gamesPlayed = isAllTime
		? [...allPlayedGameIds].filter((id) => gamesById.has(id)).length
		: gameMinutes.size;

	// 3. 通关游戏 (completedGames):
	// 全部年份：全库标记通关总数
	// 年度：
	// - 若游戏配置了 clear_records，检查该年是否存在通关记录（无论是初通还是追加二、三周目通关）；
	// - 若未配置 clear_records（旧数据平滑兼容），若当前状态为通关且该年有游玩时长，计入当年通关。
	let completedGames = 0;
	if (isAllTime) {
		completedGames = allCompletedCount;
	} else {
		for (const game of allLibraryGames) {
			const clearRecords = game.custom_data?.clear_records;
			if (Array.isArray(clearRecords) && clearRecords.length > 0) {
				const recordsThisYear = clearRecords.filter((rec) =>
					rec && typeof rec.date === "string" && rec.date.startsWith(`${String(year)}-`),
				);
				completedGames += recordsThisYear.length;
			} else {
				if (game.clear === PlayStatus.PLAYED && gameMinutes.has(game.id)) {
					completedGames += 1;
				}
			}
		}
	}

	// 4. 游戏通关率:
	// 全部年份：标注通关 / 游戏库全部数
	// 年度：年度标注通关 / 年度增加的游戏数
	const clearRateNumerator = completedGames;
	const clearRateDenominator = isAllTime ? totalLibraryGames : newGames;
	const clearRatePercent =
		clearRateDenominator > 0
			? Math.round((clearRateNumerator / clearRateDenominator) * 100)
			: 0;

	return {
		year,
		totalMinutes,
		gamesPlayed,
		completedGames,
		newGames,
		totalLibraryGames,
		clearRateNumerator,
		clearRateDenominator,
		clearRatePercent,
		activeDays: activeDates.size,
		longestStreak: getLongestStreak(activeDates),
		averageActiveDayMinutes:
			activeDates.size === 0 ? 0 : Math.round(totalMinutes / activeDates.size),
		monthlyMinutes,
		weekdayMinutes,
		topGames,
		peakDay: [...dayMinutes.entries()]
			.sort((left, right) => right[1] - left[1])
			.map(([date, minutes]) => ({ date, minutes }))
			.at(0) ?? null,
	};
}
