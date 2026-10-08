import { convertFileSrc } from "@tauri-apps/api/core";
import { join } from "pathe";
import { getFileExtension } from "@/services/game/customCover";
import { getDetailBackdropFolder } from "@/services/game/customCover";
import { fileService } from "@/services/invoke";
import type { CustomData } from "@/types";
import type { NextUpVirtualGame } from "@/store/appStore";
import { getcustomCoverFolder } from "@/utils/game";

export type NextUpAssetKind = "cover" | "banner" | "cg" | "detail";

function getNextUpAssetFolder(gameId: number): string {
	return getcustomCoverFolder(gameId);
}

function getNextUpAssetPath(
	gameId: number,
	kind: NextUpAssetKind,
	assetId: string,
): string {
	return join(
		getNextUpAssetFolder(gameId),
		`${kind}_${Math.abs(gameId)}_${assetId}`,
	);
}

export function getNextUpAssetUrl(
	game: NextUpVirtualGame,
	kind: "cover" | "banner",
): string | undefined {
	const assetId = kind === "cover" ? game.coverAsset : game.bannerAsset;
	if (!assetId) return undefined;

	try {
		return convertFileSrc(getNextUpAssetPath(game.id, kind, assetId));
	} catch (error) {
		console.error(`转换接下来玩${kind}路径失败:`, error);
		return undefined;
	}
}

export async function importNextUpAsset(
	gameId: number,
	kind: NextUpAssetKind,
	imagePath: string,
	previousAssetId?: string,
): Promise<string> {
	const extension = getFileExtension(imagePath) || "png";
	const assetId = `${extension}_${Date.now()}`;
	const destinationPath = getNextUpAssetPath(gameId, kind, assetId);

	await fileService.copyFile(imagePath, destinationPath);
	if (previousAssetId) {
		try {
			await fileService.deleteFile(
				getNextUpAssetPath(gameId, kind, previousAssetId),
			);
		} catch (error) {
			console.warn(`旧${kind}图片清理失败:`, error);
		}
	}

	return assetId;
}

export async function deleteNextUpAsset(
	gameId: number,
	kind: NextUpAssetKind,
	assetId?: string,
): Promise<void> {
	if (!assetId) return;
	await fileService.deleteFile(getNextUpAssetPath(gameId, kind, assetId));
}

/** 清理本地资源文件已丢失的心愿媒体引用，避免清盘后页面一直请求坏路径。 */
export async function pruneMissingNextUpAssets(
	game: NextUpVirtualGame,
): Promise<Partial<Omit<NextUpVirtualGame, "id">> | null> {
	const customData = game.customData ?? {};
	const nextCustomData: Partial<CustomData> = { ...customData };
	let changed = false;

	const exists = async (kind: NextUpAssetKind, identifier?: string) =>
		Boolean(identifier) &&
		(await fileService
			.fileExists(getNextUpAssetPath(game.id, kind, identifier!))
			.catch(() => false));

	const coverAsset = game.coverAsset ?? customData.image ?? undefined;
	const bannerAsset = game.bannerAsset ?? customData.banner ?? undefined;
	const hasCover = await exists("cover", coverAsset);
	const hasBanner = await exists("banner", bannerAsset);
	const hasBackdrop = await exists("detail", customData.detail_backdrop ?? undefined);

	if (coverAsset && !hasCover) {
		changed = true;
		nextCustomData.image = null;
	}
	if (bannerAsset && !hasBanner) {
		changed = true;
		nextCustomData.banner = null;
		nextCustomData.banner_focus = null;
	}
	if (customData.detail_backdrop && !hasBackdrop) {
		changed = true;
		nextCustomData.detail_backdrop = null;
		nextCustomData.detail_backdrop_focus = null;
	}

	const localCgs = (customData.cgs ?? []).filter((identifier) => !identifier.includes("://"));
	const missingLocalCgs = new Set(
		(
			await Promise.all(
				localCgs.map(async (identifier) =>
					(await exists("cg", identifier)) ? null : identifier,
				),
			)
		).filter((identifier): identifier is string => Boolean(identifier)),
	);
	if (missingLocalCgs.size > 0) {
		changed = true;
		nextCustomData.cgs = (customData.cgs ?? []).filter(
			(identifier) => !missingLocalCgs.has(identifier),
		);
	}

	const importedMap = customData.imported_screenshot_map ?? {};
	const keptImportedEntries = await Promise.all(
		Object.entries(importedMap).map(async ([url, identifier]) =>
			(await exists("cg", identifier)) ? ([url, identifier] as const) : null,
		),
	);
	if (keptImportedEntries.some((entry) => entry === null)) {
		changed = true;
		nextCustomData.imported_screenshot_map = Object.fromEntries(
			keptImportedEntries.filter((entry): entry is readonly [string, string] => Boolean(entry)),
		);
		nextCustomData.imported_screenshot_urls = (
			customData.imported_screenshot_urls ?? []
		).filter((url) => url in nextCustomData.imported_screenshot_map!);
	}

	if (!changed) return null;
	return {
		coverAsset: hasCover ? coverAsset : undefined,
		bannerAsset: hasBanner ? bannerAsset : undefined,
		customData: nextCustomData,
	};
}

