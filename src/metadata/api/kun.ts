/**
 * @file Kungal 游戏信息 API 封装 (v1)
 * @description 封装与 Kungal API v1 交互的函数，包括搜索游戏与获取详细信息
 * @module src/metadata/api/kun
 * @author Skerry contributors (based on ReinaManager)
 * @copyright AGPL-3.0
 */

import i18next from "i18next";
import type { GameMetadataDraft, KunData } from "@/types";
import { AppError } from "@/utils/errors";
import { USER_AGENT } from "../constants";
import type { MetadataRequestContext } from "../sourceAdapter";
import {
	createGameCandidate,
	createSourceCandidateRecord,
	getCandidateSourceId,
	mergeCandidateSources,
} from "../sourceCandidate";
import http, { type TauriHttpOptions } from "./http";
import { fetchVndbById } from "./vndb";

const KUN_API_BASE = "https://www.kungal.com/api/v1";

const KUN_JSON_HEADERS = {
	Accept: "application/json",
	"User-Agent": USER_AGENT,
} as const;

export interface KunV1LocalizedString {
	value: string;
	is_machine?: boolean;
}

export interface KunV1Image {
	url: string;
	hash?: string;
	width?: number | null;
	height?: number | null;
	thumbhash?: string | null;
	sexual?: string | number | null;
}

export interface KunV1Maker {
	object?: string;
	id?: string;
	display_name?: string;
}

export interface KunV1Intro {
	locale: string;
	value: string;
	is_machine?: boolean;
	data_source?: string;
}

export interface KunV1ExternalRef {
	site: string;
	external_id: string;
}

export interface KunV1Tag {
	object?: string;
	id?: string;
	display_name: string;
	tag_kind?: string;
	is_sexual?: boolean;
	catalog_work_count?: number;
	spoiler?: "none" | "minor" | "major";
}

export interface KunV1Screenshot {
	object?: string;
	image: KunV1Image;
	caption?: string;
	site?: string;
	sort_order?: number;
}

export interface KunV1WorkDetail {
	object?: string;
	id: string;
	display_name: string;
	latin?: string | null;
	localized?: Record<string, KunV1LocalizedString>;
	cover?: KunV1Image | null;
	banner?: KunV1Image | null;
	release_date?: string | null;
	maker?: KunV1Maker | null;
	aliases?: string[];
	intros?: KunV1Intro[];
	external_refs?: KunV1ExternalRef[];
	tags?: KunV1Tag[];
	screenshots?: KunV1Screenshot[];
	content_rating?: string;
	is_nsfw?: boolean;
}

export interface KunV1ListResponse<T> {
	object: string;
	items: T[];
	total?: number;
	page?: number;
	limit?: number;
}

interface KunFetchOptions extends MetadataRequestContext {
	enrichVndb?: boolean;
}

function buildKunRateLimitedOptions(
	options: TauriHttpOptions = {},
): TauriHttpOptions {
	return {
		...options,
		headers: {
			...KUN_JSON_HEADERS,
			...options.headers,
		},
		rateLimit: { source: "kun" },
	};
}

function normalizeText(value?: string): string | undefined {
	if (typeof value !== "string" || !value.trim()) {
		return undefined;
	}
	return value.replace(/\\\r?\\n/g, "\\n").trim();
}

function pickKunOriginalName(
	work: KunV1WorkDetail,
	nameCn?: string,
): string {
	const localized = work.localized;
	const jaItem = localized?.ja ?? localized?.["ja-jp"];
	if (jaItem) {
		const jaText = normalizeText(typeof jaItem === "string" ? jaItem : jaItem.value);
		if (jaText) return jaText;
	}

	const displayName = normalizeText(work.display_name);
	// 如果 display_name 包含日文平假名/片假名，必定是日文原生原名
	if (displayName && /[\u3040-\u30ff]/.test(displayName)) {
		return displayName;
	}

	// 欧美原生或西文原名：若无日文字段，且 display_name 为纯英文/西文字符（或非纯中文且不等于中文名）
	if (displayName && displayName !== nameCn && !/^[\u4e00-\u9fa5]+$/.test(displayName)) {
		return displayName;
	}

	// 检查 latin 字段（罗马音或西文）
	const latin = normalizeText(work.latin ?? undefined);
	if (latin && latin !== nameCn) {
		return latin;
	}

	// 检查英文本地化
	const enItem = localized?.en ?? localized?.["en-us"];
	if (enItem) {
		const enText = normalizeText(typeof enItem === "string" ? enItem : enItem.value);
		if (enText && enText !== nameCn) return enText;
	}

	// 兜底：display_name 或 中文原生标题
	return displayName || nameCn || "";
}

