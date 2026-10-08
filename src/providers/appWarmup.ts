import { collectionKeys } from "@/hooks/queries/useCollections";
import { gameKeys } from "@/hooks/queries/useGames";
import { fetchAllSettings } from "@/hooks/queries/useSettings";
import { statsKeys } from "@/hooks/queries/useStats";
import { tasksQueryOptions } from "@/hooks/queries/useTasks";
import { ACTIVITY_PAGE_SIZE } from "@/pages/Home/homeData";
import { warmupGameDetailCaches } from "@/providers/gameDetailWarmup";
import i18n from "@/providers/i18n";
import { queryClient } from "@/providers/queryClient";
import {
	getAllGameLastPlayed,
	getAllGameStatistics,
	getFormattedGameStats,
} from "@/services/game/gameStats";
import {
	collectionService,
	type GameType,
	gameService,
	type SortOption,
	type SortOrder,
	statsService,
} from "@/services/invoke";
import { useStore } from "@/store/appStore";
import type {
	FullGameData,
	GameData,
	GameSession,
	GameStatistics,
} from "@/types";
import type { CollectionBackendSortField } from "@/types/collection";
import { DefaultGroup } from "@/types/collection";
import { getLocalDateString } from "@/utils/dateTime";
import {
	applyNsfwFilter,
	getGameBannerOrCover,
	getGameCover,
	getGameNsfwStatus,
} from "@/utils/game";
import { getGameIndex } from "@/utils/game/gameIndex";

const IMAGE_WARMUP_LIMIT = 48;
const IMAGE_WARMUP_BATCH_SIZE = 3;
const HOME_ACTIVITY_GAME_LIMIT = 160;
const LIBRARY_ID_LIST_WARMUP_LIMIT = 10;
const COLLECTION_GROUP_WARMUP_LIMIT = 5;
const COLLECTION_GAME_WARMUP_LIMIT = 4;
const DETAIL_GAME_WARMUP_LIMIT = 6;
const QUERY_WARMUP_CONCURRENCY = 3;

const COMMON_LIBRARY_SORTS: Array<{
	sortOption: SortOption;
	sortOrder: SortOrder;
}> = [
	{ sortOption: "addtime", sortOrder: "desc" },
	{ sortOption: "lastplayed", sortOrder: "desc" },
	{ sortOption: "datetime", sortOrder: "desc" },
	{ sortOption: "namesort", sortOrder: "asc" },
];

const COMMON_LIBRARY_FILTERS: GameType[] = [
	"all",
	"local",
	"online",
	"iscustom",
];

let warmupStarted = false;
const scheduleIdle = (
	callback: () => void,
	timeout = 900,
	onSkipped?: () => void,
) => {
	if (typeof window === "undefined") {
		onSkipped?.();
		return;
	}
	let timer: number | null = null;
	const runWhenForeground = () => {
		if (document.visibilityState === "hidden") {
			// Cache warmup is opportunistic. Do not resume it on window refocus,
			// otherwise a stale warmup batch can compete with the first interaction.
			onSkipped?.();
			return;
		}

		const run = () => window.setTimeout(callback, 120);
		const requestIdle = window.requestIdleCallback;
		if (requestIdle) {
			requestIdle(run, { timeout });
			return;
		}
		run();
	};

	timer = window.setTimeout(runWhenForeground, Math.min(timeout, 450));
	return () => {
		if (timer !== null) window.clearTimeout(timer);
	};
};

const waitForIdle = (timeout = 900) =>
	new Promise<boolean>((resolve) =>
		scheduleIdle(
			() => resolve(true),
			timeout,
			() => resolve(false),
		),
	);

async function settleWarmupTasks(
	tasks: Array<() => Promise<unknown>>,
	concurrency = QUERY_WARMUP_CONCURRENCY,
): Promise<void> {
	let nextTaskIndex = 0;
	const workerCount = Math.min(Math.max(1, concurrency), tasks.length);
	const workers = Array.from({ length: workerCount }, async () => {
		while (
			nextTaskIndex < tasks.length &&
			(typeof document === "undefined" || document.visibilityState !== "hidden")
		) {
			const task = tasks[nextTaskIndex];
			nextTaskIndex += 1;
			try {
				await task();
			} catch {
				// Warmup failures are intentionally best-effort.
			}
		}
	});
	await Promise.all(workers);
}

