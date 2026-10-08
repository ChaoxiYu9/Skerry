import type { CustomData, GameData, SourceType } from "@/types";
import type { SourceDisplayFields } from "../sourceCandidate";
import type { SourceDataMap } from "../sourceRecord";
import {
	getRuntimeSourceAdapter,
	REGISTERED_SOURCE_KEYS,
} from "../sourceRegistry";

export const SOURCE_COVER_PRIORITY: readonly SourceType[] = [
	"hikarinagi",
	"bgm",
	"vndb",
	"erogamescape",
	"dlsite",
	"kun",
	"ymgal",
];

const BASIC_FIELD_PRIORITY: readonly SourceType[] = [
	"kun",
	"bgm",
	"vndb",
	"hikarinagi",
	"dlsite",
	"erogamescape",
	"ymgal",
];
const DEVELOPER_PRIORITY: readonly SourceType[] = [
	"vndb",
	"erogamescape",
	"kun",
	"dlsite",
	"ymgal",
	"hikarinagi",
	"bgm",
];
const MIXED_TAG_SOURCES: readonly SourceType[] = [
	"bgm",
	"hikarinagi",
	"dlsite",
	"erogamescape",
	"vndb",
	"kun",
];
const MIXED_ALIAS_SOURCES: readonly SourceType[] = [
	"bgm",
	"vndb",
	"hikarinagi",
	"kun",
	"ymgal",
];
const MIXED_TITLE_SOURCES: readonly SourceType[] = ["vndb", "kun"];

type SourceDisplayMap = Partial<Record<SourceType, SourceDisplayFields>>;

const nullToUndefined = <T>(value: T | null | undefined): T | undefined =>
	value ?? undefined;

function assignBasicFields(
	target: GameData,
	fields: SourceDisplayFields,
): void {
	if (fields.name != null) target.name = fields.name;
	if (fields.name_cn != null) target.name_cn = fields.name_cn;
	if (fields.summary != null) target.summary = fields.summary;
	if (fields.developer != null) target.developer = fields.developer;
	if (fields.nsfw != null) target.nsfw = fields.nsfw;
}

export function getSourceDisplayFields(
	source: SourceType,
	data: unknown,
): SourceDisplayFields {
	return getRuntimeSourceAdapter(source).toDisplayFields(data);
}

export function applySingleSourceDisplay(
	target: GameData,
	source: SourceType,
	data: unknown,
): void {
	const fields = getSourceDisplayFields(source, data);
	assignBasicFields(target, fields);

	target.image = fields.image;
	target.tags = fields.tags ?? target.tags;
	target.screenshots = fields.screenshots;
	target.rank = fields.rank;
	target.score = fields.score;
	target.all_titles = fields.all_titles;
	target.aliases = fields.aliases ?? target.aliases;
	target.average_hours = fields.average_hours;
}

export function applyCustomSourceDisplay(
	target: GameData,
	customData: CustomData,
): void {
	assignBasicFields(target, {
		name: nullToUndefined(customData.name),
		name_cn: nullToUndefined(customData.name_cn),
		summary: nullToUndefined(customData.summary),
		developer: nullToUndefined(customData.developer),
		nsfw: nullToUndefined(customData.nsfw),
	});
	target.aliases = nullToUndefined(customData.aliases) ?? [];
	target.tags = nullToUndefined(customData.tags) ?? [];
}

function buildDisplayMap(sources: SourceDataMap): SourceDisplayMap {
	return Object.fromEntries(
		REGISTERED_SOURCE_KEYS.map((source) => {
			const data = sources[source];
			return data ? [source, getSourceDisplayFields(source, data)] : null;
		}).filter((entry): entry is [SourceType, SourceDisplayFields] =>
			Boolean(entry),
		),
	);
}

const hasChinese = (text?: string): boolean =>
	Boolean(text && /[\u4e00-\u9fa5]/.test(text));

const NON_VNDB_SUMMARY_SOURCES: readonly SourceType[] = [
	"kun",
	"hikarinagi",
	"bgm",
	"ymgal",
	"dlsite",
	"erogamescape",
];

function resolveMixedSummary(displays: SourceDisplayMap): string | undefined {
	// 1. 中文简介最高优先级：非 VNDB 来源中，按源优先级取含有中文的简介（kun 权重最高）
	for (const source of NON_VNDB_SUMMARY_SOURCES) {
		const summary = displays[source]?.summary;
		if (summary && hasChinese(summary)) {
			return summary;
		}
	}

	// 2. 退而求其次：若无中文简介，取非 VNDB 来源的其他语言简介（如日文等）
	for (const source of NON_VNDB_SUMMARY_SOURCES) {
		const summary = displays[source]?.summary;
		if (summary && summary.trim().length > 0) {
			return summary;
		}
	}

	// 3. VNDB 英文简介绝对垫底：仅当全无其他源简介时兜底
	return displays.vndb?.summary;
}

