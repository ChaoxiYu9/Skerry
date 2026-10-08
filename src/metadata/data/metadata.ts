import i18n from "@/providers/i18n";
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
import {
	getArrayDiff,
	getBoolDiff,
	getDiff,
	getNumberDiff,
} from "@/utils/diff";
import { getGameNsfwStatus } from "@/utils/game";
import { normalizeSteamLaunchId } from "@/utils/steam";
import type { SourceIdMap } from "../sourceAdapter";
import {
	buildGameCandidateFromSourceSelection,
	candidateSourcesToGameSources,
	createGameCandidate,
	mergeCandidateSources,
	createSourceCandidateRecord,
	type SourceCandidate,
} from "../sourceCandidate";
import {
	getAnySourceIdMap,
	getSourceData,
	type SourceIdentityPayload,
} from "../sourceRecord";
import {
	getSourceAdapter,
	MIXED_SOURCE_KEYS,
	REGISTERED_SOURCE_KEYS,
} from "../sourceRegistry";
import type { GameMetadataSession } from "./gameMetadataService";

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

export interface BatchImportGameCandidate {
	name: string;
	path?: string;
	selectedExe?: string;
	launch_type?: GameLaunchType;
	steam_launch_id?: string;
	matchedData?: GameMetadataDraft;
}

export interface GameRuntimeInsertOptions {
	localpath?: string;
	executable?: string;
	launch_type?: GameLaunchType;
	steam_launch_id?: string;
}

export type GameIdentityPayload = SourceIdentityPayload & {
	steam_launch_id?: string | null;
};

