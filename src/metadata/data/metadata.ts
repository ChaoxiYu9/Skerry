import {
	type CloudPlayStatusContext,
	resolveCloudPlayStatus,
} from "@/services/cloudPlayStatus";
import type {
	CustomData,
	GameData,
	GameLaunchType,
	GameMetadataDraft,
	GameSourceRecord,
	GameStaffMember,
	InsertGameParams,
	Nullable,
	SourceType,
	UpdateGameParams,
} from "@/types";
import { isSourceType } from "@/types";
import type { PlayStatus } from "@/types/collection";
import { getGameNsfwStatus } from "@/utils/game";
import { normalizeSteamLaunchId } from "@/utils/steam";
import {
	buildGameCandidateFromSourceSelection,
	candidateSourcesToGameSources,
	createGameCandidate,
	createSourceCandidateRecord,
	mergeCandidateSources,
	type SourceCandidate,
	type SourceDisplayFields,
} from "../sourceCandidate";
import { getSourceRecordMap } from "../sourceRecord";
import { MIXED_SOURCE_KEYS, REGISTERED_SOURCE_KEYS } from "../sourceRegistry";
import { getSourceDisplayFields } from "./displaySource";
import { resolveDraftDisplayRules } from "./draftDisplayRules";
import { inferSummaryLanguage, shouldReplaceSummary } from "./summaryLanguage";

export interface GameInfoUpdateDraft {
	newLocalPath: string;
	newExecutable?: string;
	newLaunchType?: GameLaunchType;
	newSteamLaunchId?: string;
	newName: string;
	newNameCn?: string;
	newTranslatedName?: string;
	newImageExt?: string | null;
	newCoverSource?: SourceType | null;
	newAliases?: string[];
	newSummary?: string;
	newTags?: string[];
	newDeveloper?: string;
	newNsfw?: boolean;
	newDate?: string;
	newStaff?: GameStaffMember[];
	newUserRating?: number | null;
	newUserReview?: string;
}

const UNCHANGED = Symbol("unchanged game field");
type FieldChange<T> = T | null | typeof UNCHANGED;

function compareTextField(
	current: string,
	original: string | null | undefined,
): FieldChange<string> {
	const next = current.trim();
	if (next === (original ?? "").trim()) return UNCHANGED;
	return next.length === 0 ? null : next;
}

function compareListField<T>(
	current: T[],
	original: T[] | null | undefined,
): FieldChange<T[]> {
	const previous = original ?? [];
	if (
		current.length === previous.length &&
		current.every((value, index) => Object.is(value, previous[index]))
	) {
		return UNCHANGED;
	}
	return current.length === 0 ? null : current;
}

function compareBooleanField(
	current: boolean,
	original: boolean | null | undefined,
): FieldChange<boolean> {
	return current === (original ?? false) ? UNCHANGED : current;
}

function compareRatingField(
	current: number | null | undefined,
	original: number | null | undefined,
): FieldChange<number> {
	const normalize = (value: number | null | undefined) => {
		if (typeof value !== "number" || !Number.isFinite(value)) return null;
		const rounded = Math.round(value * 10) / 10;
		return rounded === 0 ? null : rounded;
	};
	const next = normalize(current);
	const previous = normalize(original);
	if (next === previous) {
		return next === null && original != null ? null : UNCHANGED;
	}
	return next;
}

export interface BatchImportGameCandidate {
	name: string;
	path?: string;
	selectedExe?: string;
	launch_type?: GameLaunchType;
	steam_launch_id?: string;
	matchedData?: GameMetadataDraft;
	playStatus?: PlayStatus;
	skipCloudStatusLookup?: boolean;
}

export interface GameRuntimeInsertOptions {
	localpath?: string;
	executable?: string;
	launch_type?: GameLaunchType;
	steam_launch_id?: string;
}

export type MixedSourceResult = Partial<
	Record<SourceType, SourceCandidate | null>
>;
export type MixedSourceListResult = Partial<
	Record<SourceType, SourceCandidate[]>
>;
export type MixedSourceCandidates = Record<SourceType, SourceCandidate[]>;
export type MixedSourceSelection = Partial<
	Record<SourceType, SourceCandidate | null>
