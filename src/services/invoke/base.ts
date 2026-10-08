/**
 * @file Service 基础类
 * @description 提供统一的错误归一化能力
 */

import { invoke, isTauri } from "@tauri-apps/api/core";
import { AppError, normalizeTauriError } from "@/utils/errors";

/**
 * 基础 Service 类
 */
export class BaseService {
	/**
	 * 调用 Tauri command
	 * @param command 命令名称
	 * @param args 参数
	 * @returns Promise 结果
	 */
	protected async invoke<T>(
		command: string,
		args?: Record<string, unknown>,
	): Promise<T> {
		if (!isTauri()) {
			throw new AppError({
				code: "tauri_invoke_failed",
				message: `Tauri runtime is unavailable: ${command}`,
			});
		}

		try {
			return await invoke<T>(command, args);
		} catch (error) {
			throw normalizeTauriError(error, { command, args });
		}
	}
}
