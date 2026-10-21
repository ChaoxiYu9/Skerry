import type { SourceType, SummaryLanguage } from "@/types";
import type { SourceDisplayFields } from "../sourceCandidate";
import { chooseSummaryCandidate } from "./summaryLanguage";

type DraftDisplayFieldMap = Partial<Record<SourceType, SourceDisplayFields>>;

export interface DraftDisplayRulesInput {
	displayFieldsBySource: DraftDisplayFieldMap;
	preferredSource?: SourceType;
	registeredSourceOrder: readonly SourceType[];
}

export interface DraftDisplayValues {
	originalName?: string;
	translatedName?: string;
	chineseName?: string;
	summary?: string;
	summaryLanguage?: SummaryLanguage;
	summarySource?: SourceType;
	date?: string;
}

const ORIGINAL_NAME_SOURCE_PRIORITY: readonly SourceType[] = [
	"kun",
	"bgm",
	"vndb",
	"hikarinagi",
	"dlsite",
	"erogamescape",
	"ymgal",
];

const TITLE_SOURCE_PRIORITY: readonly SourceType[] = [
	"kun",
	"bgm",
	"ymgal",
	"hikarinagi",
	"vndb",
	"dlsite",
	"erogamescape",
];

const SUMMARY_SOURCE_PRIORITY: readonly SourceType[] = [
	"kun",
	"bgm",
	"ymgal",
	"hikarinagi",
	"dlsite",
	"erogamescape",
	"vndb",
];

function prioritizeSource(
	sources: readonly SourceType[],
	preferredSource?: SourceType,
): SourceType[] {
	return preferredSource
		? [
				preferredSource,
				...sources.filter((source) => source !== preferredSource),
			]
		: [...sources];
}

function hasChineseText(value: string): boolean {
	return /[\u4e00-\u9fa5]/.test(value);
}

function scoreOriginalName(
	name: string,
	knownChineseNames: ReadonlySet<string>,
): number {
	if (/[\u3040-\u30ff]/.test(name)) return 100;
	if (
		knownChineseNames.has(name) &&
		/^[\u4e00-\u9fa5\s\d\p{P}]+$/u.test(name)
	) {
		return -50;
	}
	if (/[a-zA-Z]/.test(name)) return 70;
	if (/^[\u4e00-\u9fa5]/.test(name)) return 15;
	return 20;
}

function chooseOriginalName(
	displayFieldsBySource: DraftDisplayFieldMap,
	preferredSource?: SourceType,
): string | undefined {
	const sources = prioritizeSource(
		ORIGINAL_NAME_SOURCE_PRIORITY,
		preferredSource,
	);
	const knownChineseNames = new Set<string>();
	for (const source of sources) {
		const fields = displayFieldsBySource[source];
		const nameCn = fields?.name_cn?.trim();
		const translatedName = fields?.translated_name;
		if (nameCn) knownChineseNames.add(nameCn);
		if (translatedName?.trim() && hasChineseText(translatedName)) {
			knownChineseNames.add(translatedName.trim());
		}
	}

	let bestName: string | undefined;
	let bestScore = Number.NEGATIVE_INFINITY;
	for (const source of sources) {
		const fields = displayFieldsBySource[source];

		const name = fields?.name?.trim();
		if (!name) continue;

		const score = scoreOriginalName(name, knownChineseNames);
		if (score > bestScore) {
			bestName = name;
			bestScore = score;
		}
	}

	return bestName;
}

function chooseTranslatedName(
	displayFieldsBySource: DraftDisplayFieldMap,
	preferredSource?: SourceType,
): string | undefined {
	const sources = prioritizeSource(TITLE_SOURCE_PRIORITY, preferredSource);
	for (const source of sources) {
		const fields = displayFieldsBySource[source];
		const value = fields?.translated_name?.trim() || fields?.name_cn?.trim();
		if (value && hasChineseText(value)) return value;
	}

	for (const source of sources) {
		const fields = displayFieldsBySource[source];
		const value = fields?.translated_name?.trim() || fields?.name_cn?.trim();
		if (value) return value;
	}

	return undefined;
}

function chooseChineseName(
	displayFieldsBySource: DraftDisplayFieldMap,
	preferredSource?: SourceType,
): string | undefined {
	const sources = prioritizeSource(TITLE_SOURCE_PRIORITY, preferredSource);
	for (const source of sources) {
		const fields = displayFieldsBySource[source];
		const value = fields?.name_cn?.trim() || fields?.translated_name?.trim();
		if (value && hasChineseText(value)) return value;
	}

	return undefined;
}

function chooseSummary(
	displayFieldsBySource: DraftDisplayFieldMap,
	preferredSource: SourceType | undefined,
):
	| {
			summary: string;
			summaryLanguage: SummaryLanguage;
			summarySource: SourceType;
	  }
	| undefined {
	const sources = prioritizeSource(SUMMARY_SOURCE_PRIORITY, preferredSource);
	const candidate = chooseSummaryCandidate(displayFieldsBySource, sources);
	return candidate
		? {
				summary: candidate.summary,
				summaryLanguage: candidate.summaryLanguage ?? "unknown",
				summarySource: candidate.source,
			}
		: undefined;
}

function chooseDate(
	displayFieldsBySource: DraftDisplayFieldMap,
	preferredSource: SourceType | undefined,
	registeredSourceOrder: readonly SourceType[],
): string | undefined {
	const sources = preferredSource ? [preferredSource] : registeredSourceOrder;
	for (const source of sources) {
		const date = displayFieldsBySource[source]?.date?.trim();
		if (date) return date;
	}

	return undefined;
}

export function resolveDraftDisplayRules({
	displayFieldsBySource,
	preferredSource,
	registeredSourceOrder,
}: DraftDisplayRulesInput): DraftDisplayValues {
	const summary = chooseSummary(displayFieldsBySource, preferredSource);
	return {
		originalName: chooseOriginalName(displayFieldsBySource, preferredSource),
		translatedName: chooseTranslatedName(
			displayFieldsBySource,
			preferredSource,
		),
		chineseName: chooseChineseName(displayFieldsBySource, preferredSource),
		summary: summary?.summary,
		summaryLanguage: summary?.summaryLanguage,
		summarySource: summary?.summarySource,
		date: chooseDate(
			displayFieldsBySource,
			preferredSource,
			registeredSourceOrder,
		),
	};
}
