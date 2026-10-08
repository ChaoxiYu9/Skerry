import type { GameRuntimeInsertOptions } from "@/metadata/data/metadata";
import { getDisplayGameData } from "@/metadata/data/dataTransform";
import {
	handleLaunchFile,
	splitExecutablePath,
} from "@/services/fs/fileDialog";
import type { NextUpVirtualGame } from "@/store/appStore";
import type {
	GameMetadataDraft,
	FullGameData,
	UpdateGameParams,
} from "@/types";
import { isSourceType } from "@/types";

export function buildNextUpFullGame(game: NextUpVirtualGame): FullGameData {
	return {
		id: game.id,
		id_type: game.sourceRecords?.length
			? game.idType || "mixed"
			: game.idType || "custom",
		sources: (game.sourceRecords ?? []).map((record) => ({
			source: record.source,
			external_id: record.external_id,
			data: record.data,
		})),
		custom_data: {
			staff: game.staff,
			staff_overridden: game.staff ? true : undefined,
			user_rating: game.userRating,
			user_review: game.userReview,
			...game.customData,
			image: game.coverAsset ?? game.customData?.image,
			banner: game.bannerAsset ?? game.customData?.banner,
		},
		date: game.date,
	} as FullGameData;
}

export function buildNextUpMetadataDraft(
	game: NextUpVirtualGame,
): GameMetadataDraft {
	const rawGame = buildNextUpFullGame(game);
	const display = getDisplayGameData(rawGame);

	return {
		id_type: rawGame.id_type,
		sources: game.sourceRecords ?? [],
		custom_data: {
			name: display.name_cn || display.name,
			aliases: display.aliases,
			summary: display.summary,
			tags: display.tags,
			developer: display.developer,
			nsfw: display.nsfw,
			staff: game.staff,
			staff_overridden: game.staff ? true : undefined,
			user_rating: game.userRating,
			user_review: game.userReview,
			cover_source: game.customData?.cover_source,
		},
	};
}

export function applyNextUpEditUpdates(
	game: NextUpVirtualGame,
	updates: UpdateGameParams,
): Partial<Omit<NextUpVirtualGame, "id">> {
	const nextUpdates: Partial<Omit<NextUpVirtualGame, "id">> = {};
	const nextCustomData = { ...game.customData };
	const customData = updates.custom_data;

	if (customData) {
		if (customData.name !== undefined) {
			nextUpdates.name = customData.name || game.name;
		}
		if (customData.name_cn !== undefined) {
			nextUpdates.nameCn = customData.name_cn || undefined;
		}
		if (customData.aliases !== undefined) {
			nextUpdates.aliases = customData.aliases || undefined;
		}
		if (customData.summary !== undefined) {
			nextUpdates.summary = customData.summary || undefined;
		}
		if (customData.tags !== undefined) {
			nextUpdates.tags = customData.tags || undefined;
		}
		if (customData.developer !== undefined) {
			nextUpdates.developer = customData.developer || undefined;
		}
		if (customData.nsfw !== undefined) {
			nextUpdates.nsfw = customData.nsfw ?? undefined;
		}
		if (customData.staff !== undefined) {
			nextUpdates.staff = customData.staff || undefined;
		}
		if (customData.image !== undefined) {
			nextUpdates.coverAsset = customData.image || undefined;
		}
		if (customData.banner !== undefined) {
			nextUpdates.bannerAsset = customData.banner || undefined;
		}

		if (customData.banner_focus !== undefined) {
			nextCustomData.banner_focus = customData.banner_focus;
		}
		if (customData.cover_source !== undefined) {
			nextCustomData.cover_source = customData.cover_source;
		}
		if (Object.keys(nextCustomData).length > 0) {
			nextUpdates.customData = nextCustomData;
		}
	}

	if (updates.date !== undefined) {
		nextUpdates.date = updates.date || undefined;
	}

	const sourceRecordMap = new Map(
		(game.sourceRecords ?? []).map((record) => [record.source, record]),
	);
	for (const record of updates.upsert_sources ?? []) {
		if (!isSourceType(record.source) || !record.external_id) continue;
		sourceRecordMap.set(record.source, {
			source: record.source,
			external_id: record.external_id,
			data: record.data,
		});
	}
	for (const source of updates.remove_sources ?? []) {
		if (isSourceType(source)) sourceRecordMap.delete(source);
	}
	if (updates.id_type !== undefined) {
		nextUpdates.idType = updates.id_type;
	}
	if (
		updates.upsert_sources !== undefined ||
		updates.remove_sources !== undefined
	) {
		const nextSourceRecords = [...sourceRecordMap.values()];
		nextUpdates.sourceRecords = nextSourceRecords;
		nextUpdates.sources = nextSourceRecords
			.filter((record) => record.external_id)
			.map((record) => ({
				source: record.source,
				externalId: record.external_id,
			}));
	}

	return nextUpdates;
}

export async function selectNextUpRuntimeOptions(): Promise<GameRuntimeInsertOptions | null> {
	const selection = await handleLaunchFile();
	if (!selection) return null;

	if (selection.launchType === "steam") {
		return {
			localpath: selection.target.localpath,
			executable: selection.target.executable,
			launch_type: "steam",
			steam_launch_id: selection.target.steam_launch_id,
		};
	}

	return splitExecutablePath(selection.path);
}