>;
export type MixedSourceEnabled = Partial<Record<SourceType, boolean>>;

export function mergeMixedResult(
	result: MixedSourceResult,
): GameMetadataDraft | null {
	const selection = Object.fromEntries(
		MIXED_SOURCE_KEYS.map((source) => [source, result[source] ?? null]),
	) as MixedSourceSelection;
	if (!MIXED_SOURCE_KEYS.some((source) => selection[source])) {
		return null;
	}

	return buildGameCandidateFromSourceSelection({ selection });
}

export function pickFirstMixedResult(
	result: MixedSourceListResult,
): MixedSourceResult {
	return Object.fromEntries(
		MIXED_SOURCE_KEYS.map((source) => [source, result[source]?.[0] ?? null]),
	) as MixedSourceResult;
}

export function buildGameFromMixedSelection(params: {
	selection: MixedSourceSelection;
	enabled: MixedSourceEnabled;
}): GameMetadataDraft {
	const { selection, enabled } = params;
	const selectedEntries = MIXED_SOURCE_KEYS.map((source) => ({
		source,
		candidate: enabled[source] ? selection[source] : null,
	})).filter(
		(entry): entry is { source: SourceType; candidate: SourceCandidate } =>
			Boolean(entry.candidate),
	);

	if (selectedEntries.length === 0) {
		throw new Error("At least one mixed source must be selected");
	}

	return buildGameCandidateFromSourceSelection({
		selection: Object.fromEntries(
			MIXED_SOURCE_KEYS.map((source) => [
				source,
				enabled[source] ? selection[source] : null,
			]),
		) as MixedSourceSelection,
	});
}

function getDraftDisplayValues(gameData: GameMetadataDraft) {
	const displayFieldsBySource: Partial<
		Record<SourceType, SourceDisplayFields>
	> = {};
	for (const [source, record] of getSourceRecordMap(gameData)) {
		if (!record.data) continue;
		displayFieldsBySource[source] = getSourceDisplayFields(source, record.data);
	}

	const preferredSource =
		gameData.id_type && isSourceType(gameData.id_type)
			? gameData.id_type
			: undefined;
	return resolveDraftDisplayRules({
		displayFieldsBySource,
		preferredSource,
		registeredSourceOrder: REGISTERED_SOURCE_KEYS,
	});
}

export async function buildInsertGameData(
	gameData: GameMetadataDraft,
	options: GameRuntimeInsertOptions & {
		cloudStatusContext?: CloudPlayStatusContext;
	} = {},
): Promise<InsertGameParams> {
	const launchFields = buildGameLaunchInsertFields(options);
	const displayValues = getDraftDisplayValues(gameData);
	const {
		originalName,
		translatedName,
		chineseName,
		summary,
		summaryLanguage,
		summarySource,
	} = displayValues;

	const initialCustomData: CustomData = {
		...(gameData.custom_data ?? {}),
	};
	if (originalName && !initialCustomData.name) {
		initialCustomData.name = originalName;
	}
	if (translatedName && !initialCustomData.translated_name) {
		initialCustomData.translated_name = translatedName;
	}
	if (chineseName && !initialCustomData.name_cn) {
		initialCustomData.name_cn = chineseName;
	} else if (
		translatedName &&
		/[\u4e00-\u9fa5]/.test(translatedName) &&
		!initialCustomData.name_cn
	) {
		initialCustomData.name_cn = translatedName;
	}
	if (summary && !initialCustomData.summary) {
		initialCustomData.summary = summary;
		initialCustomData.summary_language = summaryLanguage ?? "unknown";
		initialCustomData.summary_source = summarySource;
		initialCustomData.summary_origin = "metadata";
	}

	const hasCustomData = Object.values(initialCustomData).some(
		(v) => v !== undefined && v !== null && v !== "",
	);

	const insertData: InsertGameParams = {
		id_type: gameData.id_type || "mixed",
		sources: candidateSourcesToGameSources(gameData.sources),
		date: displayValues.date,
		localpath: options.localpath,
		executable: options.executable,
		...launchFields,
		custom_data: hasCustomData ? initialCustomData : undefined,
	};
	const cloudStatus = await resolveCloudPlayStatus(
		insertData,
		options.cloudStatusContext,
	);

	if (cloudStatus === undefined) {
		return insertData;
	}

	return {
		...insertData,
		clear: cloudStatus,
	};
}

