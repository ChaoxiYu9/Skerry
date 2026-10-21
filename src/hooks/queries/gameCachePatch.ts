import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { FullGameData } from "@/types";
import type { GameIndex } from "@/utils/game/gameIndex";
import { getGameIndex } from "@/utils/game/gameIndex";

interface GameCacheKeys {
	all: QueryKey;
	index: () => QueryKey;
}

function getCurrentIndex(
	queryClient: QueryClient,
	keys: GameCacheKeys,
	currentGames: FullGameData[],
): GameIndex {
	const cached = queryClient.getQueryData<GameIndex>(keys.index());
	return cached?.rawList === currentGames ? cached : getGameIndex(currentGames);
}

function commitGameCaches(
	queryClient: QueryClient,
	keys: GameCacheKeys,
	nextGames: FullGameData[],
	previousIndex: GameIndex,
): void {
	queryClient.setQueryData(keys.all, nextGames);
	const storedGames =
		queryClient.getQueryData<FullGameData[]>(keys.all) ?? nextGames;
	// Query's structural sharing may retain old record identities. Build views
	// from exactly what it committed, so all lookups agree with the raw cache.
	const storedIndex = getGameIndex(storedGames, previousIndex);
	queryClient.setQueryData(keys.index(), storedIndex);
}

export function patchGameCaches(
	queryClient: QueryClient,
	keys: GameCacheKeys,
	updatedFullGame: FullGameData,
): void {
	const currentGames = queryClient.getQueryData<FullGameData[]>(keys.all);
	if (!currentGames) return;

	const nextGames = currentGames.map((game) =>
		game.id === updatedFullGame.id ? updatedFullGame : game,
	);
	commitGameCaches(
		queryClient,
		keys,
		nextGames,
		getCurrentIndex(queryClient, keys, currentGames),
	);
}

export function patchManyGameCaches(
	queryClient: QueryClient,
	keys: GameCacheKeys,
	updatedFullGames: FullGameData[],
): void {
	if (updatedFullGames.length === 0) return;
	const currentGames = queryClient.getQueryData<FullGameData[]>(keys.all);
	if (!currentGames) return;

	const updatesById = new Map(
		updatedFullGames.map((game) => [game.id, game] as const),
	);

	const nextGames = currentGames.map(
		(game) => updatesById.get(game.id) ?? game,
	);
	commitGameCaches(
		queryClient,
		keys,
		nextGames,
		getCurrentIndex(queryClient, keys, currentGames),
	);
}

export function appendGamesToCaches(
	queryClient: QueryClient,
	keys: GameCacheKeys,
	insertedFullGames: FullGameData[],
): boolean {
	if (insertedFullGames.length === 0) return false;
	const currentGames = queryClient.getQueryData<FullGameData[]>(keys.all);
	if (!currentGames) return false;

	const currentIds = new Set(currentGames.map((game) => game.id));
	const newGames: FullGameData[] = [];
	for (const game of insertedFullGames) {
		if (currentIds.has(game.id)) continue;
		currentIds.add(game.id);
		newGames.push(game);
	}
	if (newGames.length === 0) return true;

	const nextGames = [...newGames, ...currentGames];
	commitGameCaches(
		queryClient,
		keys,
		nextGames,
		getCurrentIndex(queryClient, keys, currentGames),
	);

	return true;
}

export function removeGamesFromCaches(
	queryClient: QueryClient,
	keys: GameCacheKeys,
	gameIds: number[],
): void {
	if (gameIds.length === 0) return;
	const currentGames = queryClient.getQueryData<FullGameData[]>(keys.all);
	if (!currentGames) return;

	const removedIds = new Set(gameIds);

	const nextGames = currentGames.filter((game) => !removedIds.has(game.id));
	commitGameCaches(
		queryClient,
		keys,
		nextGames,
		getCurrentIndex(queryClient, keys, currentGames),
	);
}
