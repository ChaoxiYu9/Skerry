/**
 * @file 用户设置服务
 * @description 封装所有用户设置相关的后端调用
 */

import type {
	BgmAuth,
	HikarinagiAuth,
	KungalAuth,
	LogLevel,
	RuntimeLogLevel,
	UpdateSettingsParams,
} from "@/types";
import { BaseService } from "./base";
import type { MoveBackupFolderResult } from "./fileService";

export interface UserSettings {
	bgm_auth?: BgmAuth | null;
	hikarinagi_auth?: HikarinagiAuth | null;
	kungal_auth?: KungalAuth | null;
	vndb_token?: string | null;
	save_root_path?: string | null;
	db_backup_path?: string | null;
	le_path?: string | null;
	magpie_path?: string | null;
	detail_backdrop_path?: string | null;
	default_le_launch?: boolean | null;
	default_magpie?: boolean | null;
}

export interface ProxyConfig {
	url: string;
}

class SettingsService extends BaseService {
	/**
	 * 动态设置日志输出级别（不持久化）
	 */
	async setLogLevel(level: LogLevel): Promise<void> {
		return this.invoke<void>("set_skerry_log_level", { level });
	}

	/**
	 * 获取当前日志输出级别
	 */
	async getLogLevel(): Promise<RuntimeLogLevel> {
		return this.invoke<RuntimeLogLevel>("get_skerry_log_level");
	}

	/**
	 * 获取所有设置
	 */
	async getAllSettings(): Promise<UserSettings> {
		return this.invoke<UserSettings>("get_all_settings");
	}

	/**
	 * 批量更新设置
	 */
	async updateSettings(updates: UpdateSettingsParams): Promise<void> {
		return this.invoke<void>("update_settings", {
			data: updates,
		});
	}

	async updateSettingsWithSavedataBackupRootMove(
		updates: UpdateSettingsParams,
	): Promise<MoveBackupFolderResult> {
		return this.invoke<MoveBackupFolderResult>(
			"relocate_savedata_backup_root",
			{ data: updates },
		);
	}

	async updateProxyConfig(config: ProxyConfig): Promise<void> {
		return this.invoke<void>("update_proxy_config", { config });
	}

	async bgmOAuthStartLogin(sessionId: string): Promise<string> {
		return this.invoke<string>("bgm_oauth_start_login", { sessionId });
	}

	async bgmOAuthCancelLogin(sessionId: string): Promise<void> {
		return this.invoke<void>("bgm_oauth_cancel_login", { sessionId });
	}

	async bgmOAuthExchangeCode(code: string): Promise<BgmAuth> {
		return this.invoke<BgmAuth>("bgm_oauth_exchange_code", { code });
	}

	async bgmOAuthRefreshToken(
		refreshToken: string,
		expectedAccessToken: string,
	): Promise<BgmAuth | null> {
		return this.invoke<BgmAuth | null>("bgm_oauth_refresh_token", {
			refreshToken,
			expectedAccessToken,
		});
	}

	async bgmOAuthClearIfCurrent(
		accessToken: string,
		refreshToken?: string | null,
	): Promise<boolean> {
		return this.invoke<boolean>("bgm_oauth_clear_if_current", {
			accessToken,
			refreshToken,
		});
	}

	async hikarinagiOAuthStartLogin(sessionId: string): Promise<string> {
		return this.invoke<string>("hikarinagi_oauth_start_login", { sessionId });
	}

	async hikarinagiOAuthCancelLogin(sessionId: string): Promise<void> {
		return this.invoke<void>("hikarinagi_oauth_cancel_login", { sessionId });
	}

	async hikarinagiOAuthExchangeCode(
		code: string,
		codeVerifier: string,
	): Promise<HikarinagiAuth> {
		return this.invoke<HikarinagiAuth>("hikarinagi_oauth_exchange_code", {
			code,
			codeVerifier,
		});
	}

	async hikarinagiOAuthRefreshToken(
		refreshToken: string,
		expectedAccessToken: string,
	): Promise<HikarinagiAuth | null> {
		return this.invoke<HikarinagiAuth | null>(
			"hikarinagi_oauth_refresh_token",
			{
				refreshToken,
				expectedAccessToken,
			},
		);
	}

	async hikarinagiOAuthClearIfCurrent(
		accessToken: string,
		refreshToken?: string | null,
	): Promise<boolean> {
		return this.invoke<boolean>("hikarinagi_oauth_clear_if_current", {
			accessToken,
			refreshToken,
		});
	}

	async kungalOAuthStartLogin(sessionId: string): Promise<string> {
		return this.invoke<string>("kungal_oauth_start_login", { sessionId });
	}

	async kungalOAuthCancelLogin(sessionId: string): Promise<void> {
		return this.invoke<void>("kungal_oauth_cancel_login", { sessionId });
	}

	async kungalOAuthExchangeCode(
		code: string,
		codeVerifier: string,
	): Promise<KungalAuth> {
		return this.invoke<KungalAuth>("kungal_oauth_exchange_code", {
			code,
			codeVerifier,
		});
	}

	async kungalOAuthRefreshToken(
		refreshToken: string,
		expectedAccessToken: string,
	): Promise<KungalAuth | null> {
		return this.invoke<KungalAuth | null>("kungal_oauth_refresh_token", {
			refreshToken,
			expectedAccessToken,
		});
	}

	async kungalOAuthClearIfCurrent(
		accessToken: string,
		refreshToken?: string | null,
	): Promise<boolean> {
		return this.invoke<boolean>("kungal_oauth_clear_if_current", {
			accessToken,
			refreshToken,
		});
	}
}

// 导出单例
export const settingsService = new SettingsService();
