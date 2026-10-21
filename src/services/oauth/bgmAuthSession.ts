import i18next from "i18next";
import { settingsKeys } from "@/hooks/queries/useSettings";
import { queryClient } from "@/providers/queryClient";
import { snackbar } from "@/providers/snackBar";
import { settingsService, type UserSettings } from "@/services/invoke";
import {
	isRefreshCredentialError,
	nowUnixSeconds,
} from "@/services/oauth/oauthAuthSession";
import {
	createOAuthRefreshFlights,
	refreshOAuthAuth,
} from "@/services/oauth/oauthRefresh";
import type { BgmAuth } from "@/types";
import { AppError, isHttpStatus } from "@/utils/errors";

let bgmRefreshTimer: number | null = null;

const BGM_REFRESH_THRESHOLD_SECONDS = 48 * 60 * 60;
const BGM_REFRESH_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function isBgmAuthRefreshDue(
	auth: BgmAuth | null | undefined,
	now = nowUnixSeconds(),
) {
	return Boolean(
		auth?.refresh_token &&
			auth.expires_at != null &&
			auth.expires_at <= now + BGM_REFRESH_THRESHOLD_SECONDS,
	);
}

function getCachedSettings() {
	return queryClient.getQueryData<UserSettings>(settingsKeys.allSettings());
}

async function fetchSettings() {
	return queryClient.fetchQuery({
		queryKey: settingsKeys.allSettings(),
		queryFn: () => settingsService.getAllSettings(),
	});
}

function updateCachedBgmAuth(bgmAuth: BgmAuth | null) {
	const settings = getCachedSettings();
	if (settings) {
		queryClient.setQueryData<UserSettings>(settingsKeys.allSettings(), {
			...settings,
			bgm_auth: bgmAuth,
		});
	}
}

async function readCurrentBgmAuth() {
	const settings = await settingsService.getAllSettings();
	queryClient.setQueryData<UserSettings>(settingsKeys.allSettings(), settings);
	return settings.bgm_auth ?? null;
}

async function clearBgmAuthIfCurrent(auth: BgmAuth) {
	const cleared = await settingsService.bgmOAuthClearIfCurrent(
		auth.access_token,
		auth.refresh_token,
	);
	if (cleared) {
		updateCachedBgmAuth(null);
		await queryClient.invalidateQueries({
			queryKey: settingsKeys.allSettings(),
		});
	}
	return cleared;
}

function getReloginMessage() {
	return i18next.t(
		"pages.Settings.bgmTokenSettings.reloginRequired",
		"Bangumi 登录已失效，请重新登录。",
	);
}

export async function logoutBgmAuth(options?: { notify?: boolean }) {
	await settingsService.updateSettings({ bgmAuth: null });
	updateCachedBgmAuth(null);
	await queryClient.invalidateQueries({ queryKey: settingsKeys.allSettings() });

	if (options?.notify) {
		snackbar.error(getReloginMessage());
	}
}

const refreshBgmAuthForCredentials = createOAuthRefreshFlights<
	BgmAuth,
	BgmAuth | null
>((auth) =>
	refreshOAuthAuth(auth, {
		requestRefresh: (currentAuth, refreshToken) =>
			settingsService.bgmOAuthRefreshToken(
				refreshToken,
				currentAuth.access_token,
			),
		isCredentialError: isRefreshCredentialError,
		clearAuthIfCurrent: clearBgmAuthIfCurrent,
		readCurrentAuth: readCurrentBgmAuth,
		publishRefreshedAuth: async (refreshedAuth) => {
			updateCachedBgmAuth(refreshedAuth);
			await queryClient.invalidateQueries({
				queryKey: settingsKeys.allSettings(),
			});
		},
		notifyReauthenticationRequired: () => snackbar.error(getReloginMessage()),
	}),
);

async function getValidBgmAuth() {
	const settings = await fetchSettings();
	const auth = settings.bgm_auth ?? null;

	if (!auth?.access_token) return null;
	if (!isBgmAuthRefreshDue(auth)) return auth;

	return refreshBgmAuthForCredentials(auth);
}

export function isBgmAuthExpiredError(error: unknown) {
	return error instanceof Error && error.name === "BgmAuthExpiredError";
}

export async function withBgmAuth<T>(fn: (token?: string) => Promise<T>) {
	const auth = await getValidBgmAuth();
	const token = auth?.access_token;

	try {
		return await fn(token);
	} catch (error) {
		if (token && isHttpStatus(error, 401)) {
			if (!auth) throw error;
			if (
				!(await clearBgmAuthIfCurrent(auth)) &&
				(await readCurrentBgmAuth())
			) {
				throw error;
			}
			snackbar.error(getReloginMessage());
			throw new AppError({
				code: "bgm_auth_expired",
				message: getReloginMessage(),
				cause: error,
				name: "BgmAuthExpiredError",
			});
		}
		throw error;
	}
}

export async function initBgmAuthRefresh() {
	try {
		await getValidBgmAuth();
		if (bgmRefreshTimer === null) {
			bgmRefreshTimer = window.setInterval(() => {
				void getValidBgmAuth().catch((error) => {
					console.error("BGM OAuth 自动刷新检查失败:", error);
				});
			}, BGM_REFRESH_CHECK_INTERVAL_MS);
		}
	} catch (error) {
		console.error("BGM OAuth 自动刷新检查失败:", error);
	}
}