const NON_VNDB_TAG_SOURCES: readonly SourceType[] = [
	"kun",
	"bgm",
	"hikarinagi",
	"dlsite",
	"erogamescape",
	"ymgal",
];

function resolveMixedTags(displays: SourceDisplayMap): string[] {
	const nonVndbTags: string[] = [];
	const seen = new Set<string>();

	// 按优先级遍历非 VNDB 来源（Kun 最优先，依次并入其他非 VNDB 来源）
	for (const source of NON_VNDB_TAG_SOURCES) {
		const tags = displays[source]?.tags;
		if (tags && Array.isArray(tags)) {
			for (const tag of tags) {
				const trimmed = tag.trim();
				if (trimmed && !seen.has(trimmed)) {
					seen.add(trimmed);
					nonVndbTags.push(trimmed);
				}
			}
		}
	}

	// 如果非 VNDB 源提取到了任何标签：
	// 排序保证中文标签在前，非中文（日文/其他）在后，且彻底屏蔽 VNDB 的全英文标签
	if (nonVndbTags.length > 0) {
		const chineseTags = nonVndbTags.filter((tag) => hasChinese(tag));
		const otherTags = nonVndbTags.filter((tag) => !hasChinese(tag));
		return [...chineseTags, ...otherTags];
	}

	// 仅当所有其他源完全没有任何标签时，才退守使用 VNDB 英文标签兜底
	return displays.vndb?.tags ?? [];
}

function firstField<Key extends keyof SourceDisplayFields>(
	displays: SourceDisplayMap,
	sources: readonly SourceType[],
	key: Key,
): SourceDisplayFields[Key] | undefined {
	for (const source of sources) {
		const value = displays[source]?.[key];
		if (value != null) return value;
	}
	return undefined;
}

function mergeArrays(
	displays: SourceDisplayMap,
	sources: readonly SourceType[],
	key: "tags" | "aliases" | "all_titles" | "screenshots",
): string[] {
	return Array.from(
		new Set(sources.flatMap((source) => displays[source]?.[key] ?? [])),
	);
}

function resolveDisplayImage(
	displays: SourceDisplayMap,
	coverSource?: SourceType | null,
): string | undefined {
	if (coverSource) {
		const selectedImage = displays[coverSource]?.image;
		if (selectedImage) return selectedImage;
	}

	return firstField(displays, SOURCE_COVER_PRIORITY, "image");
}

export function applyMixedSourceDisplay(
	target: GameData,
	sources: SourceDataMap,
	coverSource?: SourceType | null,
): void {
	const displays = buildDisplayMap(sources);
	const primarySource = BASIC_FIELD_PRIORITY.find((source) => displays[source]);
	if (primarySource) {
		assignBasicFields(target, displays[primarySource] as SourceDisplayFields);
	}

	// 智能甄选真实原名：若当前选中的原名无假名，而其他源有假名，优先使用地道原名
	for (const source of BASIC_FIELD_PRIORITY) {
		const cand = displays[source]?.name;
		if (cand && /[\u3040-\u30ff]/.test(cand)) {
			target.name = cand;
			break;
		}
	}

	// 保证中文译名存在时绝不遗漏
	if (!target.name_cn) {
		for (const source of BASIC_FIELD_PRIORITY) {
			const cand = displays[source]?.name_cn;
			if (cand && /[\u4e00-\u9fa5]/.test(cand)) {
			target.name_cn = cand;
			break;
			}
		}
	}

	target.image = resolveDisplayImage(displays, coverSource);
	target.summary = resolveMixedSummary(displays);
	target.developer = firstField(displays, DEVELOPER_PRIORITY, "developer");
	target.tags = resolveMixedTags(displays);
	target.screenshots = mergeArrays(displays, MIXED_TAG_SOURCES, "screenshots");
	target.aliases = mergeArrays(displays, MIXED_ALIAS_SOURCES, "aliases");
	target.score =
		displays.bgm?.score ??
		displays.erogamescape?.score ??
		displays.vndb?.score ??
		displays.hikarinagi?.score;
	target.rank = displays.bgm?.rank;
	target.all_titles = mergeArrays(displays, MIXED_TITLE_SOURCES, "all_titles");
	target.average_hours = displays.vndb?.average_hours;
}

export function applyCustomDataOverride(
	target: GameData,
	customData: CustomData,
): void {
	if (customData.name != null) {
		target.name = customData.name;
	}
	if (customData.name_cn != null) {
		target.name_cn = customData.name_cn;
	}
	if (customData.summary) {
		target.summary = customData.summary;
	}
	if (customData.developer) {
		target.developer = customData.developer;
	}
	if (customData.nsfw != null) {
		target.nsfw = customData.nsfw;
	}

	if (customData.aliases) {
		target.aliases = Array.from(
			new Set([...(target.aliases || []), ...customData.aliases]),
		);
	}
	if (customData.tags_curated) {
		target.tags = customData.tags ?? [];
	} else if (customData.tags) {
		target.tags = Array.from(
			new Set([...(target.tags || []), ...customData.tags]),
		);
	}
}
