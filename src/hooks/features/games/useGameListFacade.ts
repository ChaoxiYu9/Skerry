import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { gameKeys, useAllGames, useGameIdList } from "@/hooks/queries/useGames";
import { type CollectionGameFilterSortConfig, useStore } from "@/store/appStore";
import type { GameData } from "@/types";
import { ALL_PLAY_STATUSES, PlayStatus } from "@/types/collection";
import { getGameNsfwStatus } from "@/utils/game";
import {
	createSearchIndex,
	searchWithIndex,
} from "@/utils/game/enhancedSearch";
import { EMPTY_GAME_INDEX, type GameIndex, getGameIndex } from "@/utils/game/gameIndex";
import {
	buildNormalizedTagSet,
	matchesAllNormalizedTagFilters,
} from "@/utils/game/tagFilter";

const EMPTY_IDS: number[] = [];
const EMPTY_GAMES: GameData[] = [];

export interface GameListScopeOptions {
	scopeGameIds?: readonly number[];
	applyNsfwFilter?: boolean;
	includeGames?: boolean;
	preferencesScope?: "library" | "collection";
}

function gameMatchesTagFilters(
	game: GameData,
	normalizedTagFilters: ReadonlySet<string>,
): boolean {
	if (normalizedTagFilters.size === 0) {
		return true;
	}

	const gameTags = game.tags;
	if (!gameTags || gameTags.length === 0) {
		return false;
	}

	return matchesAllNormalizedTagFilters(gameTags, normalizedTagFilters);
}


export function useGameListPreferences(preferencesScope?: "library" | "collection") {
	return useStore(
		useShallow((state) =>
			preferencesScope === "collection"
				? state.collectionGameFilterSort
				: {
						gameFilterType: state.gameFilterType,
						playStatusFilter: state.playStatusFilter,
						tagFilters: state.tagFilters,
						sortOption: state.sortOption,
						sortOrder: state.sortOrder,
						showCardSortFieldOverlay: state.showCardSortFieldOverlay,
					},
		),
	);
}

export function getActiveGameFilterCount({
	gameFilterType,
	playStatusFilter,
	tagFilters,
}: Pick<
	CollectionGameFilterSortConfig,
	"gameFilterType" | "playStatusFilter" | "tagFilters"
>): number {
	return (
		Number(gameFilterType !== "all") +
		Number(
			Array.isArray(playStatusFilter)
				? playStatusFilter.length > 0 &&
						playStatusFilter.length < ALL_PLAY_STATUSES.length
				: playStatusFilter !== "all",
		) +
		Number(tagFilters.length > 0)
	);
}

export function useGameIndex() {
	const queryClient = useQueryClient();
	const allGamesQuery = useAllGames();
	const indexRef = useRef<GameIndex>(EMPTY_GAME_INDEX);
	const index = useMemo(() => {
		const cachedIndex = queryClient.getQueryData<GameIndex>(gameKeys.index());
		if (cachedIndex && cachedIndex.rawList === allGamesQuery.data) {
			indexRef.current = cachedIndex;
			return cachedIndex;
		}
		if (indexRef.current?.rawList === allGamesQuery.data) {
			return indexRef.current;
		}
		const nextIndex = getGameIndex(allGamesQuery.data);
		indexRef.current = nextIndex;
		return nextIndex;
	}, [allGamesQuery.data, queryClient]);
	useEffect(() => {
		if (
			index.rawList === allGamesQuery.data &&
			queryClient.getQueryData<GameIndex>(gameKeys.index()) !== index
		) {
			queryClient.setQueryData(gameKeys.index(), index);
		}
	}, [allGamesQuery.data, index, queryClient]);

	return {
		index,
		isLoading: allGamesQuery.isLoading,
		isError: allGamesQuery.isError,
		error: allGamesQuery.error,
	};
}

/**
 * 基础游戏筛选门面 Hook
 *
 * 数据流：
 * 1. useAllGames → FullGameData[] → GameIndex（一次性派生）
 * 2. useGameIdList → number[]（排序/筛选后的 ID，IPC 仅传输几 KB）
 * 3. 从 GameIndex.displayById 读取 GameData → 前端过滤（作用域/游玩状态/NSFW）
 *
 * 不处理搜索关键词，供 SearchBox 复用基础筛选结果生成建议，
 * 避免搜索框为建议列表重复执行完整搜索。
 */