async function runWarmupTask<T>(
	label: string,
	task: () => Promise<T>,
): Promise<T | undefined> {
	try {
		return await task();
	} catch (error) {
		console.debug("Skerry cache warmup skipped:", label, error);
		return undefined;
	}
}

async function warmupGameQueries(): Promise<FullGameData[]> {
	const state = useStore.getState();
	const language = i18n.language || "zh-CN";
	const games = await queryClient.ensureQueryData({
		queryKey: gameKeys.all,
		queryFn: () => gameService.getAllGames("all"),
	});
	const index = getGameIndex(games);
	queryClient.setQueryData(gameKeys.index(), index);
	const libraryIdListCandidates = getLibraryIdListWarmupCandidates({
		gameType: state.gameFilterType,
		sortOption: state.sortOption,
		sortOrder: state.sortOrder,
	});

	await settleWarmupTasks([
		...libraryIdListCandidates.map(
			(params) => () =>
				queryClient.prefetchQuery({
					queryKey: gameKeys.idList({ ...params, language }),
					queryFn: () =>
						gameService.getGameIds(
							params.gameType,
							params.sortOption,
							params.sortOrder,
							language,
						),
				}),
		),
		() =>
			queryClient.prefetchQuery({
				queryKey: gameKeys.bgmIds(),
				queryFn: () => gameService.getAllBgmIds(),
			}),
		() =>
			queryClient.prefetchQuery({
				queryKey: gameKeys.vndbIds(),
				queryFn: () => gameService.getAllVndbIds(),
			}),
	]);

	return games;
}

