import { useCallback } from "react";
import { useGameById } from "@/hooks/features/games/useGameFacade";
import { useGameStats } from "@/hooks/queries/useStats";
import type { FullGameData, UpdateGameParams } from "@/types";
import type { DetailSceneKind } from "./detailSceneCapabilities";
import { useNextUpDetailScene } from "./next-up/useNextUpDetailScene";

interface DetailSceneModelOptions {
	sceneKind: DetailSceneKind;
	gameId: number;
	updateLibraryGame: (input: {
		gameId: number;
		updates: UpdateGameParams;
	}) => Promise<FullGameData>;
}

export function useDetailSceneModel({
	sceneKind,
	gameId,
	updateLibraryGame,
}: DetailSceneModelOptions) {
	const isNextUp = sceneKind === "next-up";
	const nextUpScene = useNextUpDetailScene(isNextUp ? gameId : null);
	const libraryGame = useGameById(isNextUp ? null : gameId);
	const gameStatsQuery = useGameStats(isNextUp ? null : gameId);

	const saveEdit = useCallback(
		(updates: UpdateGameParams): Promise<FullGameData> => {
			if (isNextUp) return nextUpScene.saveEdit(updates);
			return updateLibraryGame({ gameId, updates });
		},
		[gameId, isNextUp, nextUpScene.saveEdit, updateLibraryGame],
	);

	return {
		selectedGame: isNextUp ? nextUpScene.displayGame : libraryGame.selectedGame,
		rawSelectedGame: isNextUp ? null : libraryGame.rawSelectedGame,
		rawGameForEdit: isNextUp
			? nextUpScene.rawGame
			: (libraryGame.rawSelectedGame ?? undefined),
		isLoadingSelectedGame: !isNextUp && libraryGame.isLoadingSelectedGame,
		gameStatsQuery,
		nextUpGame: nextUpScene.game,
		nextUpRawGame: nextUpScene.rawGame,
		updateNextUpGame: nextUpScene.updateGame,
		saveEdit,
	};
}
