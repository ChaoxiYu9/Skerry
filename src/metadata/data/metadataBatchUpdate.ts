import i18next from "i18next";
import { patchManyGameCaches } from "@/hooks/queries/gameCachePatch";
import { gameKeys } from "@/hooks/queries/useGames";
import { queryClient } from "@/providers/queryClient";
import { gameService } from "@/services/invoke";
import { withBgmAuth } from "@/services/oauth/bgmAuthSession";
import { getMetadataRequestContext } from "@/services/requestContext";
import type { GameMetadataDraft, UpdateGameParams } from "@/types";
import { toError } from "@/utils/errors";
import { fetchBgmByIds } from "../api/bgm";
import { fetchVNDBByIds } from "../api/vndb";
import { candidateSourcesToGameSources, getCandidateSourceRecord } from "../sourceCandidate";

export interface BatchMetadataSyncResult {
	total: number;
	success: number;
	failed: number;
	matched: number;
	refreshed: number;
}

async function batchUpdateCommon(
	type: "vndb" | "bgm",
	fetchFunction: (ids: string[]) => Promise<GameMetadataDraft[]>,
	getAllIdsFunction: () => Promise<Array<[number, string]>>,
	source: "vndb" | "bgm",
): Promise<BatchMetadataSyncResult> {
	try {
		const idPairs = await getAllIdsFunction();
		if (idPairs.length === 0) {
			return { total: 0, success: 0, failed: 0, matched: 0, refreshed: 0 };
		}

		const ids = idPairs.map(([, id]) => id);
		const results = await fetchFunction(ids);
		const resultByApiId = new Map<string, GameMetadataDraft>();
		for (const result of results) {
			const sourceRecord = getCandidateSourceRecord(result, source);
			if (sourceRecord?.external_id) {
				resultByApiId.set(sourceRecord.external_id, result);
			}
		}

		const updates: Array<[number, UpdateGameParams]> = [];
		for (const [gameId, apiId] of idPairs) {
			const data = resultByApiId.get(apiId);
			const sourceRecord = data ? getCandidateSourceRecord(data, source) : undefined;
			if (!sourceRecord) continue;
			updates.push([gameId, { upsert_sources: candidateSourcesToGameSources([sourceRecord]) }]);
		}

		if (updates.length > 0) {
			const updatedGames = await gameService.updateBatch(updates);
			patchManyGameCaches(queryClient, gameKeys, updatedGames);
			queryClient.invalidateQueries({ queryKey: gameKeys.idLists() });
			queryClient.invalidateQueries({ queryKey: gameKeys.bgmIds() });
			queryClient.invalidateQueries({ queryKey: gameKeys.vndbIds() });
		}

		return {
			total: idPairs.length,
			success: updates.length,
			failed: idPairs.length - updates.length,
			matched: 0,
			refreshed: updates.length,
		};
	} catch (error) {
		console.error("Batch " + type.toUpperCase() + " metadata update failed:", error);
		throw toError(error, i18next.t("errors.unknownError", "Unknown error"));
	}
}

export async function batchUpdateVndbData(): Promise<BatchMetadataSyncResult> {
	return batchUpdateCommon(
		"vndb",
		(ids) => fetchVNDBByIds(ids, getMetadataRequestContext()),
		() => gameService.getAllVndbIds(),
		"vndb",
	);
}

export async function batchUpdateBgmData(): Promise<BatchMetadataSyncResult> {
	return withBgmAuth((token) =>
		batchUpdateCommon(
			"bgm",
			(ids) => fetchBgmByIds(ids, token, getMetadataRequestContext({ bgmToken: token })),
			() => gameService.getAllBgmIds(),
			"bgm",
		),
	);
}
