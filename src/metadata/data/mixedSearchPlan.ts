import type { SourceType } from "@/types";

export type MixedSearchPlan =
	| { kind: "too-many-sources" }
	| { kind: "invalid-query" }
	| { kind: "name-search"; query: string; sources: SourceType[] };

export interface MixedSearchOutcome<TSource extends string = SourceType> {
	source: TSource;
	failed: boolean;
	attempted: boolean;
	error?: unknown;
}

export function createMixedSearchPlan(params: {
	query?: string;
	sources: readonly SourceType[];
	maxSources: number;
}): MixedSearchPlan {
	const { query, sources, maxSources } = params;
	if (sources.length > maxSources) return { kind: "too-many-sources" };

	const normalizedQuery = query?.trim();
	if (normalizedQuery) {
		return {
			kind: "name-search",
			query: normalizedQuery,
			sources: [...sources],
		};
	}

	return { kind: "invalid-query" };
}

export function summarizeMixedSearchOutcomes<
	TSource extends string = SourceType,
>(
	outcomes: readonly MixedSearchOutcome<TSource>[],
	isNotFound: (error: unknown) => boolean,
) {
	const attempted = outcomes.filter((outcome) => outcome.attempted);
	const allAttemptedFailed =
		attempted.length > 0 && attempted.every((outcome) => outcome.failed);

	return {
		failedSources: outcomes
			.filter((outcome) => outcome.failed)
			.map((outcome) => outcome.source),
		allAttemptedFailed,
		allAttemptedFailuresNotFound:
			allAttemptedFailed && attempted.every((outcome) => isNotFound(outcome.error)),
	};
}
