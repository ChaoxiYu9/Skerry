import { open, save } from "@tauri-apps/plugin-dialog";
import { runAutoBackup } from "@/services/fs/autoBackupFlow";
import {
	importUserDataAndRestoreStore,
	type UserDataImportOutcome,
} from "@/services/fs/userDataImportFlow";
import {
	type BackupResult,
	type ExportUserDataResult,
	fileService,
	type ImportResult,
	type UserDataPreviewResult,
} from "@/services/invoke";

/**
 * 使用 VACUUM INTO 进行数据库热备份
 *
 * 此方法使用 SQLite 的 VACUUM INTO 语句，可以在数据库正在使用时安全地创建备份。
 * VACUUM INTO 会创建一个优化后的数据库副本，同时保持原数据库的完整性。
 *
 * 备份路径从数据库的 user 表中读取配置：
 * - 优先使用 user.db_backup_path（如果设置且非空）
 * - 否则使用默认的 AppData/data/backups 目录（或便携模式下的程序目录）
 *
 * @returns 备份结果，包含备份文件的路径
 */
export async function backupDatabase(): Promise<BackupResult> {
	try {
		const result = await fileService.backupDatabase();
		console.log(`数据库已备份到: ${result.path}`);
		return result;
	} catch (error) {
		console.error("备份数据库失败:", error);
		throw error;
	}
}

/**
 * 备份自定义封面（仅自定义封面，不含云端缓存）
 *
 * 扫描所有 game_{id} 目录，仅复制匹配 cover_{id}_* 的文件，
 * 无自定义封面的目录不会包含在备份中。
 * 备份路径跟随数据库备份路径逻辑。
 *
 * @returns 备份结果，包含备份文件的路径
 */
export async function backupCustomCovers(): Promise<BackupResult> {
	try {
		const result = await fileService.backupCustomCovers();
		if (result.path) {
			console.log(`自定义封面已备份到: ${result.path}`);
		}
		return result;
	} catch (error) {
		console.error("备份自定义封面失败:", error);
		throw error;
	}
}

/**
 * 创建退出时自动备份。
 *
 * 后端会使用自动备份专用文件名，并只清理旧的自动备份文件。
 */
export async function createAutoBackup(
	maxBackups: number,
): Promise<BackupResult> {
	const result = await runAutoBackup(maxBackups, (options) =>
		fileService.backupDatabase(options),
	);
	console.log(`自动备份完成: ${result.path}`);
	return result;
}

/**
 * 选择并导入数据库文件。
 *
 * 后端负责暂存和校验导入文件，尝试生成当前数据库的热备份，并生成自定义封面恢复包；
 * 数据库热备份失败会记录警告，文件发布仍有独立回滚副本，自定义封面备份失败则中止导入。
 * 随后后端关闭连接，通过可回滚发布替换数据库并清空旧封面目录。数据库热备份使用活动
 * 连接生成，不是关闭连接后的冷文件副本。
 *
 * 页面会按 `restart_required` 决定是否重启；该字段即使在导入失败时也可能为 true，
 * 因为失败可能发生在旧数据库连接关闭之后。取消文件选择返回 null。
 *
 * @returns 导入结果；取消选择时返回 null
 */
export async function importDatabase(): Promise<ImportResult | null> {
	// 打开文件选择对话框
	const filePath = await open({
		filters: [{ name: "SQLite Database", extensions: ["db"] }],
		multiple: false,
		directory: false,
	});

	if (!filePath) {
		return null; // 用户取消
	}

	// 调用后端命令导入数据库
	const result = await fileService.importDatabase(filePath);

	return result;
}

/**
 * 导出完整用户数据包。
 */
export async function exportUserData(): Promise<ExportUserDataResult | null> {
	const archivePath = await save({
		title: "导出用户数据",
		defaultPath: `Skerry_Profile_${new Date()
			.toISOString()
			.slice(0, 10)
			.replaceAll("-", "")}.7z`,
		filters: [{ name: "Skerry User Data", extensions: ["7z"] }],
	});
	if (!archivePath) return null;

	return fileService.exportUserData({
		archivePath,
		storeJson: localStorage.getItem("skerry-store"),
	});
}

/**
 * 导入完整用户数据包，并在重启前恢复 WebView 本地偏好。
 */
export async function inspectUserDataPreview(
	archivePath: string,
): Promise<UserDataPreviewResult> {
	return fileService.inspectUserData(archivePath);
}

export async function importUserDataByPath(
	archivePath: string,
): Promise<UserDataImportOutcome> {
	return importUserDataAndRestoreStore(
		archivePath,
		(path) => fileService.importUserData(path),
		(storeJson) => localStorage.setItem("skerry-store", storeJson),
	);
}

export async function selectUserDataArchive(): Promise<string | null> {
	const selectedPath = await open({
		title: "导入用户数据",
		multiple: false,
		directory: false,
		filters: [{ name: "Skerry User Data", extensions: ["7z"] }],
	});
	if (!selectedPath || Array.isArray(selectedPath)) return null;
	return selectedPath;
}
