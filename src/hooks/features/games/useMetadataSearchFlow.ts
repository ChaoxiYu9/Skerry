import type { TFunction } from "i18next";
import { useCallback, useMemo, useState } from "react";
import {
	getRuntimeSourceAdapter,
	REGISTERED_SOURCE_KEYS,
	SEARCHABLE_SOURCE_KEYS,
	type SourceCandidate,
} from "@/metadata";
import type {
	MixedSourceCandidates,
	MixedSourceEnabled,
	MixedSourceSelection,
} from "@/metadata/data/metadata";
import { withMetadataAuth } from "@/services/metadataAuth";
import { isBgmAuthExpiredError } from "@/services/oauth/bgmAuthSession";
import { isHikarinagiAuthExpiredError } from "@/services/oauth/hikarinagiAuthSession";
import { createMetadataSession } from "@/services/requestContext";
import type { apiSourceType, GameMetadataDraft, SourceType } from "@/types";
import { isAbortError } from "@/utils/async";
import { getUserErrorMessage } from "@/utils/errors";

interface SearchResultState {
	open: boolean;
	results: SourceCandidate[];
	apiSource: SourceType;
}

interface MixedCandidateState {
	open: boolean;
	candidates: MixedSourceCandidates;
	failedSources: SourceType[];
}

interface SearchMetadataParams {
	query: string;
	source: apiSourceType;
	withAbort?: <T>(promise: Promise<T>) => Promise<T>;
	signal?: AbortSignal;
}

interface MetadataSearchFlowOptions {
	mixedEnabledSources?: readonly SourceType[];
	t: TFunction;
	onResolved: (
		gameData: GameMetadataDraft,
		failedSources?: readonly SourceType[],
	) => void | Promise<void>;
	onError: (message: string) => void;
}

const EMPTY_MIXED_CANDIDATES = REGISTERED_SOURCE_KEYS.reduce(
	(candidates, source) => {
		candidates[source] = [];
		return candidates;
	},
	{} as MixedSourceCandidates,
);

const initialSearchResultState: SearchResultState = {
	open: false,
	results: [],
	apiSource: SEARCHABLE_SOURCE_KEYS[0] as SourceType,
};

function hasAnyMixedCandidate(candidates: MixedSourceCandidates): boolean {
	return Object.values(candidates).some(
		(sourceCandidates) => sourceCandidates.length > 0,
	);
}

function getDefaultNoResultsMessage(
	t: TFunction,
	source: apiSourceType,
): string {
	if (source === "mixed") {
		return t("components.AddModal.noResultsMixed", "所有数据源均未找到该游戏");
	}

	return t(
		"components.AddModal.noResultsSource",
		"未在 {{source}} 找到该游戏，请尝试其他名称或检查 ID",
		{ source: getRuntimeSourceAdapter(source).label },
	);
}

