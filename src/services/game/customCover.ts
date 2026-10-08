/**
 * @file 自定义封面工具
 * @description 处理自定义封面的选择、预览、上传和管理
 */

import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { basename, join } from "pathe";
import { fileService } from "@/services/invoke";
import { fetchAllSettings } from "@/hooks/queries/useSettings";
import { queryClient } from "@/providers/queryClient";
import { toError } from "@/utils/errors";
import { getcustomCoverFolder } from "@/utils/game";

/**
 * 获取文件扩展名
 */
export const getFileExtension = (filename: string): string => {
	const lastDot = filename.lastIndexOf(".");
	return lastDot !== -1 ? filename.substring(lastDot + 1).toLowerCase() : "";
};

const getStorageGameId = (gameId: number): number =>
	gameId < 0 ? Math.abs(gameId) : gameId;

export const getDetailBackdropFolder = async (gameId: number): Promise<string> => {
	try {
		if (gameId < 0) {
			return getcustomCoverFolder(gameId);
		}
		const settings = await fetchAllSettings(queryClient);
		const customRoot = settings.detail_backdrop_path;
		if (customRoot) {
			return join(customRoot, "covers", `game_${gameId}`);
		}
	} catch (error) {
		console.warn("读取底图保存路径失败，回退默认目录:", error);
	}
	return getcustomCoverFolder(gameId);
};

/** CG 保存后的最长边上限（超过则等比缩小并转 JPEG）。 */
export const CG_MAX_SIDE = 1600;
/** 横幅/底图保存后的最长边上限，保留足够的 1080p 展示清晰度。 */
export const MEDIA_MAX_SIDE = 2560;

const loadImageElement = (assetUrl: string): Promise<HTMLImageElement> =>
	new Promise((resolve, reject) => {
		const image = new Image();
		image.crossOrigin = "anonymous";
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error("CG_IMAGE_LOAD_FAILED"));
		image.src = assetUrl;
	});

const getUrlImageExtension = (url: string): string => {
	try {
		const pathname = new URL(url).pathname;
		const extension = getFileExtension(pathname);
		return ["png", "jpg", "jpeg", "webp", "gif"].includes(extension)
			? extension
			: "";
	} catch {
		return "";
	}
};

const getContentTypeImageExtension = (contentType?: string): string => {
	const type = contentType?.split(";")[0]?.trim().toLowerCase();
	if (type === "image/png") return "png";
	if (type === "image/webp") return "webp";
	if (type === "image/gif") return "gif";
	return type === "image/jpeg" ? "jpg" : "";
};

const saveCgBytes = async (
	gameId: number,
	folder: string,
	blob: Blob,
	extension: string,
	index: number,
	maxSide = CG_MAX_SIDE,
	prefix = "cg",
): Promise<string> => {
	if (extension !== "gif") {
		try {
			const objectUrl = URL.createObjectURL(blob);
			try {
				const image = await loadImageElement(objectUrl);
				const longestSide = Math.max(image.naturalWidth, image.naturalHeight);
				if (longestSide > maxSide) {
					const scale = maxSide / longestSide;
					const canvas = document.createElement("canvas");
					canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
					canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
					const context = canvas.getContext("2d");
					if (!context) throw new Error("CG_CANVAS_UNAVAILABLE");
					context.drawImage(image, 0, 0, canvas.width, canvas.height);
					const encoded = await new Promise<Blob | null>((resolve) =>
						canvas.toBlob((result) => resolve(result), "image/jpeg", 0.85),
					);
					if (!encoded) throw new Error("CG_IMAGE_ENCODE_FAILED");
					const identifier = `${prefix === "cg" ? "jpg" : extension}_${Date.now() + index}`;
					await fileService.writeFileBytes(
						join(folder, `${prefix}_${getStorageGameId(gameId)}_${identifier}`),
						new Uint8Array(await encoded.arrayBuffer()),
					);
					return identifier;
				}
			} finally {
				URL.revokeObjectURL(objectUrl);
			}
		} catch (error) {
			if (error instanceof Error && error.message !== "CG_IMAGE_LOAD_FAILED") {
				throw error;
			}
		}
	}

	const identifier = `${extension}_${Date.now() + index}`;
	await fileService.writeFileBytes(
		join(folder, `${prefix}_${getStorageGameId(gameId)}_${identifier}`),
		new Uint8Array(await blob.arrayBuffer()),
	);
	return identifier;
};

/**
 * 复制本地图片为横幅资源；大图等比缩小，避免封面放大模糊。
 */
