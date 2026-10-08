/**
 * @file 文件与系统操作服务
 * @description 封装文件系统、目录打开与数据库备份/导入相关后端调用
 */

import type { GameDirectoryScanMode, ScanResult } from "@/types";
import { BaseService } from "./base";

export interface BackupResult {
	success: boolean;
	path: string | null;
	message: string;
}

export interface BackupOptions {
	auto?: boolean;
	maxAutoBackups?: number;
}

export interface ImportResult {
	success: boolean;
	message: string;
	backup_path: string | null;
}

export interface ExportUserDataRequest {
	archivePath: string;
	storeJson?: string | null;
}

export interface ExportUserDataResult {
	success: boolean;
	path: string;
	message: string;
}

export interface ImportUserDataResult {
	success: boolean;
	message: string;
	backupPath: string | null;
	storeJson: string | null;
}

export interface UserDataManifest {
	formatVersion: number;
	appVersion: string;
	exportedAt: string;
	storeJson: string | null;
}

export interface UserDataGamePreview {
	id: number;
	idType: string;
	name: string;
	developer: string | null;
	localpath: string | null;
	launchType: string;
	sourceCount: number;
	coverPath: string | null;
}

export interface UserDataPreviewResult {
	archivePath: string;
	archiveSize: number;
	manifest: UserDataManifest;
	games: UserDataGamePreview[];
	warnings: string[];
	message: string;
}

export interface MoveBackupFolderResult {
	success: boolean;
	message: string;
}

export interface PortableModeResult {
	is_portable: boolean;
}

export interface DroppedLocalPathResult {
	kind:
		| "executable"
		| "single_executable"
		| "multiple_executables"
		| "no_executable"
		| "invalid";
	path: string | null;
	directory: string | null;
}

export interface SteamLaunchTarget {
	steam_launch_id: string;
	name: string;
	localpath?: string;
	executable?: string;
}

export interface SteamLaunchTargetScanResult {
	targets: SteamLaunchTarget[];
	warnings: string[];
}

export interface SteamLaunchTargetScanOptions {
	excludeExisting?: boolean;
}

export interface GameTextFileCandidate {
	path: string;
	name: string;
}

class FileService extends BaseService {
	/** 扫描本机可用的 Steam 启动目标。 */
	async scanSteamLaunchTargets(
		options: SteamLaunchTargetScanOptions = {},
	): Promise<SteamLaunchTargetScanResult> {
		const { excludeExisting = false } = options;
		return this.invoke<SteamLaunchTargetScanResult>(
			"scan_steam_launch_targets",
			{ excludeExisting },
		);
	}

	/** 解析单个 Steam `.url` 快捷方式并匹配本机 Steam 库。 */
	async resolveSteamShortcutFile(path: string): Promise<SteamLaunchTarget> {
		return this.invoke<SteamLaunchTarget>("resolve_steam_shortcut_file", {
			path,
		});
	}

	/**
	 * 扫描目录下的游戏文件夹
	 */
	async scanDirectoryForGames(
		path: string,
		maxDepth: number,
		scanMode: GameDirectoryScanMode,
	): Promise<ScanResult[]> {
		return this.invoke<ScanResult[]>("scan_directory_for_games", {
			path,
			maxDepth,
			scanMode,
		});
	}

	/**
	 * 打开目录
	 */
	async openDirectory(dirPath: string): Promise<void> {
		return this.invoke<void>("open_directory", { dirPath });
	}

	/** 打开游戏目录中的 TXT 说明文本。 */
	async openGameReadmeText(gameId: number): Promise<string> {
		return this.invoke<string>("open_game_readme_text", { gameId });
	}

	/** 列出游戏目录中的 TXT 说明文本。 */
	async listGameReadmeTexts(gameId: number): Promise<GameTextFileCandidate[]> {
		return this.invoke<GameTextFileCandidate[]>("list_game_readme_texts", {
			gameId,
		});
	}

	/** 打开指定的游戏 TXT 说明文本。 */
	async openGameReadmeTextPath(gameId: number, path: string): Promise<string> {
		return this.invoke<string>("open_game_readme_text_path", { gameId, path });
	}

	/** 检测游戏存档目录。 */
	async detectGameSaveDirectory(gameId: number): Promise<string | null> {
		return this.invoke<string | null>("detect_game_save_directory", { gameId });
	}

	/** 打开检测到的游戏存档目录。 */
	async openGameSaveDirectory(gameId: number): Promise<string> {
		return this.invoke<string>("open_game_save_directory", { gameId });
	}