function getLibraryIdListWarmupCandidates(current: {
	gameType: GameType;
	sortOption: SortOption;
	sortOrder: SortOrder;
}) {
	const candidates = [
		current,
		...COMMON_LIBRARY_SORTS.map((sort) => ({
			gameType: current.gameType,
			...sort,
		})),
		...COMMON_LIBRARY_FILTERS.map((gameType) => ({
			gameType,
			sortOption: current.sortOption,
			sortOrder: current.sortOrder,
		})),
		...COMMON_LIBRARY_SORTS.map((sort) => ({
			gameType: "all" as const,
			...sort,
		})),
	];
	const seen = new Set<string>();
	return candidates.filter((candidate) => {
		const key = [
			candidate.gameType,
			candidate.sortOption,
			candidate.sortOrder,
		].join(":");
		if (seen.has(key) || seen.size >= LIBRARY_ID_LIST_WARMUP_LIMIT) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

async function warmupCollectionQueries() {
	const state = useStore.getState();
	const backendEntitySortField: CollectionBackendSortField | undefined =
		state.collectionEntitySortField === "name"
			? undefined
			: state.collectionEntitySortField;
	const backendEntitySortOrder = backendEntitySortField
		? state.collectionEntitySortOrder
		: undefined;

	const groupListQuery = queryClient.ensureQueryData({
		queryKey: collectionKeys.groupList(
			backendEntitySortField,
			backendEntitySortOrder,
		),
		queryFn: () =>
			collectionService.getGroupsWithCount(
				backendEntitySortField,
				backendEntitySortOrder,
			),
	});
	const requests: Promise<unknown>[] = [
		queryClient.prefetchQuery({
			queryKey: collectionKeys.groups(),
			queryFn: () => collectionService.getGroups(),
		}),
		groupListQuery,
	];
	const groups = await groupListQuery.catch(() => []);
	for (const group of groups.slice(0, COLLECTION_GROUP_WARMUP_LIMIT)) {
		requests.push(
			warmupCollectionCategoryQueries(
				group.id,
				backendEntitySortField,
				backendEntitySortOrder,
			),
		);
	}

	if (state.currentGroupId && state.currentGroupId !== DefaultGroup.DEVELOPER) {
		const groupId = Number.parseInt(state.currentGroupId, 10);
		if (!Number.isNaN(groupId)) {
			requests.push(
				queryClient.prefetchQuery({
					queryKey: collectionKeys.categoryList(
						state.currentGroupId,
						backendEntitySortField,
						backendEntitySortOrder,
					),
					queryFn: () =>
						collectionService.getCategoriesWithCount(
							groupId,
							backendEntitySortField,
							backendEntitySortOrder,
						),
				}),
			);
		}
	}

	if (state.selectedCategory?.type === "real") {
		const categoryId = state.selectedCategory.id;
		requests.push(
			queryClient.prefetchQuery({
				queryKey: collectionKeys.games(categoryId),
				queryFn: () => collectionService.getGamesInCollection(categoryId),
			}),
		);
	}

	await Promise.allSettled(requests);
}

async function warmupCollectionCategoryQueries(
	groupId: number,
	sortField?: CollectionBackendSortField,
	sortOrder?: SortOrder,
) {
	const groupKey = groupId.toString();
	const categories = await queryClient.ensureQueryData({
		queryKey: collectionKeys.categoryList(groupKey, sortField, sortOrder),
		queryFn: () =>
			collectionService.getCategoriesWithCount(groupId, sortField, sortOrder),
	});
	await Promise.allSettled(
		categories.slice(0, COLLECTION_GAME_WARMUP_LIMIT).map((category) =>
			queryClient.prefetchQuery({
				queryKey: collectionKeys.games(category.id),
				queryFn: () => collectionService.getGamesInCollection(category.id),
			}),
		),
	);
}

function getVisibleWarmupGames(games: FullGameData[]): GameData[] {
	const state = useStore.getState();
	const index = getGameIndex(games);
	const visibleGames = applyNsfwFilter(index.displayList, state.nsfwFilter);
	const language = i18n.language || "zh-CN";
	const sortedIds = queryClient.getQueryData<number[]>(
		gameKeys.idList({
			gameType: state.gameFilterType,
			sortOption: state.sortOption,
			sortOrder: state.sortOrder,
			language,
		}),
	);
	if (!sortedIds?.length) return visibleGames;
	const byId = index.displayById;
	return sortedIds.flatMap((id) => {
		const game = byId.get(id);
		return game && (!state.nsfwFilter || !getGameNsfwStatus(game))
			? [game]
			: [];
	});
}

function buildPlayTimeSummaryFromStats(statsList: Iterable<GameStatistics>) {
	let totalPlayTime = 0;
	let weekPlayTime = 0;
	let monthPlayTime = 0;
	let todayPlayTime = 0;
	const monthlyDailyPlayTime: Record<string, number> = {};
	const dailyPlayTime: Record<string, number> = {};
	const today = getLocalDateString();
	const now = new Date();

	const weekStart = new Date(now);
	const dayOfWeek = now.getDay();
	const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
	weekStart.setDate(now.getDate() - daysFromMonday);
	weekStart.setHours(0, 0, 0, 0);
	const weekStartDateStr = getLocalDateString(
		Math.floor(weekStart.getTime() / 1000),
	);
	const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
	const monthStartDateStr = getLocalDateString(
		Math.floor(monthStart.getTime() / 1000),
	);
	const monthPrefix = monthStartDateStr.slice(0, 7);

	for (const stats of statsList) {
		if (typeof stats.total_time === "number") {
			totalPlayTime += stats.total_time;
		}
		for (const record of stats.daily_stats ?? []) {
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

async function warmupStatsQueries(games: FullGameData[]) {
	const visibleGames = getVisibleWarmupGames(games);
	const activityGameIds = visibleGames
		.slice(0, HOME_ACTIVITY_GAME_LIMIT)
		.map((game) => game.id);
	const firstGameId = activityGameIds[0];
	const statsMap = await getAllGameStatistics();
	const statsList = [...statsMap.values()];
	queryClient.setQueryData([...statsKeys.all, "annualReport"], statsList);
	queryClient.setQueryData(
		statsKeys.playTimeSummary(),
		buildPlayTimeSummaryFromStats(statsList),
	);
	const requests: Promise<unknown>[] = [
		queryClient.prefetchQuery({
			queryKey: statsKeys.allGameLastPlayed(),
			queryFn: getAllGameLastPlayed,
		}),
	];

	if (firstGameId) {
		requests.push(
			queryClient.prefetchQuery({
				queryKey: statsKeys.gameStats(firstGameId),
				queryFn: () => getFormattedGameStats(firstGameId),
			}),
		);
	}

	if (activityGameIds.length > 0) {
		requests.push(
			queryClient.prefetchInfiniteQuery({
				queryKey: [...statsKeys.all, "atlasTrace", activityGameIds],
				queryFn: ({ pageParam }) =>
					statsService.getRecentSessionsForAll(
						activityGameIds,
						ACTIVITY_PAGE_SIZE,
						Number(pageParam),
					),
				initialPageParam: 0,
				getNextPageParam: (last: GameSession[], pages: GameSession[][]) =>
					last.length < ACTIVITY_PAGE_SIZE
						? undefined
						: pages.length * ACTIVITY_PAGE_SIZE,
			}),
		);
	}

	await Promise.allSettled(requests);
}

async function preloadImage(src: string): Promise<void> {
	if (!src || typeof Image === "undefined") return;
	await new Promise<void>((resolve) => {
		const image = new Image();
		image.decoding = "async";
		image.onload = () => {
			if (image.decode) {
				image
					.decode()
					.catch(() => undefined)
					.then(resolve);
				return;
			}
			resolve();
		};
		image.onerror = () => resolve();
		image.src = src;
		if (image.complete) resolve();
	});
}

async function warmupImages(games: FullGameData[]) {
	const state = useStore.getState();
	const warmupGames = getVisibleWarmupGames(games).slice(0, IMAGE_WARMUP_LIMIT);
	const urls = new Set<string>();
	for (const game of warmupGames) {
		if (state.nsfwCoverReplace && getGameNsfwStatus(game)) {
			urls.add("/images/NR18.png");
		} else {
			urls.add(getGameCover(game));
			urls.add(getGameBannerOrCover(game));
		}
	}

	const imageUrls = [...urls].slice(0, IMAGE_WARMUP_LIMIT);
	for (
		let index = 0;
		index < imageUrls.length;
		index += IMAGE_WARMUP_BATCH_SIZE
	) {
		await Promise.allSettled(
			imageUrls
				.slice(index, index + IMAGE_WARMUP_BATCH_SIZE)
				.map((src) => preloadImage(src)),
		);
		if (!(await waitForIdle(700))) return;
	}
}

async function warmupVisibleDetailQueries(games: FullGameData[]) {
	const warmupGames = getVisibleWarmupGames(games).slice(
		0,
		DETAIL_GAME_WARMUP_LIMIT,
	);
	for (const game of warmupGames) {
		warmupGameDetailCaches(game);
		if (!(await waitForIdle(520))) return;
	}
}

async function runAppWarmup() {
	const alwaysWarmup = Promise.allSettled([
		runWarmupTask("settings query", () => fetchAllSettings(queryClient)),
		runWarmupTask("download task query", () =>
			queryClient.prefetchQuery(tasksQueryOptions()),
		),
	]);
	const games = await runWarmupTask("game queries", warmupGameQueries);

	if (games?.length) {
		scheduleIdle(() => {
			void runWarmupTask("image decode", () => warmupImages(games));
		}, 1200);
		scheduleIdle(() => {
			void runWarmupTask("visible detail queries", () =>
				warmupVisibleDetailQueries(games),
			);
		}, 900);
		await Promise.allSettled([
			runWarmupTask("collection queries", warmupCollectionQueries),
			runWarmupTask("stats queries", () => warmupStatsQueries(games)),
		]);
	}

	await alwaysWarmup;
}

export function warmupAppCaches() {
	if (warmupStarted) return;
	warmupStarted = true;
	scheduleIdle(() => {
		void runAppWarmup();
	}, 320);
}