export const saveLocalImageAsset = async (
	gameId: number,
	sourcePath: string,
	kind: "banner" | "detail" = "banner",
): Promise<string> => {
	const folder =
		kind === "banner" ? getcustomCoverFolder(gameId) : await getDetailBackdropFolder(gameId);
	const prefix = kind === "banner" ? "banner" : "detail";
	const extension = (getFileExtension(sourcePath) || "jpg").toLowerCase();

	if (extension !== "gif") {
		try {
			const image = await loadImageElement(convertFileSrc(sourcePath));
			const longestSide = Math.max(image.naturalWidth, image.naturalHeight);
			if (longestSide > MEDIA_MAX_SIDE) {
				const scale = MEDIA_MAX_SIDE / longestSide;
				const canvas = document.createElement("canvas");
				canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
				canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
				const context = canvas.getContext("2d");
				if (!context) throw new Error("IMAGE_CANVAS_UNAVAILABLE");
				context.drawImage(image, 0, 0, canvas.width, canvas.height);
				const blob = await new Promise<Blob | null>((resolve) =>
					canvas.toBlob((result) => resolve(result), "image/jpeg", 0.88),
				);
				if (!blob) throw new Error("IMAGE_ENCODE_FAILED");
				const identifier = `jpg_${Date.now()}`;
				await fileService.writeFileBytes(
					join(folder, `${prefix}_${getStorageGameId(gameId)}_${identifier}`),
					new Uint8Array(await blob.arrayBuffer()),
				);
				return identifier;
			}
		} catch (error) {
			if (error instanceof Error && error.message !== "CG_IMAGE_LOAD_FAILED") {
				throw error;
			}
			console.warn("读取图片失败，回退为原样复制:", error);
		}
	}

	const identifier = `${extension}_${Date.now()}`;
	await fileService.copyFile(
		sourcePath,
		join(folder, `${prefix}_${getStorageGameId(gameId)}_${identifier}`),
	);
	return identifier;
};

/**
 * 把单张本地 CG 复制/压缩到底图保存目录，返回版本化标识符。
 * 大图等比缩小到 CG_MAX_SIDE 内并转 JPEG；小图和 GIF 原样复制。
 */
const saveCgFile = async (
	gameId: number,
	folder: string,
	sourcePath: string,
	index: number,
): Promise<string> => {
	const extension = (getFileExtension(sourcePath) || "jpg").toLowerCase();
	const timestamp = Date.now() + index;

	if (extension !== "gif") {
		try {
			const image = await loadImageElement(convertFileSrc(sourcePath));
			const longestSide = Math.max(image.naturalWidth, image.naturalHeight);
			if (longestSide > CG_MAX_SIDE) {
				const scale = CG_MAX_SIDE / longestSide;
				const canvas = document.createElement("canvas");
				canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
				canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
				const context = canvas.getContext("2d");
				if (!context) throw new Error("CG_CANVAS_UNAVAILABLE");
				context.drawImage(image, 0, 0, canvas.width, canvas.height);
				const blob = await new Promise<Blob | null>((resolve) =>
					canvas.toBlob((result) => resolve(result), "image/jpeg", 0.85),
				);
				if (!blob) throw new Error("CG_IMAGE_ENCODE_FAILED");
				const identifier = `jpg_${timestamp}`;
				const targetPath = join(folder, `cg_${getStorageGameId(gameId)}_${identifier}`);
				await fileService.writeFileBytes(
					targetPath,
					new Uint8Array(await blob.arrayBuffer()),
				);
				return identifier;
			}
		} catch (error) {
			if (error instanceof Error && error.message !== "CG_IMAGE_LOAD_FAILED") {
				throw error;
			}
			console.warn("读取 CG 图片失败，回退为原样复制:", error);
		}
	}

	const identifier = `${extension}_${timestamp}`;
	const targetPath = join(folder, `cg_${getStorageGameId(gameId)}_${identifier}`);
	await fileService.copyFile(sourcePath, targetPath);
	return identifier;
};

/**
 * 批量导入本地 CG：复制/压缩到底图保存目录，返回写入 cgs 的标识符列表。
 */
export const uploadSelectedCgs = async (
	gameId: number,
	paths: string[],
): Promise<string[]> => {
	const folder = await getDetailBackdropFolder(gameId);
	const identifiers: string[] = [];
	for (const [index, path] of paths.entries()) {
		identifiers.push(await saveCgFile(gameId, folder, path, index));
	}
	return identifiers;
};

