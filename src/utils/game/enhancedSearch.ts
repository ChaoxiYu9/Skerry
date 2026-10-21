/**
 * @file 游戏搜索工具
 * @description 提供游戏列表搜索和搜索建议。搜索字段保持显式配置，避免搜索链路继续膨胀。
 * @module src/utils/enhancedSearch
 */

import Fuse, { type FuseResult, type IFuseOptions } from "fuse.js";
import { pinyin } from "pinyin-pro";
import type { GameData } from "@/types";

interface SearchDocument {
	id: number;
	game: GameData;
	values: string[];
	normalizedValues: string[];
	pinyinValues: string[];
	pinyinInitials: string[];
}

interface SuggestionPinyin {
	pinyinFull: string;
	pinyinSpaced: string;
	pinyinFirst: string;
}

interface SuggestionEntry {
	value: string;
	normalized: string;
	pinyinFull: string;
	pinyinSpacedNormalized: string;
	pinyinFirst: string;
}

export interface SearchResult {
	item: GameData;
	score: number;
	matches?: FuseResult<SearchDocument>["matches"];
}

export interface SearchIndex {
	documents: SearchDocument[];
	fuse: Fuse<SearchDocument>;
}

const DEFAULT_FUZZY_THRESHOLD = 0.35;
const DEFAULT_MAX_FUZZY_KEYWORD_LENGTH = 40;
const MIN_FUZZY_KEYWORD_LENGTH = 2;

function normalizeSearchText(value: string): string {
	return value.trim().toLowerCase();
}

