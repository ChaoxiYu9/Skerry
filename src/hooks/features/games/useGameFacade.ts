import { useGameIndex } from "@/hooks/features/games/useGameListFacade";

/**
 * 按 ID 获取单个游戏的展示数据
 *
 * 从统一 GameIndex.displayById 读取，避免维护单独的 detail 字典缓存。
 */
export function useGameById(gameId: number | null) {
	const gameIndexQuery = useGameIndex();
	const selectedGame =
		gameId === null
			? null
			: (gameIndexQuery.index.displayById.get(gameId) ?? null);
	const rawSelectedGame =
		gameId === null
			? null
			: (gameIndexQuery.index.rawById.get(gameId) ?? null);

	return {
		selectedGame,
		rawSelectedGame,
		isLoadingSelectedGame: gameIndexQuery.isLoading,
	};
}
