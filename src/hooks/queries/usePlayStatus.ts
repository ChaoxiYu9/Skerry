/**
 * @file 游戏状态查询层
 * @description 使用 React Query 管理游戏状态 (PlayStatus) 的更新操作
 * @module src/hooks/queries/usePlayStatus
 *
 * 包含：
 * - Key Factory：统一的 Query Key 前缀
 * - Mutations：数据操作 hooks
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { patchGameCaches } from "@/hooks/queries/gameCachePatch";
import { gameKeys } from "@/hooks/queries/useGames";
import { gameService } from "@/services/invoke";
import type { FullGameData } from "@/types";
import type { PlayStatus } from "@/types/collection";

// ============================================================================
// Key Factory - 统一的 Query Key 前缀
// ============================================================================

export const playStatusKeys = {
	all: ["playStatus"] as const,
	game: (gameId: number) => ["playStatus", "game", gameId] as const,
};

// ============================================================================
// Mutations - 数据操作 hooks
// ============================================================================

export interface UpdatePlayStatusParams {
	gameId: number;
	newStatus: PlayStatus;
	invalidateScope?: "game" | "all";
}

async function updatePlayStatus({
	gameId,
	newStatus,
}: UpdatePlayStatusParams): Promise<FullGameData> {
	return gameService.updateGame(gameId, {
		clear: newStatus,
	});
}

/**
 * 更新游戏状态的 mutation hook
 *
 * @example
 * const { mutate: updateStatus } = useUpdatePlayStatus();
 *
 * // 更新游戏状态
 * updateStatus({
 *   gameId: 123,
 *   newStatus: PlayStatus.PLAYED
 * });
 */
export function useUpdatePlayStatus() {
	const queryClient = useQueryClient();

	return useMutation<FullGameData, Error, UpdatePlayStatusParams>({
		mutationFn: updatePlayStatus,
		onSuccess: (updatedFullGame, { gameId, invalidateScope = "game" }) => {
			patchGameCaches(queryClient, gameKeys, updatedFullGame);
			queryClient.invalidateQueries({ queryKey: gameKeys.idLists() });

			if (invalidateScope === "all") {
				queryClient.invalidateQueries({
					queryKey: playStatusKeys.all,
				});
			}
			queryClient.invalidateQueries({
				queryKey: playStatusKeys.game(gameId),
			});
		},
	});
}
