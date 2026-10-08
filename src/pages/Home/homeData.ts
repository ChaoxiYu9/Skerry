import type { GameData, GameSession } from "@/types";
import { PlayStatus } from "@/types/collection";
import { getLocalDateString } from "@/utils/dateTime";
import {
	getGameBannerOrCover,
	getGameCover,
	getGameDisplayName,
	getGameNsfwStatus,
} from "@/utils/game";

export const RANDOM_GAME_SESSION_KEY = "skerry-home-random-game-v2";
export const HOME_LAST_FOCUS_GAME_KEY = "skerry-home-last-focus-game-id";
export const HOME_LAST_FOCUS_GAME_SNAPSHOT_KEY = "skerry-home-last-focus-game-snapshot";

export function saveHomeFocusGameSnapshot(game: GameData | null | undefined): void {
	if (typeof window === "undefined" || !game || !game.id) return;
	try {
		const snapshot: Partial<GameData> = {
			id: game.id,
			name: game.name,
			name_cn: game.name_cn,
			image: game.image,
			custom_data: game.custom_data,
			clear: game.clear,
			localpath: game.localpath,
			tags: game.tags,
			date: game.date,
			created_at: game.created_at,
		};
		window.localStorage.setItem(
			HOME_LAST_FOCUS_GAME_SNAPSHOT_KEY,
			JSON.stringify(snapshot),
		);
	} catch (e) {
		console.debug("Failed to cache home focus game snapshot", e);
	}
}

export function loadHomeFocusGameSnapshot(): GameData | null {
	if (typeof window === "undefined") return null;
	try {
		const raw = window.localStorage.getItem(HOME_LAST_FOCUS_GAME_SNAPSHOT_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && typeof parsed.id === "number") {
			return parsed as GameData;
		}
	} catch (e) {
		console.debug("Failed to load home focus game snapshot", e);
	}
	return null;
}
export const ACTIVITY_PAGE_SIZE = 12;
export const EMPTY_LAST_PLAYED = new Map<number, number>();

const NSFW_COVER = "/images/NR18.png";

export type ActivityFilter = "all" | "play" | "add";

export interface ActivityItem {
	id: string;
	type: Exclude<ActivityFilter, "all">;
	gameId: number;
	gameTitle: string;
	imageUrl: string;
	time: number;
	date: string;
	duration?: number;
	count?: number;
}

export interface ActivityGroup {
	date: string;
	items: ActivityItem[];
}

export interface MonthlyPlayGridItem {
	date: string;
	day: number;
	minutes: number;
	level:
		| "empty"
		| "level-1"
		| "level-2"
		| "level-3"
		| "level-4"
		| "level-5"
		| "level-6";
}

export function getVisibleCover(
	game: GameData,
	replaceNsfwCover: boolean,
): string {
	return replaceNsfwCover && getGameNsfwStatus(game)
		? NSFW_COVER
		: getGameBannerOrCover(game);
}

export function getVisibleGameCover(
	game: GameData,
	replaceNsfwCover: boolean,
): string {
	return replaceNsfwCover && getGameNsfwStatus(game)
		? NSFW_COVER
		: getGameCover(game);
}

export function buildActivities(
	games: GameData[],
	sessions: GameSession[],
	replaceNsfwCover: boolean,
): ActivityItem[] {
	const gameById = new Map(games.map((game) => [game.id, game]));
	const activities: ActivityItem[] = [];

	for (const session of sessions) {
		if (typeof session.end_time !== "number") continue;
		const game = gameById.get(session.game_id);
		if (!game) continue;

		const date = getLocalDateString(session.end_time);
		activities.push({
			id: `play-${session.session_id}`,
			type: "play",
			gameId: game.id,
			gameTitle: getGameDisplayName(game),
			imageUrl: getVisibleGameCover(game, replaceNsfwCover),
			time: session.end_time,
			date,
			duration: session.duration ?? 0,
		});
	}

	for (const game of games) {
		if (!game.created_at) continue;
		activities.push({
			id: `add-${game.id}`,
			type: "add",
			gameId: game.id,
			gameTitle: getGameDisplayName(game),
			imageUrl: getVisibleGameCover(game, replaceNsfwCover),
			time: game.created_at,
			date: getLocalDateString(game.created_at),
		});
	}

	return activities.toSorted((a, b) => b.time - a.time);
}

