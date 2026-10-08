import { unzipSync } from "fflate";
import { basename, join } from "pathe";
import type { FullGameData, GameSourceRecord, InsertGameParams } from "@/types";

export interface PotatoImportRecord {
	name: string;
	nameCn?: string;
	originalName?: string;
	description?: string;
	developer?: string;
	tags: string[];
	imagePath?: string;
	coverImage?: { name: string; bytes: Uint8Array };
	bannerImage?: { name: string; bytes: Uint8Array };
	ids: Partial<Record<"bgm" | "vndb" | "ymgal" | "steam", string>>;
	playedTime: Record<string, number>;
	lastPlayTime?: string;
	releaseDate?: string;
	comment?: string;
	myRate?: number;
	privateComment?: boolean;
	localPath?: string;
	executable?: string;
}

export interface PotatoImportPreview {
	fileName: string;
	total: number;
	importable: number;
	duplicates: number;
	withPlayHistory: number;
	warnings: string[];
	records: PotatoImportRecord[];
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function stringValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function nestedString(value: unknown): string | undefined {
	if (typeof value === "string") return stringValue(value);
	const record = asRecord(value);
	return stringValue(record.Value ?? record.value);
}

function stringArray(value: unknown): string[] {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const record = asRecord(value);
		return stringArray(record.Value ?? record.value);
	}
	if (Array.isArray(value))
		return value
			.map(stringValue)
			.filter((item): item is string => Boolean(item));
	if (typeof value === "string")
		return value
			.split(/[;,/]/)
			.map((item) => item.trim())
			.filter(Boolean);
	return [];
}

function numberValue(value: unknown): number | undefined {
	const number = typeof value === "number" ? value : Number(value);
	return Number.isFinite(number) ? number : undefined;
}

function normalizeDateKey(value: string): string | undefined {
	const trimmed = value.trim();
	const iso = /^(d{4})[-/.](d{1,2})[-/.](d{1,2})$/.exec(trimmed);
	if (!iso) return undefined;
	const year = Number(iso[1]);
	const month = Number(iso[2]);
	const day = Number(iso[3]);
	if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
	return (
		year +
		"-" +
		String(month).padStart(2, "0") +
		"-" +
		String(day).padStart(2, "0")
	);
}

