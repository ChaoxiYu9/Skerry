import type { SummaryLanguage } from "@/types";
import { chooseSummaryCandidate } from "./summaryLanguage";
type SummaryFields = { summary?: string; summaryLanguage?: SummaryLanguage };
type TagFields = { tags?: string[] };
type ImageFields = { image?: string };
type ArrayFields = Partial<
	Record<"tags" | "aliases" | "all_titles" | "screenshots", string[]>
>;

export function hasChineseText(text?: string): boolean {
	return Boolean(text && /[\u4e00-\u9fa5]/.test(text));
}

export function chooseMixedSummary<TSource extends string>(
	displays: Partial<Record<TSource, SummaryFields>>,
	nonVndbSources: readonly TSource[],
	vndbSource: TSource,
): string | undefined {
	return chooseSummaryCandidate(displays, [...nonVndbSources, vndbSource])
		?.summary;
}

export function mergeMixedTags<TSource extends string>(
	displays: Partial<Record<TSource, TagFields>>,
	nonVndbSources: readonly TSource[],
	vndbSource: TSource,
): string[] {
	const chineseTags: string[] = [];
	const otherTags: string[] = [];
	const seen = new Set<string>();

	for (const source of nonVndbSources) {
		const tags = displays[source]?.tags;
		if (!Array.isArray(tags)) continue;
		for (const tag of tags) {
			const trimmed = tag.trim();
			if (!trimmed || seen.has(trimmed)) continue;
			seen.add(trimmed);
			if (hasChineseText(trimmed)) {
				chineseTags.push(trimmed);
			} else {
				otherTags.push(trimmed);
			}
		}
	}

	if (chineseTags.length === 0 && otherTags.length === 0) {
		return displays[vndbSource]?.tags ?? [];
	}

	return chineseTags.concat(otherTags);
}

export function firstDisplayField<
	TSource extends string,
	TField extends PropertyKey,
	TValue,
	TFields extends Partial<Record<TField, TValue>>,
>(
	displays: Partial<Record<TSource, TFields>>,
	sources: readonly TSource[],
	field: TField,
): NonNullable<TValue> | undefined {
	for (const source of sources) {
		const sourceFields = displays[source];
		const value = sourceFields?.[field];
		if (value != null) return value;
	}
	return undefined;
}

export function mergeDisplayArrays<TSource extends string>(
	displays: Partial<Record<TSource, ArrayFields>>,
	sources: readonly TSource[],
	field: keyof ArrayFields,
): string[] {
	const merged: string[] = [];
	const seen = new Set<string>();

	for (const source of sources) {
		const values = displays[source]?.[field];
		if (!values) continue;

		for (const value of values) {
			if (seen.has(value)) continue;
			seen.add(value);
			merged.push(value);
		}
	}

	return merged;
}

export function chooseCoverImage<TSource extends string>(
	displays: Partial<Record<TSource, ImageFields>>,
	coverSource: TSource | null | undefined,
	priority: readonly TSource[],
): string | undefined {
	if (coverSource) {
		const selectedImage = displays[coverSource]?.image;
		if (selectedImage) return selectedImage;
	}

	return firstDisplayField(displays, priority, "image");
}
