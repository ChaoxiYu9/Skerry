export interface SourceRecordLike<TSource extends string = string> {
	source: TSource;
}

export interface SourceCandidateLike<
	TSource extends string = string,
	TData = unknown,
> {
	source: TSource;
	externalId?: string;
	data: TData;
}

export interface SelectedSourceRecord<
	TSource extends string = string,
	TData = unknown,
> {
	source: TSource;
	external_id: string;
	data: TData;
}

export interface SearchCandidateIdentity<TSource extends string = string> {
	source: TSource;
	externalId?: string;
}

/** Keep the first adapter result for each concrete provider identity. */
export function deduplicateSourceCandidates<
	TCandidate extends SearchCandidateIdentity,
>(candidates: readonly TCandidate[]): TCandidate[] {
	const idsBySource = new Map<string, Set<string>>();
	const unique: TCandidate[] = [];

	for (const candidate of candidates) {
		const externalId = candidate.externalId;
		if (!externalId) {
			unique.push(candidate);
			continue;
		}

		const sourceIds = idsBySource.get(candidate.source) ?? new Set<string>();
		if (sourceIds.has(externalId)) continue;
		sourceIds.add(externalId);
		idsBySource.set(candidate.source, sourceIds);
		unique.push(candidate);
	}

	return unique;
}

/** The first result in the adapter's ranking is the default candidate. */
export function selectDefaultSourceCandidate<TCandidate>(
	candidates: readonly TCandidate[],
): TCandidate | null {
	return candidates[0] ?? null;
}

/**
 * Resolve provider records from ordered drafts.
 * Each draft contributes its first record for a provider; a later draft replaces
 * that provider's earlier record. The returned records always follow the
 * caller's registered provider order.
 */
export function resolveCandidateSourceRecords<
	TSource extends string,
	TRecord extends SourceRecordLike<TSource>,
>(
	drafts: readonly (readonly TRecord[] | null | undefined)[],
	sourceOrder: readonly TSource[],
): TRecord[] {
	const registeredSources = new Set(sourceOrder);
	const selectedBySource = new Map<TSource, TRecord>();

	for (const draftSources of drafts) {
		const seenInDraft = new Set<TSource>();
		for (const record of draftSources ?? []) {
			if (!registeredSources.has(record.source) || seenInDraft.has(record.source)) {
				continue;
			}

			seenInDraft.add(record.source);
			selectedBySource.set(record.source, record);
		}
	}

	return sourceOrder.flatMap((source) => {
		const record = selectedBySource.get(source);
		return record ? [record] : [];
	});
}

/**
 * Build the persisted source list from source-keyed user selections.
 * A candidate cannot be written under a different provider slot than the one
 * that produced it.
 */
export function resolveSelectedSourceRecords<
	TSource extends string,
	TData,
>(params: {
	selection: Partial<Record<TSource, SourceCandidateLike<TSource, TData> | null>>;
	sourceOrder: readonly TSource[];
}): {
	id_type: TSource | "mixed";
	sources: SelectedSourceRecord<TSource, TData>[];
} {
	const sources: SelectedSourceRecord<TSource, TData>[] = [];

	for (const slot of params.sourceOrder) {
		const candidate = params.selection[slot];
		if (!candidate) continue;
		if (candidate.source !== slot) {
			throw new Error(
				`Selected ${slot} candidate belongs to ${candidate.source}`,
			);
		}
		if (!candidate.externalId) {
			throw new Error(`Missing ${candidate.source} external id in candidate`);
		}

		sources.push({
			source: slot,
			external_id: candidate.externalId,
			data: candidate.data,
		});
	}

	if (sources.length === 0) {
		throw new Error("At least one source candidate must be selected");
	}

	return {
		id_type: sources.length === 1 ? sources[0].source : "mixed",
		sources,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * Detail responses fill the selected search record. Missing detail fields keep
 * their search values; explicit null values remain authoritative.
 */
export function mergeSourceDetailPayload(
	searchData: unknown,
	detailData: unknown,
): unknown {
	if (!isRecord(searchData) || !isRecord(detailData)) return detailData;

	const merged = { ...searchData };
	for (const [key, value] of Object.entries(detailData)) {
		if (value !== undefined) merged[key] = value;
	}
	return merged;
}