/**
 * 下载在线截图并保存到底图目录，返回写入 cgs 的标识符列表。
 */
export const saveRemoteCgs = async (
	gameId: number,
	urls: string[],
): Promise<string[]> => {
	const folder = await getDetailBackdropFolder(gameId);
	const identifiers: string[] = [];
	for (const [index, url] of urls.entries()) {
		const response = await tauriFetch(url);
		if (!response.ok) {
			throw new Error(`CG_REMOTE_DOWNLOAD_FAILED_${response.status}`);
		}
		const extension =
			getUrlImageExtension(url) ||
			getContentTypeImageExtension(response.headers.get("content-type") ?? undefined) ||
			"jpg";
		identifiers.push(
			await saveCgBytes(gameId, folder, await response.blob(), extension, index),
		);
	}
	return identifiers;
};

/**
 * 下载在线图片并保存为横幅或详情页底图；画廊里的原 CG 仍保留。
 */
export const saveRemoteImageAsset = async (
	gameId: number,
	url: string,
	kind: "banner" | "detail",
): Promise<string> => {
	const folder =
		kind === "banner" ? getcustomCoverFolder(gameId) : await getDetailBackdropFolder(gameId);
	const response = await tauriFetch(url);
	if (!response.ok) {
		throw new Error(`IMAGE_REMOTE_DOWNLOAD_FAILED_${response.status}`);
	}
	const extension =
		getUrlImageExtension(url) ||
		getContentTypeImageExtension(response.headers.get("content-type") ?? undefined) ||
		"jpg";
	return saveCgBytes(
		gameId,
		folder,
		await response.blob(),
		extension,
		0,
		MEDIA_MAX_SIDE,
		kind === "banner" ? "banner" : "detail",
	);
};

/**
 * 复用一张已导入的 CG 作为横幅或详情页底图；不会从画廊删除这张 CG。
 */
export const promoteCgAsset = async (
	gameId: number,
	identifier: string,
	kind: "banner" | "detail",
): Promise<string> => {
	if (identifier.includes("://")) {
		throw new Error("仅支持将本地 CG 设为横幅或底图");
	}
	const sourceFolder = await getDetailBackdropFolder(gameId);
	const sourcePath = join(sourceFolder, `cg_${getStorageGameId(gameId)}_${identifier}`);
	if (!sourcePath) {
		throw new Error("CG 资源路径无效");
	}

	const targetFolder =
		kind === "banner" ? getcustomCoverFolder(gameId) : sourceFolder;
	const extension = getFileExtension(identifier) || "jpg";
	const nextIdentifier = `${extension}_${Date.now()}`;
	const targetPath = join(
		targetFolder,
		`${kind === "banner" ? "banner" : "detail"}_${getStorageGameId(gameId)}_${nextIdentifier}`,
	);
	await fileService.copyFile(sourcePath, targetPath);
	return nextIdentifier;
};

const deleteOldAsset = async (
	gameId: number,
	kind: "banner" | "detail",
	identifier: string | null | undefined,
	nextIdentifier: string,
) => {
	if (!identifier || identifier === nextIdentifier) return;
	const folder =
		kind === "banner" ? getcustomCoverFolder(gameId) : await getDetailBackdropFolder(gameId);
	const prefix = kind === "banner" ? "banner" : "detail";
	await fileService
		.deleteFile(join(folder, `${prefix}_${getStorageGameId(gameId)}_${identifier}`))
		.catch((error) => console.warn("删除旧图片资源失败:", error));
};

/**
 * 将 CG 或在线截图写入指定图片资源并返回更新后的 custom_data 字段。
 */
export const saveGalleryImageAs = async (
	gameId: number,
	source:
		| { type: "cg"; identifier: string }
		| { type: "local"; path: string }
		| { type: "remote"; url: string },
	kind: "banner" | "detail",
	currentIdentifier: string | null | undefined,
): Promise<string> => {
	const identifier =
		source.type === "cg"
			? await promoteCgAsset(gameId, source.identifier, kind)
			: source.type === "local"
				? await saveLocalImageAsset(gameId, source.path, kind)
			: await saveRemoteImageAsset(gameId, source.url, kind);
	await deleteOldAsset(gameId, kind, currentIdentifier, identifier);
	return identifier;
};

/**
 * 把 cgs 里的条目解析为可显示的图片地址。
 * 旧版本直接存 asset URL 原样返回；新版本存标识符，按底图目录解析。
 */
