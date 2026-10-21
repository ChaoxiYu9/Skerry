import { useCallback } from "react";
import { useStore } from "@/store/appStore";
import type { UpdateGameParams } from "@/types";
import type { DetailSceneKind } from "./detailSceneCapabilities";

interface DetailScenePersistenceOptions {
	sceneKind: DetailSceneKind;
	gameId: number;
	updateLibraryGame: (input: {
		gameId: number;
		updates: UpdateGameParams;
	}) => Promise<unknown>;
}

export function useDetailScenePersistence({
	sceneKind,
	gameId,
	updateLibraryGame,
}: DetailScenePersistenceOptions) {
	const updateNextUpGame = useStore((state) => state.updateNextUpVirtualGame);

	return useCallback(
		async (customData: NonNullable<UpdateGameParams["custom_data"]>) => {
			if (sceneKind === "next-up") {
				updateNextUpGame(gameId, { customData });
				return;
			}
			await updateLibraryGame({
				gameId,
				updates: { custom_data: customData },
			});
		},
		[gameId, sceneKind, updateLibraryGame, updateNextUpGame],
	);
}
