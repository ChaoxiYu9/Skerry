import type { SummaryLanguage } from "@/types";

export interface SummaryCandidate<TSource extends string = string> {
	source: TSource;
	summary: string;
	summaryLanguage?: SummaryLanguage;
}

const LANGUAGE_PRIORITY: Record<SummaryLanguage, number> = {
	unknown: 0,
	other: 1,
	en: 2,
	ja: 3,
	zh: 4,
};

export function normalizeSummaryLanguage(
	language?: string | null,
): SummaryLanguage | undefined {
	const normalized = language?.trim().toLowerCase().replaceAll("_", "-");
	if (!normalized) return undefined;
	if (/^(zh|zho|chi)(-|$)|chinese|中文|汉语/.test(normalized)) return "zh";
	if (/^(ja|jp|jpn)(-|$)|japanese|日本語/.test(normalized)) return "ja";
	if (/^(en|eng)(-|$)|english/.test(normalized)) return "en";
	return "other";
}

/** Used only when a provider does not identify the summary language. */
export function inferSummaryLanguage(summary?: string | null): SummaryLanguage {
	if (!summary?.trim()) return "unknown";
	const kanaCount = summary.match(/[\u3040-\u30ff\u31f0-\u31ff]/g)?.length ?? 0;
	const hanCount = summary.match(/[\u3400-\u9fff]/g)?.length ?? 0;
	if (
		kanaCount > 0 &&
		(hanCount === 0 || kanaCount >= Math.max(2, hanCount * 0.08))
	) {
		return "ja";
	}
	if (hanCount > 0) return "zh";
	if (/[a-z]/i.test(summary)) return "en";
	return "other";
}

export function resolveSummaryLanguage(
	summary: string,
	explicitLanguage?: SummaryLanguage,
): SummaryLanguage {
	return explicitLanguage ?? inferSummaryLanguage(summary);
}

export function chooseSummaryCandidate<TSource extends string>(
	displayFields: Partial<
		Record<TSource, { summary?: string; summaryLanguage?: SummaryLanguage }>
	>,
	sourcePriority: readonly TSource[],
): SummaryCandidate<TSource> | undefined {
	let best: SummaryCandidate<TSource> | undefined;
	let bestPriority = -1;

	for (const source of sourcePriority) {
		const fields = displayFields[source];
		const summary = fields?.summary?.trim();
		if (!summary) continue;

		const summaryLanguage = resolveSummaryLanguage(
			summary,
			fields?.summaryLanguage,
		);
		const priority = LANGUAGE_PRIORITY[summaryLanguage];
		if (priority > bestPriority) {
			best = { source, summary, summaryLanguage };
			bestPriority = priority;
		}
	}

	return best;
}

export function shouldReplaceSummary(
	existingSummary: string | null | undefined,
	existingLanguage: SummaryLanguage | undefined,
	incomingSummary: string,
	incomingLanguage: SummaryLanguage | undefined,
): boolean {
	if (!existingSummary?.trim()) return true;
	const current = resolveSummaryLanguage(existingSummary, existingLanguage);
	const incoming = resolveSummaryLanguage(incomingSummary, incomingLanguage);
	return LANGUAGE_PRIORITY[incoming] >= LANGUAGE_PRIORITY[current];
}