interface SourceUpdateParams {
	selectedGame: GameData | null;
	idType: string;
	sourceIds?: SourceIdMap;
	enabledSources?: readonly SourceType[];
	session: GameMetadataSession;
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

export interface MetadataFetchResult {
	data: GameMetadataDraft;
	failedSources: SourceType[];
}

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

// ---------------------- 核心业务逻辑区 ----------------------

export async function fetchMetadataForUpdate({
	selectedGame,
	idType,
	sourceIds,
	enabledSources,
	session,
}: SourceUpdateParams): Promise<MetadataFetchResult> {
	if (!selectedGame) {
		throw new Error(
			i18n.t("pages.Detail.DataSourceUpdate.noGameSelected", "未选择游戏"),
		);
	}

	if (idType === "custom") {
		throw new Error(
			i18n.t(
				"pages.Detail.DataSourceUpdate.customModeWarning",
				"自定义模式无法从数据源更新。",
			),
		);
	}

	if (idType === "mixed") {
		return session.getGameByIds({
			sourceIds,
			enabledSources,
		});
	}

	let apiData: GameMetadataDraft;
	if (isSourceType(idType)) {
		const sourceId = sourceIds?.[idType];
		if (!sourceId) {
			throw new Error(
				i18n.t("pages.Detail.DataSourceUpdate.invalidIdType", "无效的ID类型"),
			);
		}

		apiData = await session.getGameById(sourceId, idType);
	} else {
		throw new Error(
			i18n.t("pages.Detail.DataSourceUpdate.invalidIdType", "无效的ID类型"),
		);
	}

	if (!apiData) {
		throw new Error(
			i18n.t(
				"pages.Detail.DataSourceUpdate.noDataFetched",
				"未获取到数据或数据源无效。",
			),
		);
	}

	return {
		data: apiData,
		failedSources: [],
	};
}

function getGameCandidateDate(gameData: GameMetadataDraft): string | undefined {
	const dateSources =
		gameData.id_type && isSourceType(gameData.id_type)
			? [gameData.id_type]
			: REGISTERED_SOURCE_KEYS;
	return dateSources
		.map((source) => {
			const adapter = getSourceAdapter(source);
			const data = getSourceData(gameData, source);
			return data ? adapter.toDisplayFields(data).date?.trim() : undefined;
		})
		.find(Boolean);
}

export function extractDraftOriginalName(
	gameData: GameMetadataDraft,
): string | undefined {
	const namePriority: readonly SourceType[] = [
		"kun",
		"bgm",
		"vndb",
		"hikarinagi",
		"dlsite",
		"erogamescape",
		"ymgal",
	];
	const sourcesToTry =
		gameData.id_type && isSourceType(gameData.id_type)
			? [gameData.id_type, ...namePriority.filter((s) => s !== gameData.id_type)]
			: namePriority;

	// 收集所有候选源中的已知中文译名（用于判断原名是否被中文译名污染）
	const knownChineseNames = new Set<string>();
	for (const source of sourcesToTry) {
		const adapter = getSourceAdapter(source);
		const data = getSourceData(gameData, source);
		if (data) {
			const fields = adapter.toDisplayFields(data);
			if (fields.name_cn?.trim()) knownChineseNames.add(fields.name_cn.trim());
			if (fields.translated_name?.trim() && /[\u4e00-\u9fa5]/.test(fields.translated_name)) {
				knownChineseNames.add(fields.translated_name.trim());
			}
		}
	}

	const candidates: { name: string; score: number; sourceIndex: number }[] = [];
	sourcesToTry.forEach((source, sourceIndex) => {
		const adapter = getSourceAdapter(source);
		const data = getSourceData(gameData, source);
		if (!data) return;
		const name = adapter.toDisplayFields(data).name?.trim();
		if (!name) return;

		let score = 20;
		// 1. 包含日文平假名/片假名：确定为日文原名，最高权重
		if (/[\u3040-\u30ff]/.test(name)) {
			score = 100;
		} else if (knownChineseNames.has(name) && /^[\u4e00-\u9fa5\s\d\p{P}]+$/u.test(name)) {
			// 2. 与中文译名完全相同且纯中文：严重扣分，防止中文译名顶掉原名
			score = -50;
		} else if (/[a-zA-Z]/.test(name)) {
			// 3. 包含英文/西文字符（欧美原生游戏原名，如 DDLC，或外语原名）
			score = 70;
		} else if (/^[\u4e00-\u9fa5]/.test(name)) {
			// 4. 纯汉字原名（国创作品或全汉字日文）
			score = 15;
		}

		candidates.push({ name, score, sourceIndex });
	});

	if (candidates.length === 0) return undefined;
	candidates.sort((a, b) => b.score - a.score || a.sourceIndex - b.sourceIndex);
	return candidates[0].name;
}

export function extractDraftTranslatedName(
	gameData: GameMetadataDraft,
): string | undefined {
	const namePriority: readonly SourceType[] = [
		"kun",
		"bgm",
		"ymgal",
		"hikarinagi",
		"vndb",
		"dlsite",
		"erogamescape",
	];
	const sourcesToTry =
		gameData.id_type && isSourceType(gameData.id_type)
			? [gameData.id_type, ...namePriority.filter((s) => s !== gameData.id_type)]
			: namePriority;

	// 1. 优先提取包含中文字符的译名
	for (const source of sourcesToTry) {
		const adapter = getSourceAdapter(source);
		const data = getSourceData(gameData, source);
		if (!data) continue;
		const fields = adapter.toDisplayFields(data);
		const val = fields.translated_name?.trim() || fields.name_cn?.trim();
		if (val && /[\u4e00-\u9fa5]/.test(val)) {
			return val;
		}
	}

	// 2. 其次提取非空的其他译名（如日文游戏的英文本地化名称）
	for (const source of sourcesToTry) {
		const adapter = getSourceAdapter(source);
		const data = getSourceData(gameData, source);
		if (!data) continue;
		const fields = adapter.toDisplayFields(data);
		const val = fields.translated_name?.trim() || fields.name_cn?.trim();
		if (val) {
			return val;
		}
	}

	return undefined;
}

export function extractDraftChineseName(
	gameData: GameMetadataDraft,
): string | undefined {
	const namePriority: readonly SourceType[] = [
		"kun",
		"bgm",
		"ymgal",
		"hikarinagi",
		"vndb",
		"dlsite",
		"erogamescape",
	];
	const sourcesToTry =
		gameData.id_type && isSourceType(gameData.id_type)
			? [gameData.id_type, ...namePriority.filter((s) => s !== gameData.id_type)]
			: namePriority;

	for (const source of sourcesToTry) {
		const adapter = getSourceAdapter(source);
		const data = getSourceData(gameData, source);
		if (!data) continue;
		const fields = adapter.toDisplayFields(data);
		const val = fields.name_cn?.trim() || fields.translated_name?.trim();
		if (val && /[\u4e00-\u9fa5]/.test(val)) {
			return val;
		}
	}

	return undefined;
}

export function extractDraftSummary(
	gameData: GameMetadataDraft,
): string | undefined {
	const summaryPriority: readonly SourceType[] = [
		"kun",
		"bgm",
		"ymgal",
		"hikarinagi",
		"dlsite",
		"erogamescape",
	];
	const sourcesToTry =
		gameData.id_type && isSourceType(gameData.id_type)
			? [gameData.id_type, ...summaryPriority.filter((s) => s !== gameData.id_type)]
			: summaryPriority;

	// 1. 中文最高优先级：各源中优先提取包含中文字符的简介（kun 权重最高）
	for (const source of sourcesToTry) {
		const adapter = getSourceAdapter(source);
		const data = getSourceData(gameData, source);
		if (!data) continue;
		const fields = adapter.toDisplayFields(data);
		const val = fields.summary?.trim();
		if (val && /[\u4e00-\u9fa5]/.test(val)) {
			return val;
		}
	}

	// 2. 其次：若无中文简介，提取非 VNDB 来源的有效非空简介（如日文等）
	for (const source of sourcesToTry) {
		const adapter = getSourceAdapter(source);
		const data = getSourceData(gameData, source);
		if (!data) continue;
		const fields = adapter.toDisplayFields(data);
		const val = fields.summary?.trim();
		if (val) {
			return val;
		}
	}

	// 3. VNDB 英文简介垫底：仅在完全没有其他源简介时兜底使用
	const vndbData = getSourceData(gameData, "vndb");
	if (vndbData) {
		const vndbFields = getSourceAdapter("vndb").toDisplayFields(vndbData);
		const vndbSummary = vndbFields.summary?.trim();
		if (vndbSummary) {
			return vndbSummary;
		}
	}

	return undefined;
}

export async function buildInsertGameData(
	gameData: GameMetadataDraft,
	options: GameRuntimeInsertOptions & {
		cloudStatusContext?: CloudPlayStatusContext;
	} = {},
): Promise<InsertGameParams> {
	const launchFields = buildGameLaunchInsertFields(options);

	const originalName = extractDraftOriginalName(gameData);
	const translatedName = extractDraftTranslatedName(gameData);
	const chineseName = extractDraftChineseName(gameData);
	const summary = extractDraftSummary(gameData);

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
	}