function normalizePinyinText(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function hasChineseText(value: string): boolean {
	return /[\u4e00-\u9fff]/.test(value);
}

function addValue(values: string[], value: unknown): void {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	if (trimmed) {
		values.push(trimmed);
	}
}

function addValues(values: string[], source: unknown): void {
	if (!Array.isArray(source)) return;
	for (const value of source) {
		addValue(values, value);
	}
}

function getGameSearchValues(game: GameData): string[] {
	const values: string[] = [];

	addValue(values, game.name);
	addValue(values, game.name_cn);
	addValue(values, game.custom_data?.name);
	addValues(values, game.all_titles);
	addValues(values, game.aliases);

	return Array.from(new Set(values));
}

function getSuggestionPinyin(
	value: string,
): SuggestionPinyin {
	if (!hasChineseText(value)) {
		return {
			pinyinFull: "",
			pinyinSpaced: "",
			pinyinFirst: "",
		};
	}

	try {
		const pinyinSpaced = pinyin(value, {
			toneType: "none",
			type: "string",
			separator: " ",
		}).toLowerCase();
		const pinyinFirst = pinyin(value, {
			pattern: "first",
			toneType: "none",
			type: "string",
			separator: "",
		}).toLowerCase();

		return {
			pinyinFull: pinyinSpaced.replaceAll(" ", ""),
			pinyinSpaced,
			pinyinFirst,
		};
	} catch {
		return {
			pinyinFull: "",
			pinyinSpaced: "",
			pinyinFirst: "",
		};
	}
}

function getSearchPinyinValues(
	values: string[],
): Pick<SearchDocument, "pinyinValues" | "pinyinInitials"> {
	const pinyinValues: string[] = [];
	const pinyinInitials: string[] = [];

	for (const value of values) {
		const pinyinValue = getSuggestionPinyin(value);
		if (pinyinValue.pinyinFull) {
			pinyinValues.push(pinyinValue.pinyinFull);
		}
		if (pinyinValue.pinyinFirst) {
			pinyinInitials.push(pinyinValue.pinyinFirst);
		}
	}

	return {
		pinyinValues: Array.from(new Set(pinyinValues)),
		pinyinInitials: Array.from(new Set(pinyinInitials)),
	};
}

function createFuseInstance(
	documents: SearchDocument[],
	threshold: number,
): Fuse<SearchDocument> {
	const options: IFuseOptions<SearchDocument> = {
		threshold,
		location: 0,
		distance: 120,
		minMatchCharLength: 2,
		shouldSort: true,
		includeMatches: true,
		includeScore: true,
		isCaseSensitive: false,
		findAllMatches: false,
		keys: ["values"],
	};

	return new Fuse(documents, options);
}

function createSearchDocument(game: GameData): SearchDocument {
	const values = getGameSearchValues(game);
	const pinyinValues = getSearchPinyinValues(values);
	return {
		id: game.id,
		game,
		values,
		normalizedValues: values.map(normalizeSearchText),
		...pinyinValues,
	};
}

function getDirectMatchScore(
	normalizedValues: string[],
	query: string,
): number {
	let score = 0;

	for (const value of normalizedValues) {
		if (value === query) {
			score = Math.max(score, 100);
		} else if (value.startsWith(query)) {
			score = Math.max(score, 80);
		} else if (value.includes(query)) {
			score = Math.max(score, 60);
		}
	}

	return score;
}

interface RankedSearchCandidate {
	item: GameData;
	score: number;
	tier: 0 | 1;
}

function rankDeterministicMatches(
	documents: SearchDocument[],
	query: string,
): SearchResult[] {
	const pinyinQuery = normalizePinyinText(query);
	const directIds = new Set<number>();
	const pinyinIds = new Set<number>();
	const candidates: RankedSearchCandidate[] = [];

	for (const document of documents) {
		const directScore = getDirectMatchScore(document.normalizedValues, query);
		if (directScore > 0) {
			directIds.add(document.id);
			candidates.push({
				item: document.game,
				score: directScore,
				tier: 0,
			});
			continue;
		}

		if (
			pinyinQuery.length < MIN_FUZZY_KEYWORD_LENGTH ||
			directIds.has(document.id) ||
			pinyinIds.has(document.id)
		) {
			continue;
		}

		const valueScore = getDirectMatchScore(document.pinyinValues, pinyinQuery);
		const initialScore = getDirectMatchScore(
			document.pinyinInitials,
			pinyinQuery,
		);
		const pinyinScore = Math.max(valueScore, initialScore);
		if (pinyinScore > 0) {
			pinyinIds.add(document.id);
			candidates.push({
				item: document.game,
				score: pinyinScore - 5,
				tier: 1,
			});
		}
	}

	// Original text matches form the first tier; pinyin matches follow even
	// when their numeric score is higher. IDs break ties within each tier.
	return candidates
		.filter((candidate) => candidate.tier === 0 || !directIds.has(candidate.item.id))
		.toSorted(
			(a, b) =>
				a.tier - b.tier ||
				b.score - a.score ||
				a.item.id - b.item.id,
		)
		.map(({ item, score }) => ({ item, score }));
}

function shouldRunFuzzySearch(
	query: string,
	prioritizedResults: SearchResult[],
	maxFuzzyKeywordLength: number,
): boolean {
	return (
		query.length >= MIN_FUZZY_KEYWORD_LENGTH &&
		query.length <= maxFuzzyKeywordLength &&
		prioritizedResults.length < 5
	);
}

function mergeFuzzyResults(
	prioritizedResults: SearchResult[],
	fuseResults: FuseResult<SearchDocument>[],
	limit?: number,
): SearchResult[] {
	const seenIds = new Set(prioritizedResults.map((result) => result.item.id));
	const results = [...prioritizedResults];

	for (const result of fuseResults) {
		if (seenIds.has(result.item.id)) continue;
		seenIds.add(result.item.id);
		results.push({
			item: result.item.game,
			score: 50 - (result.score ?? 0),
			matches: result.matches,
		});
	}

	return typeof limit === "number" ? results.slice(0, limit) : results;
}

/**
 * 创建游戏列表搜索索引。索引只依赖游戏列表，与搜索词无关。
 */
export function createSearchIndex(
	games: GameData[],
	threshold = DEFAULT_FUZZY_THRESHOLD,
): SearchIndex {
	const documents = games.map(createSearchDocument);
	return {
		documents,
		fuse: createFuseInstance(documents, threshold),
	};
}

/**
 * 使用预构建索引搜索游戏列表。
 *
 * 搜索策略：
 * 1. 普通文本先走 exact / startsWith / includes。
 * 2. 只有关键词较短且直接结果较少时才走 Fuse fallback。
 */
export function searchWithIndex(
	index: SearchIndex,
	keyword: string,
	options: {
		limit?: number;
		enableFuzzy?: boolean;
		maxFuzzyKeywordLength?: number;
	} = {},
): SearchResult[] {
	const searchTerm = normalizeSearchText(keyword);
	if (!searchTerm) {
		return index.documents.map((document) => ({
			item: document.game,
			score: 100,
		}));
	}

	const {
		limit,
		enableFuzzy = true,
		maxFuzzyKeywordLength = DEFAULT_MAX_FUZZY_KEYWORD_LENGTH,
	} = options;
	const prioritizedResults = rankDeterministicMatches(index.documents, searchTerm);

	if (
		!enableFuzzy ||
		!shouldRunFuzzySearch(
			searchTerm,
			prioritizedResults,
			maxFuzzyKeywordLength,
		)
	) {
		return typeof limit === "number"
			? prioritizedResults.slice(0, limit)
			: prioritizedResults;
	}

	const fuseResults = index.fuse.search(searchTerm, {
		limit: limit ?? index.documents.length,
	});

	return mergeFuzzyResults(prioritizedResults, fuseResults, limit);
}

/**
 * 预处理搜索建议。建议只围绕名称、中文名、自定义名、全标题和别名。
 */
export function preprocessSuggestionData(games: GameData[]): SuggestionEntry[] {
	const entries: SuggestionEntry[] = [];
	const seen = new Set<string>();

	for (const game of games) {
		for (const value of getGameSearchValues(game)) {
			const normalized = normalizeSearchText(value);
			if (!normalized || seen.has(normalized)) continue;
			seen.add(normalized);
			const pinyinValues = getSuggestionPinyin(value);
			entries.push({
				value,
				normalized,
				pinyinFull: pinyinValues.pinyinFull,
				pinyinSpacedNormalized: normalizePinyinText(
					pinyinValues.pinyinSpaced,
				),
				pinyinFirst: pinyinValues.pinyinFirst,
			});
		}
	}

	return entries;
}

/**
 * 从预处理数据中获取搜索建议。只做轻量字符串匹配，不走 Fuse。
 */
export function getSearchSuggestionsFromData(
	entries: SuggestionEntry[],
	input: string,
	limit: number = 8,
): string[] {
	const inputLower = normalizeSearchText(input);
	if (!inputLower) return [];
	const pinyinInput = normalizePinyinText(inputLower);

	const suggestions: Array<{ value: string; score: number }> = [];

	for (const entry of entries) {
		let score = 0;
		if (entry.normalized === inputLower) {
			score = 100;
		} else if (entry.normalized.startsWith(inputLower)) {
			score = 80;
		} else if (entry.normalized.includes(inputLower)) {
			score = 60;
		} else if (pinyinInput) {
			if (
				entry.pinyinFull.startsWith(pinyinInput) ||
				entry.pinyinSpacedNormalized.startsWith(pinyinInput)
			) {
				score = 50;
			} else if (
				entry.pinyinFull.includes(pinyinInput) ||
				entry.pinyinSpacedNormalized.includes(pinyinInput)
			) {
				score = 40;
			} else if (
				pinyinInput.length >= 2 &&
				entry.pinyinFirst.startsWith(pinyinInput)
			) {
				score = 35;
			} else if (
				pinyinInput.length >= 2 &&
				entry.pinyinFirst.includes(pinyinInput)
			) {
				score = 30;
			}
		}

		if (score > 0) {
			suggestions.push({ value: entry.value, score });
		}
	}

	return suggestions
		.toSorted(
			(a, b) =>
				b.score - a.score ||
				a.value.length - b.value.length ||
				a.value.localeCompare(b.value),
		)
		.map((suggestion) => suggestion.value)
		.slice(0, limit);
}