	/**
	 * 解析拖拽路径，避免前端 fs scope 限制
	 */
	async resolveDroppedLocalPath(
		droppedPath: string,
	): Promise<DroppedLocalPathResult> {
		return this.invoke<DroppedLocalPathResult>("resolve_dropped_local_path", {
			droppedPath,
		});
	}

	/**
	 * 判断当前是否为便携模式
	 */
	async isPortableMode(): Promise<PortableModeResult> {
		return this.invoke<PortableModeResult>("is_portable_mode");
	}

	/**
	 * 复制文件
	 */
	async copyFile(src: string, dst: string): Promise<void> {
		return this.invoke<void>("copy_file", { src, dst });
	}

	/** 判断指定路径是否为存在的文件。 */
	async fileExists(path: string): Promise<boolean> {
		return this.invoke<boolean>("file_exists", { path });
	}

	/** 读取文件原始字节。 */
	async readFileBytes(path: string): Promise<Uint8Array> {
		const bytes = await this.invoke<number[]>("read_file_bytes", { path });
		return new Uint8Array(bytes);
	}

	/** 判断指定路径是否为文件夹。 */
	async isDirectory(path: string): Promise<boolean> {
		return this.invoke<boolean>("is_directory", { path });
	}

	/** 遍历文件夹下的所有相对文件路径。 */
	async listDirectoryFiles(path: string): Promise<string[]> {
		return this.invoke<string[]>("list_directory_files", { path });
	}

	/** 将导入的图片字节写入应用媒体目录。 */
	async writeFileBytes(path: string, bytes: Uint8Array): Promise<void> {
		return this.invoke<void>("write_file_bytes", {
			path,
			bytes: Array.from(bytes),
		});
	}

	/**
	 * 删除文件
	 */
	async deleteFile(filePath: string): Promise<void> {
		return this.invoke<void>("delete_file", { filePath });
	}

	/**
	 * 从剪贴板导入图片到临时文件
	 */
	async importClipboardImageToTemp(gameId: number): Promise<string> {
		return this.invoke<string>("import_clipboard_image_to_temp", { gameId });
	}

	/**
	 * 删除指定游戏的自定义封面
	 */
	async deleteGameCovers(gameId: number, coversDir: string): Promise<void> {
		return this.invoke<void>("delete_game_covers", { gameId, coversDir });
	}

	/**
	 * 删除本地的云端封面缓存
	 */
	async deleteCloudCoverCache(gameId: number): Promise<void> {
		return this.invoke<void>("delete_cloud_cache", { gameId });
	}

	/**
	 * 备份数据库
	 */
	async backupDatabase(
		options: BackupOptions | null = null,
	): Promise<BackupResult> {
		return this.invoke<BackupResult>("backup_database", { options });
	}

	/**
	 * 备份自定义封面（仅自定义封面，不含云端缓存）
	 */
	async backupCustomCovers(
		options: BackupOptions | null = null,
	): Promise<BackupResult> {
		return this.invoke<BackupResult>("backup_custom_covers", { options });
	}

	/**
	 * 导入数据库
	 */
	async importDatabase(sourcePath: string): Promise<ImportResult> {
		return this.invoke<ImportResult>("import_database", { sourcePath });
	}

	/**
	 * 导出完整用户数据包
	 */
	async exportUserData(
		request: ExportUserDataRequest,
	): Promise<ExportUserDataResult> {
		return this.invoke<ExportUserDataResult>("export_user_data", { request });
	}

	/**
	 * 导入完整用户数据包
	 */
	async importUserData(archivePath: string): Promise<ImportUserDataResult> {
		return this.invoke<ImportUserDataResult>("import_user_data", {
			archivePath,
		});
	}

	async inspectUserData(
		archivePath: string,
	): Promise<UserDataPreviewResult> {
		return this.invoke<UserDataPreviewResult>("inspect_user_data", {
			archivePath,
		});
	}

	/**
	 * 移动备份文件夹
	 */
	async moveBackupFolder(
		oldPath: string,
		newPath: string,
	): Promise<MoveBackupFolderResult> {
		return this.invoke<MoveBackupFolderResult>("move_backup_folder", {
			oldPath,
			newPath,
		});
	}

	/**
	 * 迁移底图/CG 资源到新的保存根目录。
	 */
	async relocateDetailResources(oldRoot: string, newRoot: string): Promise<number> {
		return this.invoke<number>("relocate_detail_resources", {
			oldRoot,
			newRoot,
		});
	}
}

export const fileService = new FileService();