function pickKunTranslatedName(
	work: KunV1WorkDetail,
	nameCn?: string,
	originalName?: string,
): string | undefined {
	if (nameCn && nameCn.trim()) {
		return nameCn.trim();
	}
	const localized = work.localized;
	const enItem = localized?.en ?? localized?.["en-us"];
	if (enItem) {
		const enText = normalizeText(typeof enItem === "string" ? enItem : enItem.value);
		if (enText && enText !== originalName) {
			return enText;
		}
	}
	const latin = normalizeText(work.latin ?? undefined);
	if (latin && latin !== originalName) {
		return latin;
	}
	return undefined;
}

function pickChineseTitle(
	localized?: Record<string, KunV1LocalizedString | string>,
): string | undefined {
	if (!localized) return undefined;
	for (const key of ["zh-Hans", "zh-cn", "zh-Hant", "zh-tw"]) {
		const item = localized[key];
		if (!item) continue;
		const val = typeof item === "string" ? item : item.value;
		const text = normalizeText(val);
		if (text) return text;
	}
	return undefined;
}

function extractAllTitles(
	displayName?: string,
	localized?: Record<string, KunV1LocalizedString | string>,
	aliases?: string[],
): string[] {
	const titles = new Set<string>();
	if (displayName?.trim()) {
		titles.add(displayName.trim());
	}
	if (localized) {
		for (const item of Object.values(localized)) {
			const val = typeof item === "string" ? item : item?.value;
			if (val?.trim()) {
				titles.add(val.trim());
			}
		}
	}
	if (Array.isArray(aliases)) {
		for (const alias of aliases) {
			if (alias?.trim()) {
				titles.add(alias.trim());
			}
		}
	}
	return Array.from(titles);
}

function pickIntroSummary(intros?: KunV1Intro[]): string | undefined {
	if (!Array.isArray(intros) || intros.length === 0) return undefined;
	const lang = i18next.language || "zh-CN";

	let targetLocale = "zh-Hans";
	if (lang.startsWith("zh-TW") || lang.startsWith("zh-HK")) {
		targetLocale = "zh-Hant";
	} else if (lang.startsWith("ja")) {
		targetLocale = "ja";
	} else if (lang.startsWith("en")) {
		targetLocale = "en";
	}

	const directMatch = intros.find(
		(i) => i.locale.toLowerCase() === targetLocale.toLowerCase(),
	);
	if (directMatch?.value?.trim()) return normalizeText(directMatch.value);

	const zhMatch = intros.find((i) => i.locale.toLowerCase().startsWith("zh"));
	if (zhMatch?.value?.trim()) return normalizeText(zhMatch.value);

	const jaMatch = intros.find((i) => i.locale.toLowerCase().startsWith("ja"));
	if (jaMatch?.value?.trim()) return normalizeText(jaMatch.value);

	const first = intros[0];
	return first?.value?.trim() ? normalizeText(first.value) : undefined;
}

function extractKunTags(tags?: KunV1Tag[], filterLevel = 0): string[] {
	if (!Array.isArray(tags) || tags.length === 0) return [];
	const spoilerRank: Record<string, number> = {
		none: 0,
		minor: 1,
		major: 2,
	};

	return tags
		.filter((t) => {
			const level = t.spoiler ? (spoilerRank[t.spoiler] ?? 0) : 0;
			return level <= filterLevel;
		})
		.sort((a, b) => (b.catalog_work_count ?? 0) - (a.catalog_work_count ?? 0))
		.map((t) => t.display_name?.trim())
		.filter((name): name is string => Boolean(name));
}

function extractVndbId(refs?: KunV1ExternalRef[]): string | undefined {
	if (!Array.isArray(refs)) return undefined;
	const ref = refs.find((r) => r.site?.toLowerCase() === "vndb");
	return ref?.external_id?.trim();
}

