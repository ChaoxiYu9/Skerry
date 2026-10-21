import { useMutation } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import {
	useAddGame,
	useAllGames,
	useBatchAddGames,
} from "@/hooks/queries/useGames";
import {
	createGameIdentityIndex,
	type GameIdentityPayload,
	hasGameIdentityCollision,
	planUniqueGameCandidates,
} from "@/metadata/data/gameIdentityRules";
import {
	reconcileBulkImportOutcomes,
	type BulkImportItemOutcome,
	type BulkImportPreparationFailure,
} from "@/metadata/data/bulkImportOutcomes";
import {
	type BatchImportGameCandidate,
	buildBulkImportGameData,
	buildInsertGameData,
	type GameRuntimeInsertOptions,
} from "@/metadata/data/metadata";
import { getSourceIdFromRecords } from "@/metadata/sourceRecord";
import i18n from "@/providers/i18n";
import { createCloudPlayStatusContext } from "@/services/cloudPlayStatus";
import type {
	BatchOperationResult,
	GameMetadataDraft,
	InsertGameParams,
} from "@/types";
import { getUserErrorMessage } from "@/utils/errors";

export interface BulkImportActionInput extends BatchImportGameCandidate {
	status?: string;
}

export type BulkImportPreparationError = BulkImportPreparationFailure;

export interface BulkImportActionResult {
	itemOutcomes: Array<BulkImportItemOutcome | undefined>;
	batchResult?: BatchOperationResult;
}

export function useGameDuplicateChecker() {
	const { data: allGames = [] } = useAllGames();
	const existingGameIdentities = useMemo(
		() => createGameIdentityIndex(allGames),
		[allGames],
	);

	const checkGameExists = useCallback(
		(gameData: GameIdentityPayload) => {
			return hasGameIdentityCollision(gameData, existingGameIdentities);
		},
		[existingGameIdentities],
	);

	return {
		checkGameExists,
		existingGameIdentities,
	};
}

export function useSingleGameAddActions() {
	const addGameMutation = useAddGame();
	const { checkGameExists } = useGameDuplicateChecker();
	const metadataAddActionMutation = useMutation({
		mutationFn: async ({
			gameData,
			runtimeOptions,
		}: {
			gameData: GameMetadataDraft;
			runtimeOptions?: GameRuntimeInsertOptions;
		}) => {
			const insertData = await buildInsertGameData(gameData, runtimeOptions);

			if (checkGameExists(insertData)) {
				throw new Error(i18n.t("components.AddModal.gameExists", "游戏已存在"));
			}

			return addGameMutation.mutateAsync(insertData);
		},
	});

	const addGameFromMetadata = useCallback(
		async (
			gameData: GameMetadataDraft,
			runtimeOptions?: GameRuntimeInsertOptions,
		) => {
			return metadataAddActionMutation.mutateAsync({
				gameData,
				runtimeOptions,
			});
		},
		[metadataAddActionMutation],
	);

	return {
		addGameFromMetadata,
		isAddingGame: metadataAddActionMutation.isPending,
	};
}

export function useBulkGameAddActions() {
	const batchAddGamesMutation = useBatchAddGames();
	const { checkGameExists, existingGameIdentities } =
		useGameDuplicateChecker();
	const [isPreparingGames, setIsPreparingGames] = useState(false);

	const addGamesFromBulkImport = useCallback(
		async (items: BulkImportActionInput[]): Promise<BulkImportActionResult> => {
			setIsPreparingGames(true);
			try {
				const preparedPayloads: Array<{
					itemIndex: number;
					payload: InsertGameParams;
				}> = [];
				const preparationErrors: BulkImportPreparationError[] = [];
				// 云端游玩状态同步只预取已接入账号的数据源。
				const cloudBgmIds = new Set<string>();
				const cloudVndbIds = new Set<string>();
				const cloudHikarinagiIds = new Set<string>();
				const cloudKunIds = new Set<string>();
				for (const item of items) {
					if (
						item.status === "imported" ||
						item.skipCloudStatusLookup ||
						item.playStatus !== undefined
					) {
						continue;
					}
					const bgmId = item.matchedData
						? getSourceIdFromRecords(item.matchedData, "bgm")
						: undefined;
					const vndbId = item.matchedData
						? getSourceIdFromRecords(item.matchedData, "vndb")
						: undefined;
					const hikarinagiId = item.matchedData
						? getSourceIdFromRecords(item.matchedData, "hikarinagi")
						: undefined;
					const kunId = item.matchedData
						? getSourceIdFromRecords(item.matchedData, "kun")
						: undefined;
					if (bgmId) {
						cloudBgmIds.add(bgmId);
					}
					if (vndbId) {
						cloudVndbIds.add(vndbId);
					}
					if (hikarinagiId) {
						cloudHikarinagiIds.add(hikarinagiId);
					}
					if (kunId) {
						cloudKunIds.add(kunId);
					}
				}
				const cloudStatusContext = await createCloudPlayStatusContext({
					bgmIds: cloudBgmIds,
					vndbIds: cloudVndbIds,
					hikarinagiIds: cloudHikarinagiIds,
					kunIds: cloudKunIds,
				});

				for (let index = 0; index < items.length; index++) {
					if (items[index].status === "imported") {
						continue;
					}

					let payload: InsertGameParams;
					try {
						const item = items[index];
						payload = await buildBulkImportGameData(
							item,
							item.playStatus !== undefined || item.skipCloudStatusLookup
								? {}
								: cloudStatusContext,
						);
					} catch (error) {
						const message = getUserErrorMessage(
							error,
							i18n.t.bind(i18n),
							i18n.t("errors.unknownError", "未知错误"),
						);
						preparationErrors.push({
							itemIndex: index,
							message,
						});
						continue;
					}

					preparedPayloads.push({ itemIndex: index, payload });
				}

				const identityPlan = planUniqueGameCandidates(
					preparedPayloads.map(({ payload }) => payload),
					existingGameIdentities,
				);
				const payloads = identityPlan.accepted.map(
					({ candidate }) => candidate,
				);
				const duplicateItemIndices = identityPlan.duplicateIndices.map(
					(index) => preparedPayloads[index].itemIndex,
				);
				const pendingPayloads = identityPlan.accepted.map(
					({ candidateIndex }, payloadIndex) => ({
						itemIndex: preparedPayloads[candidateIndex].itemIndex,
						payloadIndex,
					}),
				);

				if (payloads.length === 0) {
					return {
						itemOutcomes: reconcileBulkImportOutcomes({
							itemCount: items.length,
							preparationErrors,
							duplicateItemIndices,
							pendingPayloads,
						}),
					};
				}

				try {
					const batchResult = await batchAddGamesMutation.mutateAsync(payloads);
					return {
						itemOutcomes: reconcileBulkImportOutcomes({
							itemCount: items.length,
							preparationErrors,
							duplicateItemIndices,
							pendingPayloads,
							batchResult,
						}),
						batchResult,
					};
				} catch (error) {
					const mutationError = getUserErrorMessage(
						error,
						i18n.t.bind(i18n),
						i18n.t("errors.unknownError", "未知错误"),
					);
					return {
						itemOutcomes: reconcileBulkImportOutcomes({
							itemCount: items.length,
							preparationErrors,
							duplicateItemIndices,
							pendingPayloads,
							mutationError,
						}),
					};
				}
			} finally {
				setIsPreparingGames(false);
			}
		},
		[batchAddGamesMutation, existingGameIdentities],
	);

	return {
		addGamesFromBulkImport,
		checkGameExists,
		isAddingGames: isPreparingGames,
	};
}
