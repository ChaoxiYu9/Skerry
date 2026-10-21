import i18next from "i18next";
import { settingsKeys } from "@/hooks/queries/useSettings";
import { queryClient } from "@/providers/queryClient";
import { snackbar } from "@/providers/snackBar";
import { settingsService, type UserSettings } from "@/services/invoke";
import {
	isOAuthAuthRefreshDue,
	isRefreshCredentialError,
	nowUnixSeconds,
} from "@/services/oauth/oauthAuthSession";
import {
	createOAuthRefreshFlights,
	refreshOAuthAuth,
} from "@/services/oauth/oauthRefresh";
import type { HikarinagiAuth } from "@/types";
import { AppError, isHttpStatus } from "@/utils/errors";

export function isHikarinagiAuthRefreshDue(
	auth: HikarinagiAuth | null | undefined,
	now = nowUnixSeconds(),
) {
	return isOAuthAuthRefreshDue(auth, now);
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

function updateCachedHikarinagiAuth(auth: HikarinagiAuth | null) {
	const settings = getCachedSettings();
	if (settings) {
		queryClient.setQueryData<UserSettings>(settingsKeys.allSettings(), {
			...settings,
			hikarinagi_auth: auth,
		});
	}
}

async function readCurrentHikarinagiAuth() {
	const settings = await settingsService.getAllSettings();
	queryClient.setQueryData<UserSettings>(settingsKeys.allSettings(), settings);
	return settings.hikarinagi_auth ?? null;
}

async function clearHikarinagiAuthIfCurrent(auth: HikarinagiAuth) {
	const cleared = await settingsService.hikarinagiOAuthClearIfCurrent(
		auth.access_token,
		auth.refresh_token,
	);
	if (cleared) {
		updateCachedHikarinagiAuth(null);
		await queryClient.invalidateQueries({
			queryKey: settingsKeys.allSettings(),
		});
	}
	return cleared;
}

function getReloginMessage() {
	return i18next.t(
		"pages.Settings.hikarinagiAuth.reloginRequired",
		"Hikarinagi 登录已失效，请重新登录。",
	);
}

export async function logoutHikarinagiAuth(options?: { notify?: boolean }) {
	await settingsService.updateSettings({ hikarinagiAuth: null });
	updateCachedHikarinagiAuth(null);
	await queryClient.invalidateQueries({ queryKey: settingsKeys.allSettings() });

	if (options?.notify) {
		snackbar.error(getReloginMessage());
	}
}

const refreshHikarinagiAuthForCredentials = createOAuthRefreshFlights<
	HikarinagiAuth,
	HikarinagiAuth | null
>((auth) =>
	refreshOAuthAuth(auth, {
		requestRefresh: (currentAuth, refreshToken) =>
			settingsService.hikarinagiOAuthRefreshToken(
				refreshToken,
				currentAuth.access_token,
			),
		isCredentialError: isRefreshCredentialError,
		clearAuthIfCurrent: clearHikarinagiAuthIfCurrent,
		readCurrentAuth: readCurrentHikarinagiAuth,
		publishRefreshedAuth: async (refreshedAuth) => {
			updateCachedHikarinagiAuth(refreshedAuth);
			await queryClient.invalidateQueries({
				queryKey: settingsKeys.allSettings(),
			});
		},
		notifyReauthenticationRequired: () => snackbar.error(getReloginMessage()),
	}),
);

async function getValidHikarinagiAuth() {
	const settings = await fetchSettings();
	const auth = settings.hikarinagi_auth ?? null;

	if (!auth?.access_token) return null;
	if (!isHikarinagiAuthRefreshDue(auth)) return auth;

	return refreshHikarinagiAuthForCredentials(auth);
}

export function isHikarinagiAuthExpiredError(error: unknown) {
	return error instanceof Error && error.name === "HikarinagiAuthExpiredError";
}

export async function withHikarinagiAuth<T>(
	fn: (token?: string, auth?: HikarinagiAuth) => Promise<T>,
) {
	const auth = await getValidHikarinagiAuth();
	const token = auth?.access_token;

	try {
		return await fn(token, auth ?? undefined);
	} catch (error) {
		if (token && isHttpStatus(error, 401)) {
			if (!auth) throw error;
			if (
				!(await clearHikarinagiAuthIfCurrent(auth)) &&
				(await readCurrentHikarinagiAuth())
			) {
				throw error;
			}
			snackbar.error(getReloginMessage());
			throw new AppError({
				code: "hikarinagi_auth_expired",
				message: getReloginMessage(),
				cause: error,
				name: "HikarinagiAuthExpiredError",
			});
		}
		throw error;
	}
}

export function hasHikarinagiScope(
	auth: HikarinagiAuth | null | undefined,
	requiredScope: string,
) {
	return new Set(auth?.scope?.split(/\s+/).filter(Boolean) ?? []).has(
		requiredScope,
	);
}

export async function initHikarinagiAuthRefresh() {
	try {
		await getValidHikarinagiAuth();
	} catch (error) {
		console.error("Hikarinagi OAuth 自动刷新检查失败:", error);
	}
}
