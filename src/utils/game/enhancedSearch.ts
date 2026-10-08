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

interface SuggestionEntry {
	value: string;
	normalized: string;
	pinyinFull: string;
	pinyinSpaced: string;
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
): Pick<SuggestionEntry, "pinyinFull" | "pinyinSpaced" | "pinyinFirst"> {
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

function searchDirect(
	documents: SearchDocument[],
	query: string,
): SearchResult[] {
	const results: SearchResult[] = [];

	for (const document of documents) {
		const score = getDirectMatchScore(document.normalizedValues, query);
		if (score > 0) {
			results.push({
				item: document.game,
				score,
			});
		}
	}

	return results.toSorted((a, b) => b.score - a.score || a.item.id - b.item.id);
}

function searchPinyinDirect(
	documents: SearchDocument[],
	pinyinQuery: string,
	existingIds: Set<number>,
): SearchResult[] {
	if (!pinyinQuery || pinyinQuery.length < MIN_FUZZY_KEYWORD_LENGTH) return [];

	const results: SearchResult[] = [];
	for (const document of documents) {
		if (existingIds.has(document.id)) continue;

		const valueScore = getDirectMatchScore(document.pinyinValues, pinyinQuery);
		const initialScore = getDirectMatchScore(
			document.pinyinInitials,
			pinyinQuery,
		);
		const score = Math.max(valueScore, initialScore);

		if (score > 0) {
			results.push({
				item: document.game,
				score: score - 5,
			});
			existingIds.add(document.id);
		}
	}

	return results.toSorted((a, b) => b.score - a.score || a.item.id - b.item.id);
}

function shouldRunFuzzySearch(
	query: string,
	directResults: SearchResult[],
	maxFuzzyKeywordLength: number,
): boolean {
	return (
		query.length >= MIN_FUZZY_KEYWORD_LENGTH &&
		query.length <= maxFuzzyKeywordLength &&
		directResults.length < 5
	);
}

function mergeFuzzyResults(
	directResults: SearchResult[],
	fuseResults: FuseResult<SearchDocument>[],
	limit?: number,
): SearchResult[] {
	const seenIds = new Set(directResults.map((result) => result.item.id));
	const results = [...directResults];

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
	const directResults = searchDirect(index.documents, searchTerm);
	const pinyinResults = searchPinyinDirect(
		index.documents,
		normalizePinyinText(searchTerm),
		new Set(directResults.map((result) => result.item.id)),
	);
	const directAndPinyinResults = [...directResults, ...pinyinResults];

	if (
		!enableFuzzy ||
		!shouldRunFuzzySearch(
			searchTerm,
			directAndPinyinResults,
			maxFuzzyKeywordLength,
		)
	) {
		return typeof limit === "number"
			? directAndPinyinResults.slice(0, limit)
			: directAndPinyinResults;
	}

	const fuseResults = index.fuse.search(searchTerm, {
		limit: limit ?? index.documents.length,
	});

	return mergeFuzzyResults(directAndPinyinResults, fuseResults, limit);
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
			entries.push({
				value,
				normalized,
				...getSuggestionPinyin(value),
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
		} else if (
			pinyinInput &&
			(entry.pinyinFull || entry.pinyinSpaced || entry.pinyinFirst)
		) {
			if (
				entry.pinyinFull.startsWith(pinyinInput) ||
				normalizePinyinText(entry.pinyinSpaced).startsWith(pinyinInput)
			) {
				score = 50;
			} else if (
				entry.pinyinFull.includes(pinyinInput) ||
				normalizePinyinText(entry.pinyinSpaced).includes(pinyinInput)
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