export function useFilteredGamesFacade({
	scopeGameIds,
	applyNsfwFilter = true,
	includeGames = true,
}: GameListScopeOptions = {}) {
	const {
		gameFilterType,
		playStatusFilter,
		tagFilters,
		sortOption,
		sortOrder,
		nsfwFilter,
	} = useStore(
		useShallow((s) => ({
			gameFilterType: s.gameFilterType,
			playStatusFilter: s.playStatusFilter,
			tagFilters: s.tagFilters,
			sortOption: s.sortOption,
			sortOrder: s.sortOrder,
			nsfwFilter: s.nsfwFilter,
		})),
	);

	const gameIndexQuery = useGameIndex();
	const { index } = gameIndexQuery;

	// 2. 排序/筛选后的 ID 列表（轻量 IPC，切换排序时仅传输几 KB）
	const gameIdListQuery = useGameIdList(gameFilterType, sortOption, sortOrder);
	const sortedIds = gameIdListQuery.data ?? EMPTY_IDS;
	const scopedGameIdSet = useMemo(
		() => (scopeGameIds ? new Set(scopeGameIds) : null),
		[scopeGameIds],
	);

	const baseFilteredResult = useMemo(() => {
		if (sortedIds.length === 0 || index.displayById.size === 0) {
			return { ids: EMPTY_IDS, games: EMPTY_GAMES };
		}

		const ids: number[] = [];
		const games: GameData[] = [];
		for (const id of sortedIds) {
			if (scopedGameIdSet && !scopedGameIdSet.has(id)) continue;

			const game = index.displayById.get(id);
			if (!game) continue;

			const status = game.clear ?? PlayStatus.WISH;
			if (Array.isArray(playStatusFilter)) {
				if (
					playStatusFilter.length > 0 &&
					playStatusFilter.length < ALL_PLAY_STATUSES.length &&
					!playStatusFilter.includes(status)
				) {
					continue;
				}
			} else if (
				playStatusFilter !== "all" &&
				status !== playStatusFilter
			) {
				continue;
			}

			if (applyNsfwFilter && nsfwFilter && getGameNsfwStatus(game)) {
				continue;
			}

			ids.push(id);
			if (includeGames) games.push(game);
		}

		return { ids, games: includeGames ? games : EMPTY_GAMES };
	}, [
		sortedIds,
		index.displayById,
		scopedGameIdSet,
		playStatusFilter,
		applyNsfwFilter,
		nsfwFilter,
		includeGames,
	]);

	const normalizedTagFilters = useMemo(() => {
		return buildNormalizedTagSet(tagFilters);
	}, [tagFilters]);

	const filteredResult = useMemo(() => {
		if (normalizedTagFilters.size === 0 || baseFilteredResult.ids.length === 0) {
			return baseFilteredResult;
		}

		const ids: number[] = [];
		const games: GameData[] = [];
		for (const id of baseFilteredResult.ids) {
			const game = index.displayById.get(id);
			if (!game || !gameMatchesTagFilters(game, normalizedTagFilters)) continue;
			ids.push(id);
			if (includeGames) games.push(game);
		}

		return { ids, games: includeGames ? games : EMPTY_GAMES };
	}, [baseFilteredResult, normalizedTagFilters, index.displayById, includeGames]);

	return {
		index,
		baseFilteredGames: baseFilteredResult.games,
		filteredGames: filteredResult.games,
		filteredGameIds: filteredResult.ids,
		isLoading: gameIndexQuery.isLoading || gameIdListQuery.isLoading,
		isError: gameIndexQuery.isError || gameIdListQuery.isError,
		error: gameIndexQuery.error ?? gameIdListQuery.error,
	};
}

/**
 * 游戏列表门面 Hook
 *
 * 在基础筛选结果上应用搜索关键词，返回最终卡片 ID 列表。
 * 只有实际展示游戏列表的页面才应使用这个 Hook。
 */
export function useGameListFacade(options: GameListScopeOptions = {}) {
	const searchKeyword = useStore((s) => s.searchKeyword);
	const trimmedSearchKeyword = searchKeyword.trim();
	const shouldBuildSearchIndex = trimmedSearchKeyword.length > 0;
	const { index, filteredGames, filteredGameIds, isLoading, isError, error } =
		useFilteredGamesFacade({
			...options,
			includeGames: shouldBuildSearchIndex || Boolean(options.includeGames),
		});

	const searchIndex = useMemo(() => {
		if (!shouldBuildSearchIndex) return null;
		return createSearchIndex(filteredGames);
	}, [filteredGames, shouldBuildSearchIndex]);

	const gameIds = useMemo(() => {
		if (!trimmedSearchKeyword || !searchIndex) return filteredGameIds;
		return searchWithIndex(searchIndex, trimmedSearchKeyword, {
			limit: filteredGames.length,
		}).map((result) => result.item.id);
	}, [searchIndex, trimmedSearchKeyword, filteredGames, filteredGameIds]);

	return {
		displayById: index.displayById,
		filteredGames,
		gameIds,
		isLoading,
		isError,
		error,
	};
}
