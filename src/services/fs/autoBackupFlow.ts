import type { BackupResult } from "@/services/invoke";

export interface AutoBackupCommandOptions {
	auto: true;
	maxAutoBackups: number;
}

type DatabaseBackupCommand = (
	options: AutoBackupCommandOptions,
) => Promise<BackupResult>;

export async function runAutoBackup(
	maxAutoBackups: number,
	backupDatabase: DatabaseBackupCommand,
): Promise<BackupResult> {
	return backupDatabase({ auto: true, maxAutoBackups });
}