function normalizeZipPath(value: string): string {
	return value
		.replaceAll("\\", "/")
		.replace(/^\.\//, "")
		.replace(/^\//, "")
		.toLowerCase();
}

function readJsonFromBytes(bytes: Uint8Array): unknown {
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return null;
	}
}

function readJson(
	files: Record<string, Uint8Array>,
	fileName: string,
): unknown {
	const entry = Object.entries(files).find(
		([name]) =>
			name.toLowerCase() === fileName.toLowerCase() ||
			name.toLowerCase().endsWith("/" + fileName.toLowerCase()),
	);
	if (!entry) return null;
	return readJsonFromBytes(entry[1]);
}

function readImageEntry(
	files: Record<string, Uint8Array>,
	pathValue: string | undefined,
): { name: string; bytes: Uint8Array } | undefined {
	if (!pathValue) return undefined;
	const normalized = normalizeZipPath(pathValue);
	const targetFileName = normalized.split("/").at(-1)?.toLowerCase();
	if (!targetFileName) return undefined;

	const entry = Object.entries(files).find(([name]) => {
		const candidate = normalizeZipPath(name);
		return (
			candidate === normalized ||
			candidate.endsWith("/" + targetFileName) ||
			candidate === targetFileName
		);
	});
	return entry ? { name: entry[0], bytes: entry[1] } : undefined;
}

function readId(ids: unknown[], index: number): string | undefined {
	return stringValue(ids[index]);
}

interface SourceLinkInfo {
	localPath?: string;
	executable?: string;
}

function parseSourcesJson(raw: unknown): Map<string, SourceLinkInfo> {
	const map = new Map<string, SourceLinkInfo>();
	if (!Array.isArray(raw)) return map;
	for (const sourceItem of raw) {
		const galgames = asRecord(sourceItem).Galgames;
		if (!Array.isArray(galgames)) continue;
		for (const gal of galgames) {
			const g = asRecord(gal);
			const uuid = stringValue(g.Galgame)?.toLowerCase();
			const gamePath = stringValue(g.Path);
			const localCfg = asRecord(g.LocalConfig);
			const exePath = stringValue(localCfg.ExePath);
			if (uuid && (gamePath || exePath)) {
				map.set(uuid, {
					localPath: gamePath,
					executable: exePath,
				});
			}
		}
	}
	return map;
}

function resolvePotatoIds(
	item: Record<string, unknown>,
): Partial<Record<"bgm" | "vndb" | "ymgal" | "steam", string>> {
	const rawIds = Array.isArray(item.Ids)
		? item.Ids
		: Array.isArray(item.ids)
			? item.ids
			: [];

	const resolved: Partial<Record<"bgm" | "vndb" | "ymgal" | "steam", string>> = {
		vndb: readId(rawIds, 0),
		bgm: readId(rawIds, 1),
		ymgal: readId(rawIds, 5),
		steam: readId(rawIds, 7),
	};

	// 1. 深度解析 PotatoVN 混合源复合键（存放在 rawIds[2]，形如 "bgm:44123,vndb:10680,ymgal:null,steam:null"）
	const compositeStr = stringValue(rawIds[2]);
	if (compositeStr && compositeStr.includes(":")) {
		const pairs = compositeStr.split(",");
		for (const pair of pairs) {
			const [provider, val] = pair.split(":").map((s) => s?.trim());
			if (
				provider &&
				val &&
				val !== "null" &&
				val !== "undefined" &&
				val.length > 0
			) {
				const p = provider.toLowerCase();
				if (p === "bgm" && !resolved.bgm) resolved.bgm = val;
				if (p === "vndb" && !resolved.vndb)
					resolved.vndb = val.replace(/^v/i, "");
				if (p === "ymgal" && !resolved.ymgal) resolved.ymgal = val;
				if (p === "steam" && !resolved.steam) resolved.steam = val;
			}
		}
	}

	// 2. 解析插件扩展源（IdForPlugins）
	const plugins = asRecord(item.IdForPlugins ?? item.idForPlugins);
	for (const [key, val] of Object.entries(plugins)) {
		const k = key.toLowerCase();
		const v = stringValue(val);
		if (v && v !== "null" && v !== "undefined") {
			if (k.includes("bgm") && !resolved.bgm) resolved.bgm = v;
			if (k.includes("vndb") && !resolved.vndb)
				resolved.vndb = v.replace(/^v/i, "");
			if (k.includes("ymgal") && !resolved.ymgal) resolved.ymgal = v;
			if (k.includes("steam") && !resolved.steam) resolved.steam = v;
		}
	}

	if (resolved.vndb) {
		resolved.vndb = resolved.vndb.replace(/^v/i, "");
	}

	return resolved;
}

function parseRecord(
	value: unknown,
	lookupImage: (
		pathValue: string | undefined,
	) => { name: string; bytes: Uint8Array } | undefined,
	sourcesMap?: Map<string, SourceLinkInfo>,
): PotatoImportRecord | null {
	const item = asRecord(value);
	const name =
		nestedString(item.Name) ??
		nestedString(item.name) ??
		nestedString(item.OriginalName);
	if (!name) return null;

	const playedTimeValue = item.PlayedTime ?? item.playedTime;
	const playedTime: Record<string, number> = {};
	if (playedTimeValue && typeof playedTimeValue === "object") {
		for (const [date, minutes] of Object.entries(asRecord(playedTimeValue))) {
			const numeric = numberValue(minutes);
			const normalizedDate = normalizeDateKey(date);
			if (normalizedDate && numeric && numeric > 0)
				playedTime[normalizedDate] = Math.round(numeric);
		}
	}

	const uuid = stringValue(item.Uuid ?? item.uuid)?.toLowerCase();
	const sourceInfo = uuid ? sourcesMap?.get(uuid) : undefined;

	const coverPath = nestedString(item.ImagePath ?? item.imagePath);
	const headerPath = nestedString(item.HeaderImagePath ?? item.headerImagePath);

	return {
		name,
		nameCn:
			stringValue(item.CnName ?? item.cnName) ??
			nestedString(item.ChineseName ?? item.chineseName),
		originalName: nestedString(item.OriginalName ?? item.originalName),
		description: nestedString(item.Description ?? item.description),
		developer: nestedString(item.Developer ?? item.developer),
		tags: stringArray(item.Tags ?? item.tags),
		imagePath: coverPath,
		coverImage: lookupImage(coverPath),
		bannerImage: lookupImage(headerPath),
		ids: resolvePotatoIds(item),
		playedTime,
		lastPlayTime: stringValue(item.LastPlayTime ?? item.lastPlayTime),
		releaseDate: nestedString(item.ReleaseDate ?? item.releaseDate),
		comment: stringValue(item.Comment ?? item.comment),
		myRate: numberValue(item.MyRate ?? item.myRate),
		privateComment: Boolean(item.PrivateComment ?? item.privateComment),
		localPath: stringValue(
			item.LocalPath ??
				item.localPath ??
				item.Path ??
				item.path ??
				sourceInfo?.localPath,
		),
		executable: stringValue(
			item.ExePath ??
				item.exePath ??
				item.Executable ??
				item.executable ??
				sourceInfo?.executable,
		),
	};
}

function buildPreviewResult(
	fileName: string,
	values: unknown,
	records: PotatoImportRecord[],
): PotatoImportPreview {
	const warnings: string[] = [];
	if (!Array.isArray(values))
		warnings.push("数据包中没有可识别的 data.galgames.json");

	const coversCount = records.filter((r) => Boolean(r.coverImage)).length;
	const bannersCount = records.filter((r) => Boolean(r.bannerImage)).length;
	const sourcesFoundCount = records.filter((r) =>
		Object.values(r.ids).some(Boolean),
	).length;
	const localPathsCount = records.filter((r) =>
		Boolean(r.localPath || r.executable),
	).length;

	if (coversCount > 0)
		warnings.push(
			`已成功识别 ${coversCount} 款游戏的原生高清封面，导入后直接本地化存储`,
		);
	if (bannersCount > 0)
		warnings.push(
			`已成功识别 ${bannersCount} 款游戏的原生横幅图，导入后优先展示横幅`,
		);
	if (sourcesFoundCount > 0)
		warnings.push(
			`已解析 ${sourcesFoundCount} 款游戏的多平台数据源编号（涵盖 Bangumi/VNDB/YMgal/Steam）`,
		);
	if (localPathsCount > 0)
		warnings.push(
			`已联动还原 ${localPathsCount} 款游戏的本地安装目录与启动项路径`,
		);

	const withPlayHistory = records.filter(
		(record) => Object.keys(record.playedTime).length > 0,
	).length;

	return {
		fileName,
		total: Array.isArray(values) ? values.length : 0,
		importable: records.length,
		duplicates: 0,
		withPlayHistory,
		warnings,
		records,
	};
}

export function readPotatoFiles(
	fileName: string,
	files: Record<string, Uint8Array>,
): PotatoImportPreview {
	const sourcesRaw = readJson(files, "data.galgameSources.json");
	const sourcesMap = parseSourcesJson(sourcesRaw);

	const raw = readJson(files, "data.galgames.json");
	const values = Array.isArray(raw) ? raw : asRecord(raw).items;
	const records = Array.isArray(values)
		? values
				.map((item) =>
					parseRecord(item, (pathVal) => readImageEntry(files, pathVal), sourcesMap),
				)
				.filter((item): item is PotatoImportRecord => Boolean(item))
		: [];

	return buildPreviewResult(fileName, values, records);
}

export function readPotatoExport(
	fileName: string,
	bytes: Uint8Array | Record<string, Uint8Array>,
): PotatoImportPreview {
	if (!(bytes instanceof Uint8Array)) {
		return readPotatoFiles(fileName, bytes);
	}
	let files: Record<string, Uint8Array>;
	try {
		files = unzipSync(bytes);
	} catch {
		return {
			fileName,
			total: 0,
			importable: 0,
			duplicates: 0,
			withPlayHistory: 0,
			warnings: ["无法读取压缩包文件，请确认是否为有效的 ZIP 或 pvnExport 格式"],
			records: [],
		};
	}
	return readPotatoFiles(fileName, files);
}

/**
 * 从本地已解压的 PotatoVN 文件夹高效读取
 */
export async function readPotatoFromFolder(
	folderPath: string,
	readFileBytes: (path: string) => Promise<Uint8Array>,
	listFiles: (path: string) => Promise<string[]>,
): Promise<PotatoImportPreview> {
	const fileNames = await listFiles(folderPath);
	const normalizedMap = new Map<string, string>();
	for (const f of fileNames) {
		const norm = normalizeZipPath(f);
		normalizedMap.set(norm, f);
		const base = norm.split("/").at(-1);
		if (base && !normalizedMap.has(base)) normalizedMap.set(base, f);
	}

	const galgamesRel =
		normalizedMap.get("data.galgames.json") ??
		fileNames.find((f) => f.toLowerCase().endsWith("data.galgames.json"));
	if (!galgamesRel) {
		return {
			fileName: basename(folderPath),
			total: 0,
			importable: 0,
			duplicates: 0,
			withPlayHistory: 0,
			warnings: ["所选文件夹中未找到 data.galgames.json，请确认是否为导出的文件夹"],
			records: [],
		};
	}

	const galgamesBytes = await readFileBytes(join(folderPath, galgamesRel));
	const galgamesRaw = readJsonFromBytes(galgamesBytes);
	const values = Array.isArray(galgamesRaw)
		? galgamesRaw
		: asRecord(galgamesRaw).items;

	let sourcesRaw: unknown = null;
	const sourcesRel =
		normalizedMap.get("data.galgamesources.json") ??
		fileNames.find((f) =>
			f.toLowerCase().endsWith("data.galgamesources.json"),
		);
	if (sourcesRel) {
		try {
			const sourcesBytes = await readFileBytes(join(folderPath, sourcesRel));
			sourcesRaw = readJsonFromBytes(sourcesBytes);
		} catch {
			// ignore sources read failure
		}
	}
	const sourcesMap = parseSourcesJson(sourcesRaw);

	// 仅缓存已成功按需读取的图片
	const imageBytesCache = new Map<
		string,
		{ name: string; bytes: Uint8Array } | null
	>();

	async function fetchImageOnDemand(
		pathVal?: string,
	): Promise<{ name: string; bytes: Uint8Array } | undefined> {
		if (!pathVal) return undefined;
		const norm = normalizeZipPath(pathVal);
		const targetFileName = norm.split("/").at(-1)?.toLowerCase();
		if (!targetFileName) return undefined;

		const matchedRel =
			normalizedMap.get(norm) ??
			(targetFileName ? normalizedMap.get(targetFileName) : undefined);
		if (!matchedRel) return undefined;

		if (imageBytesCache.has(matchedRel)) {
			return imageBytesCache.get(matchedRel) ?? undefined;
		}

		try {
			const bytes = await readFileBytes(join(folderPath, matchedRel));
			const res = { name: matchedRel, bytes };
			imageBytesCache.set(matchedRel, res);
			return res;
		} catch {
			imageBytesCache.set(matchedRel, null);
			return undefined;
		}
	}

	const records: PotatoImportRecord[] = [];
	if (Array.isArray(values)) {
		for (const item of values) {
			const baseRecord = parseRecord(item, () => undefined, sourcesMap);
			if (!baseRecord) continue;

			// 按需读取封面与横幅
			const coverPath = nestedString(asRecord(item).ImagePath ?? asRecord(item).imagePath);
			const headerPath = nestedString(asRecord(item).HeaderImagePath ?? asRecord(item).headerImagePath);

			baseRecord.coverImage = await fetchImageOnDemand(coverPath);
			baseRecord.bannerImage = await fetchImageOnDemand(headerPath);
			records.push(baseRecord);
		}
	}

	return buildPreviewResult(basename(folderPath), values, records);
}

/**
 * 从浏览器 Web 目录选择（FileList / webkitdirectory）读取
 */
export async function readPotatoFromWebFiles(
	files: FileList | File[],
): Promise<PotatoImportPreview> {
	const fileList = Array.from(files);
	const fileMap = new Map<string, File>();
	for (const f of fileList) {
		const rel = f.webkitRelativePath || f.name;
		const norm = normalizeZipPath(rel);
		fileMap.set(norm, f);
		const base = norm.split("/").at(-1);
		if (base && !fileMap.has(base)) fileMap.set(base, f);
	}

	const galgamesFile =
		fileMap.get("data.galgames.json") ??
		fileList.find((f) => f.name.toLowerCase() === "data.galgames.json");

	if (!galgamesFile) {
		return {
			fileName: "PotatoVN Export",
			total: 0,
			importable: 0,
			duplicates: 0,
			withPlayHistory: 0,
			warnings: ["所选目录中未找到 data.galgames.json"],
			records: [],
		};
	}

	const galgamesBytes = new Uint8Array(await galgamesFile.arrayBuffer());
	const galgamesRaw = readJsonFromBytes(galgamesBytes);
	const values = Array.isArray(galgamesRaw)
		? galgamesRaw
		: asRecord(galgamesRaw).items;

	let sourcesRaw: unknown = null;
	const sourcesFile =
		fileMap.get("data.galgamesources.json") ??
		fileList.find((f) => f.name.toLowerCase() === "data.galgamesources.json");
	if (sourcesFile) {
		try {
			const sourcesBytes = new Uint8Array(await sourcesFile.arrayBuffer());
			sourcesRaw = readJsonFromBytes(sourcesBytes);
		} catch {
			// ignore
		}
	}
	const sourcesMap = parseSourcesJson(sourcesRaw);

	const imageBytesCache = new Map<string, { name: string; bytes: Uint8Array }>();

	async function fetchImage(
		pathVal?: string,
	): Promise<{ name: string; bytes: Uint8Array } | undefined> {
		if (!pathVal) return undefined;
		const norm = normalizeZipPath(pathVal);
		const targetFileName = norm.split("/").at(-1)?.toLowerCase();
		if (!targetFileName) return undefined;

		const f = fileMap.get(norm) ?? (targetFileName ? fileMap.get(targetFileName) : undefined);
		if (!f) return undefined;

		const key = f.webkitRelativePath || f.name;
		if (imageBytesCache.has(key)) return imageBytesCache.get(key);

		try {
			const bytes = new Uint8Array(await f.arrayBuffer());
			const res = { name: key, bytes };
			imageBytesCache.set(key, res);
			return res;
		} catch {
			return undefined;
		}
	}

	const records: PotatoImportRecord[] = [];
	if (Array.isArray(values)) {
		for (const item of values) {
			const baseRecord = parseRecord(item, () => undefined, sourcesMap);
			if (!baseRecord) continue;

			const coverPath = nestedString(asRecord(item).ImagePath ?? asRecord(item).imagePath);
			const headerPath = nestedString(asRecord(item).HeaderImagePath ?? asRecord(item).headerImagePath);

			baseRecord.coverImage = await fetchImage(coverPath);
			baseRecord.bannerImage = await fetchImage(headerPath);
			records.push(baseRecord);
		}
	}

	return buildPreviewResult("PotatoVN Export", values, records);
}

function normalizeTitle(value: string): string {
	return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function sourceRecords(record: PotatoImportRecord): GameSourceRecord[] {
	return Object.entries(record.ids)
		.filter((entry): entry is ["bgm" | "vndb" | "ymgal" | "steam", string] =>
			Boolean(entry[1]),
		)
		.map(([source, external_id]) => ({ source, external_id, data: null }));
}

export function toInsertGame(record: PotatoImportRecord): InsertGameParams {
	const id_type = record.ids.bgm
		? "bgm"
		: record.ids.vndb
			? "vndb"
			: record.ids.ymgal
				? "ymgal"
				: record.ids.steam
					? "steam"
					: "custom";

	return {
		id_type,
		sources: sourceRecords(record),
		date: record.releaseDate,
		localpath: record.localPath,
		executable: record.executable,
		custom_data: {
			name: record.name,
			name_cn: record.nameCn,
			aliases: [record.nameCn, record.originalName].filter(
				(value): value is string => Boolean(value),
			),
			summary: record.description,
			developer: record.developer,
			tags: record.tags,
			user_rating: record.myRate,
			user_review: record.comment,
		},
	};
}

export function findDuplicate(
	record: PotatoImportRecord,
	games: readonly FullGameData[],
): FullGameData | null {
	for (const game of games) {
		for (const source of sourceRecords(record)) {
			if (
				game.sources.some(
					(item) =>
						item.source === source.source &&
						item.external_id === source.external_id,
				)
			)
				return game;
		}
		const name = game.custom_data?.name;
		if (name && normalizeTitle(name) === normalizeTitle(record.name))
			return game;
	}
	return null;
}

export function buildSessionEntries(
	gameId: number,
	record: PotatoImportRecord,
): Array<{ gameId: number; startTime: number; duration: number }> {
	return Object.entries(record.playedTime)
		.map(([date, duration]) => ({
			gameId,
			startTime: Math.floor(
				new Date(date.concat("T00:01:00")).getTime() / 1000,
			),
			duration,
		}))
		.filter((entry) => Number.isFinite(entry.startTime) && entry.duration > 0);
}