export const getCgIdentifierUrl = (
	gameId: number,
	entry: string,
	customRoot?: string | null,
): string => {
	if (entry.includes("://")) return entry;
	const folder =
		gameId < 0 || !customRoot
			? getcustomCoverFolder(gameId)
			: join(customRoot, "covers", `game_${gameId}`);
	return convertFileSrc(join(folder, `cg_${getStorageGameId(gameId)}_${entry}`));
};

/**
 * 选择图片文件（仅选择，不上传）
 * @returns Promise<string | null> 选择的图片文件路径或null
 */
export const selectImageFile = async (): Promise<string | null> => {
	try {
		const selected = await open({
			title: "选择自定义封面",
			multiple: false,
			directory: false,
			filters: [
				{
					name: "图片文件",
					extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
				},
			],
		});
		if (!selected || Array.isArray(selected)) return null;

		return selected as string;
	} catch (error) {
		console.error("选择图片文件失败:", error);
		throw error;
	}
};

/**
 * 删除指定游戏现有的所有自定义封面文件
 * @param gameId 游戏ID
 */
export const deleteGameCustomCovers = async (gameId: number): Promise<void> => {
	const customCoverFolder = getcustomCoverFolder(gameId);

	try {
		await fileService.deleteGameCovers(gameId, customCoverFolder);
	} catch (error) {
		throw new Error(
			`Custom cover delete failed: ${toError(error, "Custom cover delete failed").message}`,
		);
	}
};

/**
 * 上传已选择的图片文件到应用目录
 * @param gameId 游戏ID
 * @param imagePath 已选择的图片文件路径
 * @returns 包含版本信息的文件标识符
 */
export const uploadSelectedImage = async (
	gameId: number,
	imagePath: string,
): Promise<string> => {
	try {
		const fileName = basename(imagePath);
		const extension = getFileExtension(fileName);

		// 获取应用资源目录（使用缓存的路径）
		const customCoverFolder = getcustomCoverFolder(gameId);
		if (!customCoverFolder) {
			throw new Error("资源目录路径未初始化");
		}

		// 生成版本化的文件标识符（扩展名_时间戳）
		const timestamp = Date.now();
		const versionedFileName = `${extension}_${timestamp}`;

		// 构建目标路径
		const targetPath = join(
			customCoverFolder,
			`cover_${getStorageGameId(gameId)}_${versionedFileName}`,
		);

		// 删除该游戏的所有旧封面文件（通过模式匹配）
		try {
			await deleteGameCustomCovers(gameId);
		} catch (error) {
			console.warn(
				`删除旧封面文件失败（可能没有旧文件）: ${toError(error, "删除旧封面文件失败").message}`,
			);
		}

		// 复制文件到目标位置
		await fileService.copyFile(imagePath, targetPath);

		// 返回版本化的文件标识符，存储到数据库
		return versionedFileName;
	} catch (error) {
		throw new Error(
			`Custom cover upload failed: ${toError(error, "Custom cover upload failed").message}`,
		);
	}
};

/**
 * Copy a local image for detail-page use and return the versioned identifier.
 */
export const uploadSelectedDetailBackdrop = async (
	gameId: number,
	imagePath: string,
): Promise<string> => {
	try {
		const extension = getFileExtension(basename(imagePath));
		const customCoverFolder = await getDetailBackdropFolder(gameId);
		if (!customCoverFolder) {
			throw new Error("资源目录路径未初始化");
		}

		const versionedFileName = `${extension}_${Date.now()}`;
		const targetPath = join(
			customCoverFolder,
			`detail_${getStorageGameId(gameId)}_${versionedFileName}`,
		);
		await fileService.copyFile(imagePath, targetPath);
		return versionedFileName;
	} catch (error) {
		throw new Error(
			`Detail backdrop upload failed: ${toError(error, "Detail backdrop upload failed").message}`,
		);
	}
};

/**
 * Write a browser-cropped detail backdrop to the app media directory.
 */
export const writeCroppedDetailBackdrop = async (
	gameId: number,
	bytes: Uint8Array,
): Promise<string> => {
	const customCoverFolder = await getDetailBackdropFolder(gameId);
	if (!customCoverFolder) {
		throw new Error("资源目录路径未初始化");
	}
	const identifier = `png_${Date.now()}`;
	const targetPath = join(
		customCoverFolder,
		`detail_${getStorageGameId(gameId)}_${identifier}`,
	);
	await fileService.writeFileBytes(targetPath, bytes);
	return identifier;
};
