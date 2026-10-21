import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { animateDetailClose } from "@/components/motion/detailLaunch";
import { useSingleGameAddActions } from "@/hooks/features/games/useGameMetadataFacade";
import { useUpdateGame } from "@/hooks/queries/useGames";
import { snackbar } from "@/providers/snackBar";
import type { NextUpVirtualGame } from "@/store/appStore";
import { useStore } from "@/store/appStore";
import { getUserErrorMessage } from "@/utils/errors";
import { copyNextUpAssetsToLibrary, deleteNextUpAssets } from "./nextUpAssets";
import {
	buildNextUpMetadataDraft,
	selectNextUpRuntimeOptions,
} from "./nextUpLibraryImport";

export function useNextUpGameLibraryImport(
	game: NextUpVirtualGame | undefined,
) {
	const navigate = useNavigate();
	const { t } = useTranslation();
	const { addGameFromMetadata, isAddingGame } = useSingleGameAddActions();
	const updateGameMutation = useUpdateGame();
	const replaceNextUpGame = useStore((state) => state.replaceNextUpVirtualGame);

	const importGame = useCallback(async () => {
		if (!game) return;
		try {
			const runtimeOptions = await selectNextUpRuntimeOptions();
			if (!runtimeOptions) return;
			const inserted = await addGameFromMetadata(
				buildNextUpMetadataDraft(game),
				runtimeOptions,
			);
			const assets = await copyNextUpAssetsToLibrary(game, inserted.id);
			if (
				assets.image ||
				assets.banner ||
				game.date ||
				Object.keys(assets.customData).length > 0
			) {
				await updateGameMutation.mutateAsync({
					gameId: inserted.id,
					updates: {
						...(game.date ? { date: game.date } : {}),
						custom_data: {
							...inserted.custom_data,
							...assets.customData,
							...(assets.image ? { image: assets.image } : {}),
							...(assets.banner ? { banner: assets.banner } : {}),
						},
					},
				});
			}
			replaceNextUpGame(game.id, inserted.id);
			await deleteNextUpAssets(game);
			snackbar.success(
				t("home.nextUp.importedToLibrary", "已设置游戏路径并加入游戏库"),
			);
			animateDetailClose({
				onComplete: () => navigate(`/libraries/${inserted.id}`),
			});
		} catch (error) {
			snackbar.error(getUserErrorMessage(error, t));
		}
	}, [
		addGameFromMetadata,
		game,
		navigate,
		replaceNextUpGame,
		t,
		updateGameMutation,
	]);

	return { importGame, isAddingGame };
}
