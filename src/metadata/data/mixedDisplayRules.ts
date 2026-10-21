import type { GameData, SourceType } from "@/types";
import type { SourceDisplayFields } from "../sourceCandidate";
import type { SourceDataMap } from "../sourceRecord";
import { REGISTERED_SOURCE_KEYS } from "../sourceRegistry";
import { assignBasicFields, getSourceDisplayFields } from "./displaySource";
import {
	chooseCoverImage,
	chooseMixedSummary,
	firstDisplayField,
	mergeDisplayArrays,
	mergeMixedTags,
} from "./mixedDisplayDecisions";
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

function buildDisplayMap(sources: SourceDataMap): SourceDisplayMap {
	const displays: SourceDisplayMap = {};
	for (const source of REGISTERED_SOURCE_KEYS) {
		const data = sources[source];
		if (data) displays[source] = getSourceDisplayFields(source, data);
	}
	return displays;
}

const NON_VNDB_SUMMARY_SOURCES: readonly SourceType[] = [
	"kun",
	"hikarinagi",
	"bgm",
	"ymgal",
	"dlsite",
	"erogamescape",
];

const NON_VNDB_TAG_SOURCES: readonly SourceType[] = [
	"kun",
	"bgm",
	"hikarinagi",
	"dlsite",
	"erogamescape",
	"ymgal",
];

export function applyMixedSourceDisplay(
	target: GameData,
	sources: SourceDataMap,
	coverSource?: SourceType | null,
): void {
	const displays = buildDisplayMap(sources);
	const primarySource = BASIC_FIELD_PRIORITY.find((source) => displays[source]);
	const primaryFields = primarySource ? displays[primarySource] : undefined;
	if (primaryFields) assignBasicFields(target, primaryFields);

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

	target.image = chooseCoverImage(displays, coverSource, SOURCE_COVER_PRIORITY);
	target.summary = chooseMixedSummary(
		displays,
		NON_VNDB_SUMMARY_SOURCES,
		"vndb",
	);
	target.developer = firstDisplayField(
		displays,
		DEVELOPER_PRIORITY,
		"developer",
	);
	target.tags = mergeMixedTags(displays, NON_VNDB_TAG_SOURCES, "vndb");
	target.screenshots = mergeDisplayArrays(
		displays,
		MIXED_TAG_SOURCES,
		"screenshots",
	);
	target.aliases = mergeDisplayArrays(displays, MIXED_ALIAS_SOURCES, "aliases");
	target.score =
		displays.bgm?.score ??
		displays.erogamescape?.score ??
		displays.vndb?.score ??
		displays.hikarinagi?.score;
	target.rank = displays.bgm?.rank;
	target.all_titles = mergeDisplayArrays(
		displays,
		MIXED_TITLE_SOURCES,
		"all_titles",
	);
	target.average_hours = displays.vndb?.average_hours;
}