export function getFocusGame(
	games: GameData[],
	lastPlayedMap: ReadonlyMap<number, number>,
	runningGameIds: Set<number>,
	preferredGameId?: number | null,
	fallbackGame?: GameData | null,
): GameData | null {
	if (games.length === 0) return fallbackGame ?? null;
	const gamesByLastPlayed = games.toSorted(
		(a, b) => (lastPlayedMap.get(b.id) ?? 0) - (lastPlayedMap.get(a.id) ?? 0),
	);
	const runningGame = gamesByLastPlayed.find((game) =>
		runningGameIds.has(game.id),
	);
	if (runningGame) return runningGame;
	const latestPlayedGame = gamesByLastPlayed.find((game) =>
		lastPlayedMap.has(game.id),
	);
	if (latestPlayedGame) return latestPlayedGame;

	if (preferredGameId !== undefined && preferredGameId !== null) {
		const preferred = games.find((game) => game.id === preferredGameId);
		if (preferred) return preferred;
	}

	return (
		games.find((game) => game.clear === PlayStatus.PLAYING) ??
		games.find((game) => Boolean(game.localpath)) ??
		games[0] ??
		fallbackGame ??
		null
	);
}

export function getRecentGames(
	games: GameData[],
	lastPlayedMap: ReadonlyMap<number, number>,
	runningGameIds: ReadonlySet<number> = new Set(),
): GameData[] {
	return games
		.filter(
			(game) =>
				lastPlayedMap.has(game.id) ||
				runningGameIds.has(game.id) ||
				game.clear === PlayStatus.PLAYING,
		)
		.toSorted((a, b) => {
			const aIsActive =
				runningGameIds.has(a.id) || a.clear === PlayStatus.PLAYING;
			const bIsActive =
				runningGameIds.has(b.id) || b.clear === PlayStatus.PLAYING;
			if (aIsActive !== bIsActive) return bIsActive ? 1 : -1;
			return (lastPlayedMap.get(b.id) ?? 0) - (lastPlayedMap.get(a.id) ?? 0);
		})
		.slice(0, 8);
}

export function pickRandomGame(
	games: GameData[],
	excludedId?: number,
): GameData | null {
	if (games.length === 0) return null;

	const activeGames = games.filter(
		(game) =>
			game.clear === PlayStatus.PLAYING || game.clear === PlayStatus.WISH,
	);
	const allPlayed =
		games.length > 0 &&
		games.every((game) => game.clear === PlayStatus.PLAYED);

	// 若全部通关，或在玩/想玩的游戏不足6部（0至5部），则从全部游戏中随机抽取；
	// 否则仅在在玩与想玩的游戏池中随机抽取
	const candidatePool =
		allPlayed || activeGames.length <= 5 ? games : activeGames;

	const pool =
		candidatePool.length > 1 && excludedId !== undefined
			? candidatePool.filter((game) => game.id !== excludedId)
			: candidatePool;

	if (pool.length === 0) return null;
	return pool[Math.floor(Math.random() * pool.length)] ?? null;
}

export function getWeekPlayTime(
	dailyStats: Array<{ date: string; playtime: number }> | undefined,
): number {
	if (!dailyStats) return 0;
	const now = new Date();
	const weekStart = new Date(now);
	const daysFromMonday = now.getDay() === 0 ? 6 : now.getDay() - 1;
	weekStart.setDate(now.getDate() - daysFromMonday);
	weekStart.setHours(0, 0, 0, 0);
	const startDate = getLocalDateString(Math.floor(weekStart.getTime() / 1000));
	return dailyStats.reduce(
		(total, item) => total + (item.date >= startDate ? item.playtime : 0),
		0,
	);
}

export function buildMonthlyPlayGrid(
	dailyPlayTime: Record<string, number>,
	now = new Date(),
): MonthlyPlayGridItem[] {
	const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

	const daysInMonth = new Date(
		now.getFullYear(),
		now.getMonth() + 1,
		0,
	).getDate();

	return Array.from({ length: 31 }, (_, index) => {
		const day = index + 1;
		if (day > daysInMonth) {
			return {
				date: "",
				day,
				minutes: 0,
				level: "empty",
			} as MonthlyPlayGridItem;
		}

		const date = `${monthPrefix}-${String(day).padStart(2, "0")}`;
		const minutes = dailyPlayTime[date] ?? 0;
		const level: MonthlyPlayGridItem["level"] =
			minutes <= 0
				? "empty"
				: minutes < 30
					? "level-1"
					: minutes < 120
						? "level-2"
						: minutes < 300
							? "level-3"
							: minutes < 480
								? "level-4"
								: minutes < 600
									? "level-5"
									: "level-6";

		return { date, day, minutes, level };
	});
}
