import { path } from "@tauri-apps/api";
import { resourceDir } from "@tauri-apps/api/path";
import { join } from "pathe";
import { fetchAllSettings } from "@/hooks/queries/useSettings";
import { queryClient } from "@/providers/queryClient";
import { fileService } from "@/services/invoke";

interface PathInitResult {
	resourceDir: string;
	appDataDir: string;
}

interface PathCacheState {
	resourceDir: string | null;
	appDataDir: string | null;
	initPromise: Promise<PathInitResult> | null;
}

// Keep the cache outside the module instance so Vite HMR cannot clear it while
// the mounted React tree is still rendering a detail page.
const hotState = globalThis as typeof globalThis & {
	__skerryPathCacheState?: PathCacheState;
};
const pathCacheState: PathCacheState =
	hotState.__skerryPathCacheState ?? {
	resourceDir: null,
	appDataDir: null,
	initPromise: null,
};
hotState.__skerryPathCacheState = pathCacheState;

/**
 * 初始化所有路径缓存
 * 应该在应用启动时调用一次
 */
export const initPathCache = async (): Promise<PathInitResult> => {
	if (pathCacheState.resourceDir && pathCacheState.appDataDir) {
		return {
			resourceDir: pathCacheState.resourceDir,
			appDataDir: pathCacheState.appDataDir,
		};
	}
	if (pathCacheState.initPromise) return pathCacheState.initPromise;

	pathCacheState.initPromise = (async () => {
		const [resourceDirPath, systemAppDataDir] = await Promise.all([
			resourceDir(),
			path.appDataDir(),
		]);
		const baseResourceDir = join(resourceDirPath, "resources");
		const appDataDir = systemAppDataDir ?? baseResourceDir;

		let isPortableMode = false;
		try {
			isPortableMode = (await fileService.isPortableMode()).is_portable;
		} catch (error) {
			// A transient backend startup failure should not prevent the UI from
			// rendering. The system app-data directory is the safe fallback.
			console.warn(
				"便携模式检测失败，暂使用系统应用数据目录:",
				error,
			);
		}

		const resolvedAppDataDir = isPortableMode
			? baseResourceDir
			: appDataDir;
		pathCacheState.resourceDir = baseResourceDir;
		pathCacheState.appDataDir = resolvedAppDataDir;

		return {
			resourceDir: baseResourceDir,
			appDataDir: resolvedAppDataDir,
		};
	})();

	try {
		return await pathCacheState.initPromise;
	} catch (error) {
		pathCacheState.initPromise = null;
		throw error;
	}
};

export const getAppDataDirPath = (): string => {
	if (!pathCacheState.appDataDir) {
		throw new Error(
			"❌ 严重错误：路径缓存未初始化！请确保在访问文件系统前已完成 initPathCache。",
		);
	}
	return pathCacheState.appDataDir;
};

export const getDbBackupPath = async (): Promise<string> => {
	try {
		const settings = await fetchAllSettings(queryClient);
		const backupDir = settings.db_backup_path ?? "";
		const backupFinalDir = join(getAppDataDirPath(), "data", "backups");
		return backupDir ? backupDir : backupFinalDir;
	} catch (error) {
		console.error("获取数据库备份路径失败:", error);
		const backupFinalDir = join(getAppDataDirPath(), "data", "backups");
		return backupFinalDir;
	}
};

export const getSavedataBackupPath = async (
	gameId: number,
): Promise<string> => {
	try {
		const settings = await fetchAllSettings(queryClient);
		const savedataBackupPath = settings.save_root_path ?? "";
		const backupGameDir = join(savedataBackupPath, "backups", `game_${gameId}`);
		const savedataBackupFinalDir = join(
			getAppDataDirPath(),
			"backups",
			`game_${gameId}`,
		);
		return savedataBackupPath ? backupGameDir : savedataBackupFinalDir;
	} catch (error) {
		console.error("获取存档备份路径失败:", error);
		const savedataBackupFinalDir = join(
			getAppDataDirPath(),
			"backups",
			`game_${gameId}`,
		);
		return savedataBackupFinalDir;
	}
};