export function buildMetadataUpdatePayload(
	gameData: GameMetadataDraft,
	failedSources: readonly SourceType[] = [],
	existingSources: readonly GameSourceRecord[] = [],
	existingCustomData?: Nullable<CustomData>,
): UpdateGameParams {
	const existingCandidates = existingSources
		.filter((record): record is GameSourceRecord & { source: SourceType } =>
			isSourceType(record.source),
		)
		.map((record) =>
			createSourceCandidateRecord(
				record.source,
				record.external_id ?? "",
				record.data ?? {},
			),
		);
	const mergedCandidates = mergeCandidateSources([
		createGameCandidate({
			idType: "mixed",
			sources: existingCandidates,
		}),
		gameData,
	]);
	const records = candidateSourcesToGameSources(mergedCandidates);
	const presentSources = new Set(records.map((record) => record.source));
	const failedSourceSet = new Set(failedSources);
	const mergedIdType =
		presentSources.size > 1 ? "mixed" : (gameData.id_type ?? "mixed");
	const dateIdType: SourceType | undefined = isSourceType(mergedIdType)
		? mergedIdType
		: undefined;
	const mergedDisplayValues = getDraftDisplayValues({
		...gameData,
		id_type: dateIdType,
		sources: mergedCandidates,
	});
	const sourceDate = mergedDisplayValues.date;
	const updateData: UpdateGameParams = {
		id_type: mergedIdType,
	};
	if (sourceDate) {
		updateData.date = sourceDate;
	}

	if (existingCandidates.length > 0) {
		updateData.upsert_sources = records;
		updateData.remove_sources = [];
	} else if (gameData.id_type && isSourceType(gameData.id_type)) {
		updateData.upsert_sources = records.filter(
			(record) => record.source === gameData.id_type,
		);
		updateData.remove_sources = REGISTERED_SOURCE_KEYS.filter(
			(source) => source !== gameData.id_type && !failedSourceSet.has(source),
		);
	} else {
		updateData.upsert_sources = records;
		updateData.remove_sources = REGISTERED_SOURCE_KEYS.filter(
			(source) => !presentSources.has(source) && !failedSourceSet.has(source),
		);
	}

	const draftDisplayValues = getDraftDisplayValues(gameData);
	const newOriginalName = draftDisplayValues.originalName;
	const newTranslatedName = draftDisplayValues.translatedName;
	const newChineseName = draftDisplayValues.chineseName;
	const newSummary = mergedDisplayValues.summary;
	const newStaff = gameData.custom_data?.staff;

	if (
		newOriginalName ||
		newTranslatedName ||
		newChineseName ||
		newSummary ||
		newStaff !== undefined
	) {
		const nextCustom: CustomData = {
			...(existingCustomData ?? {}),
			...(updateData.custom_data ?? {}),
		};
		if (newOriginalName) {
			nextCustom.name = newOriginalName;
		}
		if (newTranslatedName) {
			nextCustom.translated_name = newTranslatedName;
		}
		if (newChineseName) {
			nextCustom.name_cn = newChineseName;
		} else if (newTranslatedName && /[\u4e00-\u9fa5]/.test(newTranslatedName)) {
			nextCustom.name_cn = newTranslatedName;
		}

		if (newSummary) {
			const existingDisplayValues = getDraftDisplayValues({
				id_type: dateIdType,
				sources: existingCandidates,
			});
			const existingSummary =
				existingCustomData?.summary ?? existingDisplayValues.summary;
			const existingSummaryLanguage =
				existingCustomData?.summary_language ??
				(existingCustomData?.summary
					? inferSummaryLanguage(existingCustomData.summary)
					: existingDisplayValues.summaryLanguage) ??
				inferSummaryLanguage(existingSummary);
			const legacyCustomSummaryDiffersFromSources = Boolean(
				existingCustomData?.summary?.trim() &&
					existingCustomData.summary.trim() !==
						existingDisplayValues.summary?.trim(),
			);
			const isManualSummary =
				existingCustomData?.summary_origin === "manual" ||
				(existingCustomData?.summary_origin == null &&
					legacyCustomSummaryDiffersFromSources);

			if (!isManualSummary) {
				const replaceExisting = shouldReplaceSummary(
					existingSummary,
					existingSummaryLanguage,
					newSummary,
					mergedDisplayValues.summaryLanguage,
				);

				if (replaceExisting) {
					nextCustom.summary = newSummary;
					nextCustom.summary_language =
						mergedDisplayValues.summaryLanguage ?? "unknown";
					nextCustom.summary_source = mergedDisplayValues.summarySource;
					nextCustom.summary_origin = "metadata";
				} else if (!existingCustomData?.summary && existingSummary) {
					// Snapshot the old winning summary before an update replaces its source record.
					nextCustom.summary = existingSummary;
					nextCustom.summary_language = existingSummaryLanguage;
					nextCustom.summary_source = existingDisplayValues.summarySource;
					nextCustom.summary_origin = "metadata";
				}
			}
		}

		if (newStaff !== undefined) {
			nextCustom.staff = newStaff;
			nextCustom.staff_overridden = false;
		}

		updateData.custom_data = nextCustom;
	}

	return updateData;
}

