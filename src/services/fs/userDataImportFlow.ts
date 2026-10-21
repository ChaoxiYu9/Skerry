import type { ImportUserDataResult } from "@/services/invoke";
import { toError } from "../../utils/errors.ts";

export interface UserDataImportOutcome {
	importResult: ImportUserDataResult;
	storeRestoreError: string | null;
}

type ImportArchive = (archivePath: string) => Promise<ImportUserDataResult>;
type RestoreStore = (storeJson: string) => void;

/** 后端导入已提交时，本地存储失败不能丢掉重启结果。 */
export async function importUserDataAndRestoreStore(
	archivePath: string,
	importArchive: ImportArchive,
	restoreStore: RestoreStore,
): Promise<UserDataImportOutcome> {
	const importResult = await importArchive(archivePath);
	let storeRestoreError: string | null = null;

	if (importResult.success && importResult.storeJson) {
		try {
			restoreStore(importResult.storeJson);
		} catch (error) {
			storeRestoreError =
				toError(error, "本地应用状态恢复失败").message ||
				"本地应用状态恢复失败";
		}
	}

	return { importResult, storeRestoreError };
}
