import type {
	GameMetadataDraft,
	SourceCandidateRecord,
	UpdateGameParams,
} from "@/types";
import {
	candidateSourcesToGameSources,
	getCandidateSourceRecord,
} from "../sourceCandidate";

type RefreshSource = "bgm" | "vndb";
type GameSourceBinding = readonly [gameId: number, externalId: string];

/**
 * Reconcile provider responses with local source bindings in input order.
 * Each response is projected to its source record once; shared external IDs
 * can then update every matching game without rescanning the same candidate.
 */
export function planMetadataRefreshUpdates(
	bindings: readonly GameSourceBinding[],
	results: readonly GameMetadataDraft[],
	source: RefreshSource,
): Array<[number, UpdateGameParams]> {
	const recordByExternalId = new Map<string, SourceCandidateRecord>();
	for (const result of results) {
		const record = getCandidateSourceRecord(result, source);
		if (record?.external_id) {
			recordByExternalId.set(record.external_id, record);
		}
	}

	const updates: Array<[number, UpdateGameParams]> = [];
	for (const [gameId, externalId] of bindings) {
		const record = recordByExternalId.get(externalId);
		if (!record) continue;

		updates.push([
			gameId,
			{ upsert_sources: candidateSourcesToGameSources([record]) },
		]);
	}

	return updates;
}