	const hasCustomData = Object.values(initialCustomData).some(
		(v) => v !== undefined && v !== null && v !== "",
	);

	const insertData: InsertGameParams = {
		id_type: gameData.id_type || "mixed",
		sources: candidateSourcesToGameSources(gameData.sources),
		date: getGameCandidateDate(gameData),
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
		.filter(
			(record): record is GameSourceRecord & { source: SourceType } =>
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
	const sourceDate = getGameCandidateDate({
		...gameData,
		id_type: dateIdType,
		sources: mergedCandidates,
	});
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

	const newOriginalName = extractDraftOriginalName(gameData);
	const newTranslatedName = extractDraftTranslatedName(gameData);
	const newChineseName = extractDraftChineseName(gameData);
	const newSummary = extractDraftSummary(gameData);
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
			const existingSummary = existingCustomData?.summary?.trim();
			const existingHasChinese = Boolean(
				existingSummary && /[\u4e00-\u9fa5]/.test(existingSummary),
			);
			const newHasChinese = /[\u4e00-\u9fa5]/.test(newSummary);

			// 中文优先覆盖旧英文：新简介含中文直接覆盖；若旧简介非中文（英文/空）也用新简介覆盖
			if (newHasChinese || !existingHasChinese) {
				nextCustom.summary = newSummary;
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
	const localPathDiff = getDiff(draft.newLocalPath, originalGame.localpath);
	if (localPathDiff !== undefined) {
		payload.localpath = localPathDiff;
	}
	if (draft.newExecutable !== undefined) {
		const executableDiff = getDiff(
			draft.newExecutable,
			originalGame.executable,
		);
		if (executableDiff !== undefined) {
			payload.executable = executableDiff;
		}
	}
	if (
		draft.newLaunchType !== undefined &&
		draft.newLaunchType !== (originalGame.launch_type ?? "local")
	) {
		payload.launch_type = draft.newLaunchType;
	}
	if (draft.newSteamLaunchId !== undefined) {
		const steamLaunchIdDiff = getDiff(
			draft.newSteamLaunchId,
			originalGame.steam_launch_id,
		);
		if (steamLaunchIdDiff !== undefined) {
			payload.steam_launch_id = steamLaunchIdDiff;
		}
	}

	const currentCustomData = originalGame.custom_data || {};
	const currentCustomName = currentCustomData.name || originalGame.name || '';
	const originalSummary = originalGame.summary ?? "";
	const originalDeveloper = originalGame.developer ?? "";
	const originalNsfw = getGameNsfwStatus(originalGame) ?? false;
	const originalDate = originalGame.date ?? "";
	let nextCustomData: CustomData | undefined;
	const customData = () => (nextCustomData ??= { ...currentCustomData });

	const nameDiff = getDiff(draft.newName, currentCustomName);
	if (nameDiff !== undefined) {
		customData().name = nameDiff;
	}
	if (draft.newNameCn !== undefined) {
		const nameCnDiff = getDiff(draft.newNameCn, originalGame.name_cn ?? "");
		if (nameCnDiff !== undefined) {
			customData().name_cn = nameCnDiff;
		}
	}
	if (draft.newTranslatedName !== undefined) {
		const translatedNameDiff = getDiff(
			draft.newTranslatedName,
			currentCustomData.translated_name ?? "",
		);
		if (translatedNameDiff !== undefined) {
			customData().translated_name = translatedNameDiff;
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
		const aliasesDiff = getArrayDiff(
			draft.newAliases,
			currentCustomData.aliases,
		);
		if (aliasesDiff !== undefined) {
			customData().aliases = aliasesDiff;
		}
	}

	if (draft.newSummary !== undefined) {
		const summaryDiff = getDiff(draft.newSummary, originalSummary);
		if (summaryDiff !== undefined) {
			customData().summary = summaryDiff;
		}
	}

	if (draft.newTags !== undefined) {
		const tagsDiff = getArrayDiff(draft.newTags, currentCustomData.tags);
		if (tagsDiff !== undefined) {
			customData().tags = tagsDiff;
		}
	}

	if (draft.newDeveloper !== undefined) {
		const developerDiff = getDiff(draft.newDeveloper, originalDeveloper);
		if (developerDiff !== undefined) {
			customData().developer = developerDiff;
		}
	}

	if (draft.newNsfw !== undefined) {
		const nsfwDiff = getBoolDiff(draft.newNsfw, originalNsfw);
		if (nsfwDiff !== undefined) {
			customData().nsfw = nsfwDiff;
		}
	}

	if (draft.newDate !== undefined) {
		const dateDiff = getDiff(draft.newDate, originalDate);
		if (dateDiff !== undefined) {
			payload.date = dateDiff;
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
		const userRatingDiff = getNumberDiff(
			draft.newUserRating,
			currentCustomData.user_rating,
			{ clearValue: 0, precision: 1 },
		);
		if (userRatingDiff !== undefined) {
			customData().user_rating = userRatingDiff;
		}
	}

	if (draft.newUserReview !== undefined) {
		const userReviewDiff = getDiff(
			draft.newUserReview,
			currentCustomData.user_review ?? undefined,
		);
		if (userReviewDiff !== undefined) {
			customData().user_review = userReviewDiff;
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
	if (item.matchedData) {
		return buildInsertGameData(item.matchedData, {
			localpath: item.path,
			executable: item.selectedExe,
			launch_type: item.launch_type,
			steam_launch_id: item.steam_launch_id,
			cloudStatusContext,
		});
	}
	const launchFields = buildGameLaunchInsertFields(item);

	return {
		id_type: "custom",
		sources: [],
		custom_data: {
			name: item.name,
		},
		localpath: item.path,
		executable: item.selectedExe,
		...launchFields,
	};
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

export function getGameIdentityKeys(payload: GameIdentityPayload): string[] {
	const sourceIds = getAnySourceIdMap(payload);
	const keys = REGISTERED_SOURCE_KEYS.map((source) => {
		const sourceId = sourceIds[source];
		return sourceId ? `${source}:${sourceId}` : null;
	}).filter((value): value is string => Boolean(value));
	const steamLaunchId = payload.steam_launch_id
		? normalizeSteamLaunchId(payload.steam_launch_id)
		: undefined;
	if (steamLaunchId) {
		keys.push(`steam-launch:${steamLaunchId}`);
	}

	return keys;
}
