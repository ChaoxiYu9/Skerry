function normalizeTagFilterValue(tag: string): string {
	return tag.trim().toLowerCase();
}

export function normalizeTagFilters(tags: readonly string[]): string[] {
	const seen = new Set<string>();
	const normalizedTags: string[] = [];

	for (const tag of tags) {
		const trimmed = tag.trim();
		const normalized = normalizeTagFilterValue(trimmed);
		if (!trimmed || seen.has(normalized)) continue;
		seen.add(normalized);
		normalizedTags.push(trimmed);
	}

	return normalizedTags;
}

export function buildNormalizedTagMap(
	tags: readonly string[],
): Map<string, string> {
	const tagMap = new Map<string, string>();

	for (const tag of tags) {
		tagMap.set(normalizeTagFilterValue(tag), tag);
	}

	return tagMap;
}

export function buildNormalizedTagSet(tags: readonly string[]): Set<string> {
	return new Set(tags.map(normalizeTagFilterValue).filter(Boolean));
}

export function hasMatchingTag(
	normalizedTags: ReadonlySet<string>,
	tag: string,
): boolean {
	return normalizedTags.has(normalizeTagFilterValue(tag));
}

export function matchesAllTagFilters(
	tags: readonly string[],
	filters: readonly string[],
): boolean {
	if (filters.length === 0) return true;
	if (tags.length === 0) return false;

	const normalizedTags = buildNormalizedTagSet(tags);
	return filters.every((filter) => hasMatchingTag(normalizedTags, filter));
}

export function matchesAllNormalizedTagFilters(
	tags: readonly string[],
	normalizedFilters: ReadonlySet<string>,
): boolean {
	if (normalizedFilters.size === 0) return true;
	if (tags.length === 0) return false;

	const remainingFilters = new Set(normalizedFilters);
	for (const tag of tags) {
		remainingFilters.delete(normalizeTagFilterValue(tag));
		if (remainingFilters.size === 0) return true;
	}

	return false;
}

export function findTagByInput(
	tagMap: ReadonlyMap<string, string>,
	input: string,
): string | undefined {
	return tagMap.get(normalizeTagFilterValue(input));
}

export function filterTagSuggestions(
	tagMap: ReadonlyMap<string, string>,
	selectedTags: readonly string[],
	input: string,
	limit: number,
): string[] {
	const normalizedInput = normalizeTagFilterValue(input);
	if (!normalizedInput || limit <= 0) return [];

	const selectedTagSet = buildNormalizedTagSet(selectedTags);
	const suggestions: string[] = [];

	for (const [normalizedTag, tag] of tagMap) {
		if (selectedTagSet.has(normalizedTag)) continue;
		if (!normalizedTag.includes(normalizedInput)) continue;

		suggestions.push(tag);
		if (suggestions.length >= limit) break;
	}

	return suggestions;
}
