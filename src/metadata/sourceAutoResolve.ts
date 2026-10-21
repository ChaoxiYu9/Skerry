import type { GameMetadataDraft } from "@/types";
import {
	deduplicateSourceCandidates,
	selectDefaultSourceCandidate,
} from "./data/sourceCandidateRules";
import {
	sourceCandidateToDraft,
	type SourceCandidate,
} from "./sourceCandidate";
import type { MetadataSourceOptions } from "./sourceAdapter";
import type { RuntimeBoundSourceAdapter } from "./sourceRegistry";

export interface AutoResolveGameDraftParams {
	query: string;
	adapter: RuntimeBoundSourceAdapter;
}

async function searchFirstSourceCandidate({
	query,
	adapter,
}: AutoResolveGameDraftParams) {
	const candidates = deduplicateSourceCandidates(
		await adapter.searchByName(query, { limit: 1 }),
	);
	return selectDefaultSourceCandidate(candidates);
}

export async function resolveSourceCandidateDraft(
	candidate: SourceCandidate,
	adapter: RuntimeBoundSourceAdapter,
	options: MetadataSourceOptions = {},
): Promise<GameMetadataDraft> {
	if (!adapter.enrichOnSelect || !candidate.externalId) {
		return sourceCandidateToDraft(candidate);
	}

	return adapter.enrichOnSelect(
		{ ...candidate, externalId: candidate.externalId },
		options,
	);
}

export async function resolveAutoSelectedGameDraft(
	params: AutoResolveGameDraftParams,
): Promise<GameMetadataDraft | null> {
	const candidate = await searchFirstSourceCandidate(params);
	if (!candidate) {
		return null;
	}

	const { adapter } = params;
	return resolveSourceCandidateDraft(candidate, adapter);
}
