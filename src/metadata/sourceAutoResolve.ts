import type { GameMetadataDraft } from "@/types";
import {
	getCandidateSourceData,
	getSourceCandidateFromGame,
	type SourceCandidate,
	sourceCandidateToDraft,
} from "./sourceCandidate";
import type { RuntimeBoundSourceAdapter } from "./sourceRegistry";

export interface AutoResolveSourceCandidateParams {
	query: string;
	adapter: RuntimeBoundSourceAdapter;
	enrichCrossSource?: boolean;
}

async function searchFirstSourceCandidate({
	query,
	adapter,
}: AutoResolveSourceCandidateParams): Promise<SourceCandidate | null> {
	const [candidate] = await adapter.searchByName(query, { limit: 1 });

	return candidate ?? null;
}

export async function resolveAutoSelectedSourceCandidate({
	query,
	adapter,
	enrichCrossSource = true,
}: AutoResolveSourceCandidateParams): Promise<SourceCandidate | null> {
	const candidate = await searchFirstSourceCandidate({
		query,
		adapter,
	});

	if (!candidate) {
		return null;
	}

	if (!adapter.enrichOnSelect) {
		return candidate;
	}

	const draft = await adapter.enrichOnSelect(candidate, { enrichCrossSource });
	const data = getCandidateSourceData(draft, adapter.key) ?? candidate.data;

	return getSourceCandidateFromGame(
		draft,
		adapter,
		adapter.toDisplayFields(data),
	);
}

export async function resolveAutoSelectedGameDraft(
	params: AutoResolveSourceCandidateParams,
): Promise<GameMetadataDraft | null> {
	const candidate = await searchFirstSourceCandidate(params);
	if (!candidate) {
		return null;
	}

	const { adapter } = params;
	if (!adapter.enrichOnSelect || !candidate.externalId) {
		return sourceCandidateToDraft(candidate);
	}

	return adapter.enrichOnSelect(candidate, {
		enrichCrossSource: params.enrichCrossSource ?? true,
	});
}
