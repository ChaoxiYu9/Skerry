import { convertFileSrc } from "@tauri-apps/api/core";
import { join } from "pathe";
import { getAppDataDirPath } from "@/services/fs/pathCache";
import type { GameData } from "@/types";
import { buildTauriProtocolUrl } from "@/utils/tauriProtocol";

const clampBannerFocus = (value: unknown): number => {
	const numeric =
		typeof value === "number" && Number.isFinite(value) ? value : 50;
	return Math.min(100, Math.max(0, numeric));
};

const getStorageGameId = (gameId: number): number =>
	gameId < 0 ? Math.abs(gameId) : gameId;

export const getGameDisplayName = (game: GameData): string => {
	return (
		game.custom_data?.translated_name ||
		game.custom_data?.name_cn ||
		game.name_cn ||
		game.custom_data?.name ||
		game.name ||
		""
	);
};

export const getcustomCoverFolder = (gameID: number): string => {
	const resourceFolder = getAppDataDirPath();
	const storageGameId = gameID < 0 ? Math.abs(gameID) : gameID;
	return join(resourceFolder, "covers", `game_${storageGameId}`);
};

export const getGameCover = (game: GameData): string => {
	if (game.custom_data?.cover_source && game.image) {
		const params = new URLSearchParams({
			url: game.image,
			v: String(game.updated_at ?? ""),
		});
		return buildTauriProtocolUrl(
			"reina-cover",
			String(getStorageGameId(game.id)),
			params,
		);
	}

	if (game.custom_data?.image) {
		const customCoverFolder = getcustomCoverFolder(game.id);
		if (customCoverFolder) {
			const customCoverPath = join(
				customCoverFolder,
				`cover_${getStorageGameId(game.id)}_${game.custom_data.image}`,
			);

			try {
				return convertFileSrc(customCoverPath);
			} catch (error) {
				console.error("转换自定义封面路径失败:", error);
			}
		}
	}

	if (game.image) {
		const params = new URLSearchParams({
			url: game.image,
			v: String(game.updated_at ?? ""),
		});
		return buildTauriProtocolUrl(
			"reina-cover",
			String(getStorageGameId(game.id)),
			params,
		);
	}

	return "/images/default.png";
};

/** Resolve a locally imported PotatoVN-style banner, falling back at call sites. */
export const getGameBanner = (game: GameData): string | null => {
	if (game.custom_data?.banner) {
		const bannerPath = join(
			getcustomCoverFolder(game.id),
			`banner_${getStorageGameId(game.id)}_${game.custom_data.banner}`,
		);
		try {
			return convertFileSrc(bannerPath);
		} catch (error) {
			console.error("转换游戏横幅路径失败:", error);
		}
	}
	return null;
};

/** Resolve the detail-page-only backdrop without affecting cards or home. */
export const getGameDetailBackdrop = (
	game: GameData,
	customRoot?: string | null,
): string | null => {
	if (!game.custom_data?.detail_backdrop) return null;

	const coverFolder = game.id < 0 || !customRoot
		? getcustomCoverFolder(game.id)
		: join(customRoot, "covers", `game_${game.id}`);
	const backdropPath = join(
		coverFolder,
		`detail_${getStorageGameId(game.id)}_${game.custom_data.detail_backdrop}`,
	);
	try {
		return convertFileSrc(backdropPath);
	} catch (error) {
		console.error("转换详情页底图路径失败:", error);
	}
	return null;
};

export const getGameBannerOrCover = (game: GameData): string =>
	getGameBanner(game) ?? getGameCover(game);

export const getGameBannerObjectPosition = (game: GameData): string => {
	const focus = game.custom_data?.banner_focus;
	if (!focus) return "center";
	return `
		${clampBannerFocus(focus.x)}% ${clampBannerFocus(focus.y)}%
	`.trim();
};

export const getGameNsfwStatus = (game: GameData): boolean => {
	return game.nsfw ?? isNsfwGame(game.tags || []);
};

export function applyNsfwFilter(
	data: GameData[],
	nsfwFilter: boolean,
): GameData[] {
	if (!nsfwFilter) {
		return data;
	}
	return data.filter((game) => !getGameNsfwStatus(game));
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: 允许 ASCII 范围检查
const ASCII_ONLY_RE = /^[\x00-\x7F]+$/;

function isNsfwGame(tags: string[]): boolean {
	if (tags.length === 0) return false;

	if (tags.some((tag) => tag.includes("R18") || tag === "拔作")) {
		return true;
	}

	const isAllEnglish = tags.every((tag) => ASCII_ONLY_RE.test(tag));
	return isAllEnglish && !tags.includes("No Sexual Content");
}