export function buildGameInfoUpdatePayload(
	originalGame: GameData,
	draft: GameInfoUpdateDraft,
): UpdateGameParams {
	const payload: UpdateGameParams = {};
	const localPathChange = compareTextField(
		draft.newLocalPath,
		originalGame.localpath,
	);
	if (localPathChange !== UNCHANGED) {
		payload.localpath = localPathChange;
	}
	if (draft.newExecutable !== undefined) {
		const executableChange = compareTextField(
			draft.newExecutable,
			originalGame.executable,
		);
		if (executableChange !== UNCHANGED) {
			payload.executable = executableChange;
		}
	}
	if (
		draft.newLaunchType !== undefined &&
		draft.newLaunchType !== (originalGame.launch_type ?? "local")
	) {
		payload.launch_type = draft.newLaunchType;
	}
	if (draft.newSteamLaunchId !== undefined) {
		const steamLaunchIdChange = compareTextField(
			draft.newSteamLaunchId,
			originalGame.steam_launch_id,
		);
		if (steamLaunchIdChange !== UNCHANGED) {
			payload.steam_launch_id = steamLaunchIdChange;
		}
	}

	const currentCustomData = originalGame.custom_data || {};
	const currentCustomName = currentCustomData.name || originalGame.name || "";
	const originalSummary = originalGame.summary ?? "";
	const originalDeveloper = originalGame.developer ?? "";
	const originalNsfw = getGameNsfwStatus(originalGame) ?? false;
	const originalDate = originalGame.date ?? "";
	let nextCustomData: CustomData | undefined;
	const customData = () => (nextCustomData ??= { ...currentCustomData });

	const nameChange = compareTextField(draft.newName, currentCustomName);
	if (nameChange !== UNCHANGED) {
		customData().name = nameChange;
	}
	if (draft.newNameCn !== undefined) {
		const nameCnChange = compareTextField(
			draft.newNameCn,
			originalGame.name_cn,
		);
		if (nameCnChange !== UNCHANGED) {
			customData().name_cn = nameCnChange;
		}
	}
	if (draft.newTranslatedName !== undefined) {
		const translatedNameChange = compareTextField(
			draft.newTranslatedName,
			currentCustomData.translated_name,
		);
		if (translatedNameChange !== UNCHANGED) {
			customData().translated_name = translatedNameChange;
		}
	}

	if (draft.newImageExt !== undefined) {
		customData().image = draft.newImageExt;
	}

	if (draft.newCoverSource !== undefined) {
		if (draft.newCoverSource !== (currentCustomData.cover_source ?? null)) {
			customData().cover_source = draft.newCoverSource;
		}
	}

	if (draft.newAliases !== undefined) {
		const aliasesChange = compareListField(
			draft.newAliases,
			currentCustomData.aliases,
		);
		if (aliasesChange !== UNCHANGED) {
			customData().aliases = aliasesChange;
		}
	}

	if (draft.newSummary !== undefined) {
		const summaryChange = compareTextField(draft.newSummary, originalSummary);
		if (summaryChange !== UNCHANGED) {
			customData().summary = summaryChange;
			customData().summary_language =
				typeof summaryChange === "string"
					? inferSummaryLanguage(summaryChange)
					: null;
			customData().summary_source = null;
			customData().summary_origin = "manual";
		}
	}

	if (draft.newTags !== undefined) {
		const tagsChange = compareListField(draft.newTags, currentCustomData.tags);
		if (tagsChange !== UNCHANGED) {
			customData().tags = tagsChange;
		}
	}

	if (draft.newDeveloper !== undefined) {
		const developerChange = compareTextField(
			draft.newDeveloper,
			originalDeveloper,
		);
		if (developerChange !== UNCHANGED) {
			customData().developer = developerChange;
		}
	}

	if (draft.newNsfw !== undefined) {
		const nsfwChange = compareBooleanField(draft.newNsfw, originalNsfw);
		if (nsfwChange !== UNCHANGED) {
			customData().nsfw = nsfwChange;
		}
	}

	if (draft.newDate !== undefined) {
		const dateChange = compareTextField(draft.newDate, originalDate);
		if (dateChange !== UNCHANGED) {
			payload.date = dateChange;
		}
	}

	if (draft.newStaff !== undefined) {
		const hasCustomStaff = Object.hasOwn(currentCustomData, "staff");
		const currentStaff = currentCustomData.staff ?? [];
		if (
			!hasCustomStaff ||
			JSON.stringify(draft.newStaff) !== JSON.stringify(currentStaff)
		) {
			customData().staff = draft.newStaff;
		}
		customData().staff_overridden = true;
	}

	if (draft.newUserRating !== undefined) {
		const userRatingChange = compareRatingField(
			draft.newUserRating,
			currentCustomData.user_rating,
		);
		if (userRatingChange !== UNCHANGED) {
			customData().user_rating = userRatingChange;
		}
	}

	if (draft.newUserReview !== undefined) {
		const userReviewChange = compareTextField(
			draft.newUserReview,
			currentCustomData.user_review,
		);
		if (userReviewChange !== UNCHANGED) {
			customData().user_review = userReviewChange;
		}
	}

	if (nextCustomData) {
		payload.custom_data = nextCustomData;
	}

	return payload;
}