export function useMetadataSearchFlow({
	mixedEnabledSources,
	t,
	onResolved,
	onError,
}: MetadataSearchFlowOptions) {
	const [searchResultState, setSearchResultState] = useState<SearchResultState>(
		initialSearchResultState,
	);
	const [mixedCandidateState, setMixedCandidateState] =
		useState<MixedCandidateState>({
			open: false,
			candidates: EMPTY_MIXED_CANDIDATES,
			failedSources: [],
		});
	const [isSearching, setIsSearching] = useState(false);

	const getNoResultsText = useCallback(
		(source: apiSourceType) => getDefaultNoResultsMessage(t, source),
		[t],
	);

	const closeSearchResult = useCallback(() => {
		setSearchResultState(initialSearchResultState);
	}, []);

	const closeMixedCandidates = useCallback(() => {
		setMixedCandidateState({
			open: false,
			candidates: EMPTY_MIXED_CANDIDATES,
			failedSources: [],
		});
	}, []);

	const reset = useCallback(() => {
		closeSearchResult();
		closeMixedCandidates();
		setIsSearching(false);
	}, [closeMixedCandidates, closeSearchResult]);

	const searchMetadata = useCallback(
		async ({ query, source, withAbort, signal }: SearchMetadataParams) => {
			setIsSearching(true);

			try {
				if (source === "mixed") {
					const searchMixedCandidates = (tokens: {
						bgmToken?: string;
						hikarinagiToken?: string;
					}) => {
						const session = createMetadataSession({ ...tokens, signal });
						const candidatesPromise = session.searchMixedSourceCandidates({
							query,
							mixedEnabledSources,
						});
						return withAbort ? withAbort(candidatesPromise) : candidatesPromise;
					};
					const result = await withMetadataAuth(
						mixedEnabledSources ?? REGISTERED_SOURCE_KEYS,
						searchMixedCandidates,
					);

					if (!hasAnyMixedCandidate(result.candidates)) {
						throw new Error(getNoResultsText(source));
					}

					setMixedCandidateState({
						open: true,
						candidates: result.candidates,
						failedSources: result.failedSources,
					});
					return;
				}

				if (getRuntimeSourceAdapter(source).validateId(query.trim())) {
					const searchById = (tokens: {
						bgmToken?: string;
						hikarinagiToken?: string;
					}) => {
						const searchPromise = createMetadataSession({
							...tokens,
							signal,
						}).searchGames({
							query,
							source,
						});
						return withAbort ? withAbort(searchPromise) : searchPromise;
					};
					const results = await withMetadataAuth([source], searchById, {
						requireHikarinagi: source === "hikarinagi",
					});

					if (results.length === 0) {
						throw new Error(getNoResultsText(source));
					}

					await onResolved(results[0]);
					return;
				}

				const searchCandidates = (tokens: {
					bgmToken?: string;
					hikarinagiToken?: string;
				}) => {
					const searchPromise = createMetadataSession({
						...tokens,
						signal,
					}).searchByName({
						query,
						source,
					});
					return withAbort ? withAbort(searchPromise) : searchPromise;
				};
				const results = await withMetadataAuth([source], searchCandidates, {
					requireHikarinagi: source === "hikarinagi",
				});

				if (results.length === 0) {
					throw new Error(getNoResultsText(source));
				}

				setSearchResultState({
					open: true,
					results,
					apiSource: source,
				});
			} catch (error) {
				if (isAbortError(error)) {
					return;
				}
				if (
					isBgmAuthExpiredError(error) ||
					isHikarinagiAuthExpiredError(error)
				) {
					return;
				}
				onError(getUserErrorMessage(error, t));
			} finally {
				setIsSearching(false);
			}
		},
		[getNoResultsText, mixedEnabledSources, onError, onResolved, t],
	);

	const selectGame = useCallback(
		async (selectedCandidate: SourceCandidate) => {
			if (!selectedCandidate) {
				return;
			}

			setIsSearching(true);
			try {
				const resolvedGame = await withMetadataAuth(
					[selectedCandidate.source],
					(tokens) =>
						createMetadataSession(tokens).resolveSourceCandidateSelection({
							candidate: selectedCandidate,
						}),
					{
						requireHikarinagi: selectedCandidate.source === "hikarinagi",
					},
				);
				await onResolved(resolvedGame);
				closeSearchResult();
			} catch (error) {
				onError(getUserErrorMessage(error, t));
			} finally {
				setIsSearching(false);
			}
		},
		[closeSearchResult, onError, onResolved, t],
	);

	const confirmMixedSelection = useCallback(
		async (selection: MixedSourceSelection, enabled: MixedSourceEnabled) => {
			setIsSearching(true);
			try {
				const selectedSources = REGISTERED_SOURCE_KEYS.filter(
					(source) => enabled[source] && Boolean(selection[source]),
				);
				const gameData = await withMetadataAuth(
					selectedSources,
					(tokens) =>
						createMetadataSession(tokens).resolveMixedSourceSelection({
							selection,
							enabled,
						}),
					{
						requireHikarinagi: selectedSources.includes("hikarinagi"),
					},
				);
				await onResolved(gameData, mixedCandidateState.failedSources);
				closeMixedCandidates();
			} catch (error) {
				closeMixedCandidates();
				onError(getUserErrorMessage(error, t));
			} finally {
				setIsSearching(false);
			}
		},
		[
			closeMixedCandidates,
			mixedCandidateState.failedSources,
			onError,
			onResolved,
			t,
		],
	);

	return useMemo(
		() => ({
			searchResultState,
			mixedCandidateState,
			isSearching,
			searchMetadata,
			closeSearchResult,
			closeMixedCandidates,
			reset,
			selectGame,
			confirmMixedSelection,
		}),
		[
			closeMixedCandidates,
			closeSearchResult,
			confirmMixedSelection,
			isSearching,
			mixedCandidateState,
			reset,
			searchMetadata,
			searchResultState,
			selectGame,
		],
	);
}
