/**
 * @file 存档备份服务
 * @description 封装所有存档备份相关的后端调用
 */

import type { SavedataRecord } from "@/types";
import { BaseService } from "./base";

/** 备份信息 */
export interface BackupInfo {
	folder_name: string;
	backup_time: number;
	file_size: number;
	backup_path: string;
}

export interface RestoreSavedataResult {
	restored_path: string;
	replaced_existing: boolean;
	restored_to_alternate: boolean;
	cleanup_warning: string | null;
}

class SavedataService extends BaseService {
	/**
	 * 创建存档备份
	 * @param gameId 游戏ID
	 * @param sourcePath 存档文件夹路径
	 */
	async createBackup(gameId: number, sourcePath: string): Promise<BackupInfo> {
		return this.invoke<BackupInfo>("create_savedata_backup", {
			gameId,
			sourcePath,
		});
	}

	/**
	 * 删除备份文件和数据库记录（二合一）
	 * @param backupId 备份记录ID
	 */
	async deleteBackup(backupId: number): Promise<void> {
		return this.invoke<void>("delete_savedata_backup", { backupId });
	}

	/**
	 * 恢复存档备份
	 * @param backupFilePath 备份文件完整路径
	 * @param targetPath 目标恢复路径
	 */
	async restoreBackup(
		backupFilePath: string,
		targetPath: string,
	): Promise<RestoreSavedataResult> {
		return this.invoke<RestoreSavedataResult>("restore_savedata_backup", {
			backupFilePath,
			targetPath,
		});
	}

	/**
	 * 获取指定游戏的备份数量
	 */
	async getSavedataCount(gameId: number): Promise<number> {
		return this.invoke<number>("get_savedata_count", { gameId });
	}

	/**
	 * 获取指定游戏的所有备份记录
	 */
	async getSavedataRecords(gameId: number): Promise<SavedataRecord[]> {
		return this.invoke<SavedataRecord[]>("get_savedata_records", { gameId });
	}
}

// 导出单例
export const savedataService = new SavedataService();