export async function buildBulkImportGameData(
	item: BatchImportGameCandidate,
	cloudStatusContext?: CloudPlayStatusContext,
): Promise<InsertGameParams> {
	const itemCloudStatusContext =
		item.playStatus !== undefined || item.skipCloudStatusLookup
			? {}
			: cloudStatusContext;
	const withImportedStatus = (data: InsertGameParams): InsertGameParams =>
		item.playStatus === undefined ? data : { ...data, clear: item.playStatus };

	if (item.matchedData) {
		const data = await buildInsertGameData(item.matchedData, {
			localpath: item.path,
			executable: item.selectedExe,
			launch_type: item.launch_type,
			steam_launch_id: item.steam_launch_id,
			cloudStatusContext: itemCloudStatusContext,
		});
		return withImportedStatus(data);
	}
	const launchFields = buildGameLaunchInsertFields(item);

	return withImportedStatus({
		id_type: "custom",
		sources: [],
		custom_data: {
			name: item.name,
		},
		localpath: item.path,
		executable: item.selectedExe,
		...launchFields,
	});
}

export function buildGameLaunchInsertFields(
	options: Pick<GameRuntimeInsertOptions, "launch_type" | "steam_launch_id">,
): Pick<InsertGameParams, "launch_type" | "steam_launch_id"> {
	const rawSteamLaunchId = options.steam_launch_id?.trim();
	const steamLaunchId = rawSteamLaunchId
		? normalizeSteamLaunchId(rawSteamLaunchId)
		: undefined;
	if (rawSteamLaunchId && !steamLaunchId) {
		throw new Error(`Invalid Steam launch id: ${options.steam_launch_id}`);
	}

	const launchType =
		options.launch_type ?? (steamLaunchId ? "steam" : undefined);
	if (launchType === "steam" && !steamLaunchId) {
		throw new Error("Steam launch type requires a Steam launch id");
	}
	if (launchType === "local" && steamLaunchId) {
		throw new Error("Local launch type cannot contain a Steam launch id");
	}

	return {
		launch_type: launchType,
		steam_launch_id: steamLaunchId,
	};
}