export async function copyNextUpAssetsToLibrary(
	game: NextUpVirtualGame,
	libraryGameId: number,
): Promise<{ image?: string; banner?: string; customData: Partial<CustomData> }> {
	const destinationFolder = getcustomCoverFolder(libraryGameId);
	const detailDestinationFolder = await getDetailBackdropFolder(libraryGameId);
	const customData = game.customData ?? {};
	const copiedCustomData: Partial<CustomData> = {};
	let returnImage: string | undefined;
	let returnBanner: string | undefined;
	const coverAssetId = game.coverAsset || customData.image;

	if (coverAssetId) {
		await fileService.copyFile(
			getNextUpAssetPath(game.id, "cover", coverAssetId),
			join(destinationFolder, `cover_${libraryGameId}_${coverAssetId}`),
		);
		returnImage = coverAssetId;
	}

	const bannerAssetId = game.bannerAsset || customData.banner;
	if (bannerAssetId) {
		await fileService.copyFile(
			getNextUpAssetPath(game.id, "banner", bannerAssetId),
			join(destinationFolder, `banner_${libraryGameId}_${bannerAssetId}`),
		);
		returnBanner = bannerAssetId;
	}

	const localCgs = (customData.cgs ?? []).filter(
		(assetId) => !assetId.includes("://"),
	);
	if (localCgs.length > 0) {
		await Promise.all(
			localCgs.map((assetId) =>
				fileService.copyFile(
					getNextUpAssetPath(game.id, "cg", assetId),
					join(detailDestinationFolder, `cg_${libraryGameId}_${assetId}`),
				),
			),
		);
	}
	if ((customData.cgs ?? []).length > 0) {
		copiedCustomData.cgs = customData.cgs;
	}
	copiedCustomData.imported_screenshot_urls = customData.imported_screenshot_urls;
	copiedCustomData.imported_screenshot_map = customData.imported_screenshot_map;
	copiedCustomData.hidden_source_screenshots = customData.hidden_source_screenshots;

	if (customData.detail_backdrop) {
		await fileService.copyFile(
			getNextUpAssetPath(game.id, "detail", customData.detail_backdrop),
			join(detailDestinationFolder, `detail_${libraryGameId}_${customData.detail_backdrop}`),
		);
		copiedCustomData.detail_backdrop = customData.detail_backdrop;
		copiedCustomData.detail_backdrop_focus = customData.detail_backdrop_focus;
	}

	copiedCustomData.banner_focus = customData.banner_focus;
	return { image: returnImage, banner: returnBanner, customData: copiedCustomData };
}

export async function deleteNextUpAssets(
	game: NextUpVirtualGame,
): Promise<void> {
	const customData = game.customData ?? {};
	const coverAssetId = game.coverAsset || customData.image || undefined;
	const bannerAssetId = game.bannerAsset || customData.banner || undefined;
	await Promise.allSettled([
		deleteNextUpAsset(game.id, "cover", coverAssetId),
		deleteNextUpAsset(game.id, "banner", bannerAssetId),
		...(customData.cgs ?? []).map((assetId) =>
			deleteNextUpAsset(game.id, "cg", assetId),
		),
		deleteNextUpAsset(game.id, "detail", customData.detail_backdrop || undefined),
	]);
}