const transformKunV1Data = (
	work: KunV1WorkDetail,
	filterLevel: number,
): GameMetadataDraft => {
	const summary = pickIntroSummary(work.intros);
	const nameCn = pickChineseTitle(work.localized);
	const name = pickKunOriginalName(work, nameCn);
	const translatedName = pickKunTranslatedName(work, nameCn, name);
	const allTitles = extractAllTitles(work.display_name, work.localized, work.aliases);

	const screenshots = (work.screenshots ?? [])
		.filter((s) => {
			const rating = String(s.image?.sexual ?? "").toLowerCase().trim();
			return rating !== "2" && rating !== "explicit" && rating !== "r18";
		})
		.map((s) => s.image?.url?.trim())
		.filter((url): url is string => Boolean(url));

	const sourceData: KunData = {
		image: work.cover?.url || work.banner?.url,
		name,
		name_cn: nameCn,
		translated_name: translatedName,
		all_titles: allTitles,
		aliases: Array.from(new Set((work.aliases || []).map((a) => a.trim()).filter(Boolean))),
		summary,
		tags: extractKunTags(work.tags, filterLevel),
		screenshots,
		developer: work.maker?.display_name?.trim() || undefined,
		nsfw: Boolean(work.is_nsfw || work.content_rating === "r18"),
		date: work.release_date ?? undefined,
	};

	const result: GameMetadataDraft = {
		...createGameCandidate({
			idType: "kun",
			source: createSourceCandidateRecord(
				"kun",
				String(work.id),
				sourceData,
			),
		}),
	};

	return result;
};

export async function fetchKunScreenshots(
	id: string,
	options: Pick<MetadataRequestContext, "proxyUrl" | "signal"> = {},
): Promise<string[]> {
	const resp = await http.get<KunV1WorkDetail>(
		`${KUN_API_BASE}/works/${id}`,
		buildKunRateLimitedOptions({
			signal: options.signal,
			proxyUrl: options.proxyUrl,
		}),
	);

	const screenshots = resp.data?.screenshots ?? [];
	return screenshots
		.filter((shot) => {
			const rating = String(shot.image?.sexual ?? "").toLowerCase().trim();
			return rating !== "2" && rating !== "explicit" && rating !== "r18";
		})
		.map((shot) => shot.image?.url?.trim())
		.filter((url): url is string => Boolean(url));
}

export async function fetchGalgameById(
	id: string,
	options: KunFetchOptions,
): Promise<GameMetadataDraft> {
	const { enrichVndb = true, proxyUrl, signal, spoilerLevel } = options;
	const url = `${KUN_API_BASE}/works/${id}`;

	const resp = await http.get<KunV1WorkDetail>(
		url,
		buildKunRateLimitedOptions({
			signal,
			proxyUrl,
		}),
	);

	const work = resp.data;
	if (!work || !work.id) {
		throw new AppError({
			code: "metadata_not_found",
			message: `Kungal game not found: ${id}`,
		});
	}

	const kunResult = transformKunV1Data(work, spoilerLevel);
	const vndbId = extractVndbId(work.external_refs);

	if (!enrichVndb || !vndbId) {
		return kunResult;
	}

	try {
		const vndbResult = await fetchVndbById(vndbId, options);
		return {
			...kunResult,
			id_type: "mixed",
			sources: mergeCandidateSources([kunResult, vndbResult]),
		};
	} catch (error) {
		if (import.meta.env.DEV) {
			console.warn(
				`[Kungal API] VNDB 增强失败，回退到 Kungal 原始数据: ${vndbId}`,
				error,
			);
		}
		return kunResult;
	}
}

export async function searchGalgame(
	keywords: string,
	page = 1,
	limit = 12,
	fetchDetailById = false,
	options: KunFetchOptions,
): Promise<GameMetadataDraft[]> {
	const resp = await http.get<KunV1ListResponse<KunV1WorkDetail>>(
		`${KUN_API_BASE}/library-works`,
		buildKunRateLimitedOptions({
			params: {
				q: keywords,
				page,
				limit,
				include_all_original_languages: true,
			},
			signal: options.signal,
			proxyUrl: options.proxyUrl,
		}),
	);

	const items = resp.data?.items;
	if (!Array.isArray(items)) {
		throw new AppError({
			code: "metadata_not_found",
			message: `Kungal search failed for: ${keywords}`,
		});
	}

	const results = items.map((item) => {
		const nameCn = pickChineseTitle(item.localized);
		const name = pickKunOriginalName(item, nameCn);
		const translatedName = pickKunTranslatedName(item, nameCn, name);
		return {
			...createGameCandidate({
				idType: "kun",
				source: createSourceCandidateRecord("kun", String(item.id), {
					name,
					name_cn: nameCn,
					translated_name: translatedName,
					image: item.cover?.url || item.banner?.url,
					date: item.release_date ?? undefined,
					developer: item.maker?.display_name?.trim() || undefined,
					nsfw: Boolean(item.is_nsfw),
				}),
			}),
		};
	});

	const firstResultId = results[0]
		? getCandidateSourceId(results[0], "kun")
		: undefined;
	if (fetchDetailById && firstResultId) {
		const detailedData = await fetchGalgameById(firstResultId, options);
		return [detailedData];
	}

	return results;
}
