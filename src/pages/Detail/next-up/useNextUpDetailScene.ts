import { useCallback, useEffect, useMemo, useRef } from "react";
import { getDisplayGameData } from "@/metadata/data/dataTransform";
import { candidateSourcesToGameSources } from "@/metadata/sourceCandidate";
import {
	getNextUpAssetUrl,
	pruneMissingNextUpAssets,
} from "@/pages/NextUpDetail/nextUpAssets";
import {
	applyNextUpEditUpdates,
	buildNextUpFullGame,
} from "@/pages/NextUpDetail/nextUpLibraryImport";
import type { NextUpVirtualGame } from "@/store/appStore";
import { useStore } from "@/store/appStore";
import type { FullGameData, GameData, UpdateGameParams } from "@/types";

function createNextUpDisplayGame(
	game: NextUpVirtualGame,
	rawGame: FullGameData,
): GameData {
	const displayGame = getDisplayGameData(rawGame);
	displayGame.image =
		getNextUpAssetUrl(game, "cover") || displayGame.image || game.image;
	displayGame.custom_data = {
		...displayGame.custom_data,
		name: game.name,
		name_cn: game.nameCn,
		summary: game.summary,
		developer: game.developer,
		tags: game.tags,
		aliases: game.aliases,
		nsfw: game.nsfw,
		image: game.coverAsset ?? displayGame.custom_data?.image,
		banner: game.bannerAsset ?? displayGame.custom_data?.banner,
	};
	if (game.name) displayGame.name = game.name;
	if (game.nameCn !== undefined) displayGame.name_cn = game.nameCn;
	if (game.summary !== undefined) displayGame.summary = game.summary;
	if (game.developer !== undefined) displayGame.developer = game.developer;
	if (game.tags !== undefined) displayGame.tags = game.tags;
	if (game.aliases !== undefined) displayGame.aliases = game.aliases;
	if (game.nsfw !== undefined) displayGame.nsfw = game.nsfw;
	if (game.date !== undefined) displayGame.date = game.date;
	return displayGame;
}

export function useNextUpDetailScene(id: number | null) {
	const game = useStore((state) =>
		id === null
			? undefined
			: state.nextUpVirtualGames.find((item) => item.id === id),
	);
	const updateGame = useStore((state) => state.updateNextUpVirtualGame);
	const prunedAssetIdsRef = useRef<Set<number>>(new Set());

	// biome-ignore lint/correctness/useExhaustiveDependencies: Cleanup is intentionally keyed by game ID, matching the previous detail behavior.
	useEffect(() => {
		if (!game || prunedAssetIdsRef.current.has(game.id)) return;
		prunedAssetIdsRef.current.add(game.id);
		let cancelled = false;

		pruneMissingNextUpAssets(game)
			.then((updates) => {
				if (!cancelled && updates) updateGame(game.id, updates);
			})
			.catch((error) => console.warn("清理心愿媒体引用失败:", error));

		return () => {
			cancelled = true;
		};
	}, [game?.id, updateGame]);

	const rawGame = useMemo(
		() => (game ? buildNextUpFullGame(game) : undefined),
		[game],
	);
	const displayGame = useMemo(
		() => (game && rawGame ? createNextUpDisplayGame(game, rawGame) : null),
		[game, rawGame],
	);
	const saveEdit = useCallback(
		async (updates: UpdateGameParams): Promise<FullGameData> => {
			if (!game || !displayGame) {
				throw new Error("Next up game not found");
			}

			const virtualUpdates = applyNextUpEditUpdates(game, updates);
			updateGame(game.id, virtualUpdates);

			const mergedCustomData = {
				...displayGame.custom_data,
				...virtualUpdates.customData,
				name: virtualUpdates.name ?? game.name,
				name_cn: virtualUpdates.nameCn ?? game.nameCn,
				summary: virtualUpdates.summary ?? game.summary,
				developer: virtualUpdates.developer ?? game.developer,
				tags: virtualUpdates.tags ?? game.tags,
				aliases: virtualUpdates.aliases ?? game.aliases,
				nsfw: virtualUpdates.nsfw ?? game.nsfw,
			};

			return {
				...displayGame,
				name: virtualUpdates.name ?? game.name,
				name_cn: virtualUpdates.nameCn ?? game.nameCn,
				date: virtualUpdates.date ?? game.date,
				sources: candidateSourcesToGameSources(
					virtualUpdates.sourceRecords ?? game.sourceRecords ?? [],
				),
				custom_data: mergedCustomData,
			} as unknown as FullGameData;
		},
		[displayGame, game, updateGame],
	);

	return { game, rawGame, displayGame, updateGame, saveEdit };
}
