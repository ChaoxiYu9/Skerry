/**
 * @file Kungal 游戏信息 API 封装 (v1)
 * @description 封装与 Kungal API v1 交互的函数，包括搜索游戏与获取详细信息
 * @module src/metadata/api/kun
 * @author Skerry contributors (based on ReinaManager)
 * @copyright AGPL-3.0
 */

import type { GameMetadataDraft, KunData } from "@/types";
import { isAbortError } from "@/utils/async";
import { AppError } from "@/utils/errors";
import { USER_AGENT } from "../constants";
import type { MetadataRequestContext } from "../sourceAdapter";
import {
	createGameCandidate,
	createSourceCandidateRecord,
	getCandidateSourceId,
} from "../sourceCandidate";
import { normalizeSummaryLanguage } from "../data/summaryLanguage";
import http, { type TauriHttpOptions } from "./http";

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

type KunFetchOptions = MetadataRequestContext;

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

function pickKunOriginalName(work: KunV1WorkDetail, nameCn?: string): string {
	const localized = work.localized;
	const jaItem = localized?.ja ?? localized?.["ja-jp"];
	if (jaItem) {
		const jaText = normalizeText(
			typeof jaItem === "string" ? jaItem : jaItem.value,
		);
		if (jaText) return jaText;
	}

	const displayName = normalizeText(work.display_name);
	// 如果 display_name 包含日文平假名/片假名，必定是日文原生原名
	if (displayName && /[\u3040-\u30ff]/.test(displayName)) {
		return displayName;
	}

	// 欧美原生或西文原名：若无日文字段，且 display_name 为纯英文/西文字符（或非纯中文且不等于中文名）
	if (
		displayName &&
		displayName !== nameCn &&
		!/^[\u4e00-\u9fa5]+$/.test(displayName)
	) {
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
		const enText = normalizeText(
			typeof enItem === "string" ? enItem : enItem.value,
		);
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
	if (nameCn?.trim()) {
		return nameCn.trim();
	}
	const localized = work.localized;
	const enItem = localized?.en ?? localized?.["en-us"];
	if (enItem) {
		const enText = normalizeText(
			typeof enItem === "string" ? enItem : enItem.value,
		);
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

function pickIntroSummary(intros?: KunV1Intro[]): {
	summary?: string;
	language?: KunData["summary_language"];
} {
	if (!Array.isArray(intros)) return {};
	const priority = { unknown: 0, other: 1, en: 2, ja: 3, zh: 4 } as const;
	let best:
		| { summary: string; language: NonNullable<KunData["summary_language"]> }
		| undefined;

	for (const intro of intros) {
		const summary = normalizeText(intro.value);
		if (!summary) continue;
		const language = normalizeSummaryLanguage(intro.locale) ?? "unknown";
		if (!best || priority[language] > priority[best.language]) {
			best = { summary, language };
		}
	}

	return best ? { summary: best.summary, language: best.language } : {};
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

function normalizeExternalSourceId(
	source: "bgm" | "vndb",
	value?: string,
): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	if (source === "bgm") {
		return trimmed.match(/(?:subject\/|^)(\d+)\/?$/i)?.[1];
	}
	const id = trimmed.match(/(?:^|\/)(v?\d+)\/?$/i)?.[1];
	if (!id) return undefined;
	return id.toLowerCase().startsWith("v") ? id.toLowerCase() : `v${id}`;
}

function extractAssociatedSourceIds(
	refs?: KunV1ExternalRef[],
): KunData["associated_source_ids"] {
	const ids: NonNullable<KunData["associated_source_ids"]> = {};
	for (const ref of refs ?? []) {
		const site = ref.site?.trim().toLowerCase();
		const source =
			site === "vndb"
				? "vndb"
				: site === "bangumi" || site === "bgm" || site === "bgm.tv"
					? "bgm"
					: undefined;
		if (!source || ids[source]) continue;
		const id = normalizeExternalSourceId(source, ref.external_id);
		if (id) ids[source] = id;
	}
	return ids;
}

const transformKunV1Data = (
	work: KunV1WorkDetail,
	filterLevel: number,
): GameMetadataDraft => {
	const summary = pickIntroSummary(work.intros);
	const nameCn = pickChineseTitle(work.localized);
	const name = pickKunOriginalName(work, nameCn);
	const translatedName = pickKunTranslatedName(work, nameCn, name);
	const allTitles = extractAllTitles(
		work.display_name,
		work.localized,
		work.aliases,
	);

	const screenshots = (work.screenshots ?? [])
		.filter((s) => {
			const rating = String(s.image?.sexual ?? "")
				.toLowerCase()
				.trim();
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
		aliases: Array.from(
			new Set((work.aliases || []).map((a) => a.trim()).filter(Boolean)),
		),
		summary: summary.summary,
		summary_language: summary.language,
		associated_source_ids: extractAssociatedSourceIds(work.external_refs),
		tags: extractKunTags(work.tags, filterLevel),
		screenshots,
		developer: work.maker?.display_name?.trim() || undefined,
		nsfw: Boolean(work.is_nsfw || work.content_rating === "r18"),
		date: work.release_date ?? undefined,
	};

	const result: GameMetadataDraft = {
		...createGameCandidate({
			idType: "kun",
			source: createSourceCandidateRecord("kun", String(work.id), sourceData),
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
			const rating = String(shot.image?.sexual ?? "")
				.toLowerCase()
				.trim();
			return rating !== "2" && rating !== "explicit" && rating !== "r18";
		})
		.map((shot) => shot.image?.url?.trim())
		.filter((url): url is string => Boolean(url));
}

export async function fetchGalgameById(
	id: string,
	options: KunFetchOptions,
): Promise<GameMetadataDraft> {
	const { proxyUrl, signal, spoilerLevel } = options;
	const url = `${KUN_API_BASE}/works/${id}`;

	const resp = await http.get<KunV1WorkDetail>(
		url,
		buildKunRateLimitedOptions({
			signal,
			proxyUrl,
		}),
	);

	const work = resp.data;
	if (!work?.id) {
		throw new AppError({
			code: "metadata_not_found",
			message: `Kungal game not found: ${id}`,
		});
	}

	const kunResult = transformKunV1Data(work, spoilerLevel);
	return kunResult;
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

export interface UpdateKunUserWorkRecordPayload {
	work_state?: {
		state?: "doing" | "done" | "on_hold" | "dropped" | "wish";
		completion?: string | null;
	} | null;
	rating?: {
		overall?: number;
		recommend?: "strong_no" | "no" | "neutral" | "yes" | "strong_yes";
		short_summary?: string;
		spoiler_level?: "none" | "minor" | "major";
	} | null;
	playtime?: {
		minutes?: number;
	} | null;
}

export interface KunUserWorkRecord {
	work_id: string;
	work_state?: {
		state?: string;
		completion?: string | null;
	} | null;
	rating?: {
		overall?: number;
		short_summary?: string;
	} | null;
	playtime?: {
		minutes?: number;
	} | null;
}

export interface KunUserWorkRecordsPage {
	items?: KunUserWorkRecord[];
	next_cursor?: string | null;
}

export interface FetchKunUserWorkRecordsPageParams {
	cursor?: string;
	limit?: number;
}

/** Read the signed-in user's work records using the same v2 endpoint used by collection import. */
export async function fetchKunUserWorkRecordsPage(
	token: string,
	params: FetchKunUserWorkRecordsPageParams = {},
	options: TauriHttpOptions = {},
): Promise<KunUserWorkRecordsPage> {
	const searchParams = new URLSearchParams({
		limit: String(params.limit ?? 100),
	});
	if (params.cursor) {
		searchParams.set("cursor", params.cursor);
	}
	const url = `https://api.nextmoe.dev/v2/me/work-records?${searchParams.toString()}`;
	const headers = {
		Authorization: `Bearer ${token}`,
		Accept: "application/json",
	};

	try {
		const response = await window.fetch(url, {
			method: "GET",
			headers,
			signal: options.signal,
		});
		if (!response.ok) {
			const errorText = await response.text();
			throw new AppError({
				code: "kungal_collection_fetch_failed",
				message: `获取 KunGal 收藏记录失败 (${response.status}): ${errorText}`,
			});
		}
		return response.json();
	} catch (error) {
		if (isAbortError(error)) throw error;
		try {
			const fallbackResp = await http.get<KunUserWorkRecordsPage>(
				"https://api.nextmoe.dev/v2/me/work-records",
				{
					headers,
					params: Object.fromEntries(searchParams.entries()),
					signal: options.signal,
				},
			);
			return fallbackResp.data;
		} catch (fallbackError) {
			if (isAbortError(fallbackError)) throw fallbackError;
			throw error;
		}
	}
}

export async function updateKunUserWorkRecord(
	workId: string,
	payload: UpdateKunUserWorkRecordPayload,
	token: string,
	options: TauriHttpOptions = {},
): Promise<boolean> {
	const url = `https://api.nextmoe.dev/v2/me/work-records/${workId}`;
	try {
		const response = await window.fetch(url, {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
			signal: options.signal,
		});

		if (!response.ok) {
			const errorText = await response.text();
			let errorMessage = errorText;
			try {
				const errorJson = JSON.parse(errorText);
				if (errorJson.detail) {
					errorMessage = errorJson.detail;
				}
				if (Array.isArray(errorJson.errors) && errorJson.errors.length > 0) {
					errorMessage = errorJson.errors
						.map(
							(e: { pointer?: string; detail?: string }) =>
								`${e.pointer ?? ""}: ${e.detail ?? ""}`,
						)
						.join("; ");
				}
			} catch {}
			throw new AppError({
				code: "kun_push_failed",
				message: `KunGal 推送失败 (${response.status}): ${errorMessage}`,
			});
		}

		return true;
	} catch (error) {
		if (error instanceof AppError) throw error;
		// 备用：走 Tauri 原生 http
		await http.put(url, payload, {
			...options,
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/json",
				"Content-Type": "application/json",
				...options.headers,
			},
		});
		return true;
	}
}
