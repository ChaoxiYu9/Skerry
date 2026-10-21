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
import type { KungalAuth } from "@/types";
import { AppError, isHttpStatus } from "@/utils/errors";

let kungalRefreshTimer: number | null = null;

const KUNGAL_REFRESH_THRESHOLD_SECONDS = 48 * 60 * 60;
const KUNGAL_REFRESH_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function isKungalAuthRefreshDue(
	auth: KungalAuth | null | undefined,
	now = nowUnixSeconds(),
) {
	return Boolean(
		auth?.refresh_token &&
			auth.expires_at != null &&
			auth.expires_at <= now + KUNGAL_REFRESH_THRESHOLD_SECONDS,
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

function updateCachedKungalAuth(auth: KungalAuth | null) {
	const settings = getCachedSettings();
	if (settings) {
		queryClient.setQueryData<UserSettings>(settingsKeys.allSettings(), {
			...settings,
			kungal_auth: auth,
		});
	}
}

async function readCurrentKungalAuth() {
	const settings = await settingsService.getAllSettings();
	queryClient.setQueryData<UserSettings>(settingsKeys.allSettings(), settings);
	return settings.kungal_auth ?? null;
}

async function clearKungalAuthIfCurrent(auth: KungalAuth) {
	const cleared = await settingsService.kungalOAuthClearIfCurrent(
		auth.access_token,
		auth.refresh_token,
	);
	if (cleared) {
		updateCachedKungalAuth(null);
		await queryClient.invalidateQueries({
			queryKey: settingsKeys.allSettings(),
		});
	}
	return cleared;
}

function getReloginMessage() {
	return i18next.t(
		"pages.Settings.kungalAuth.reloginRequired",
		"KunGal 登录已失效，请重新登录。",
	);
}

async function throwKungalAuthExpiredError(
	cause: unknown,
	expectedAuth: KungalAuth,
): Promise<never> {
	if (!(await clearKungalAuthIfCurrent(expectedAuth))) {
		if (await readCurrentKungalAuth()) throw cause;
	}
	snackbar.error(getReloginMessage());
	throw new AppError({
		code: "kungal_auth_expired",
		message: getReloginMessage(),
		cause,
		name: "KungalAuthExpiredError",
	});
}

export async function logoutKungalAuth(options?: { notify?: boolean }) {
	await settingsService.updateSettings({ kungalAuth: null });
	updateCachedKungalAuth(null);
	await queryClient.invalidateQueries({ queryKey: settingsKeys.allSettings() });

	if (options?.notify) {
		snackbar.error(getReloginMessage());
	}
}

const refreshKungalAuthForCredentials = createOAuthRefreshFlights<
	KungalAuth,
	KungalAuth | null
>((auth) =>
	refreshOAuthAuth(auth, {
		requestRefresh: (currentAuth, refreshToken) =>
			settingsService.kungalOAuthRefreshToken(
				refreshToken,
				currentAuth.access_token,
			),
		isCredentialError: isRefreshCredentialError,
		clearAuthIfCurrent: clearKungalAuthIfCurrent,
		readCurrentAuth: readCurrentKungalAuth,
		publishRefreshedAuth: async (refreshedAuth) => {
			updateCachedKungalAuth(refreshedAuth);
			await queryClient.invalidateQueries({
				queryKey: settingsKeys.allSettings(),
			});
		},
		notifyReauthenticationRequired: () => snackbar.error(getReloginMessage()),
	}),
);

export async function getValidKungalAuth() {
	const settings = await fetchSettings();
	const auth = settings.kungal_auth ?? null;

	if (!auth?.access_token) return null;
	if (!isKungalAuthRefreshDue(auth)) return auth;

	return refreshKungalAuthForCredentials(auth);
}

export function isKungalAuthExpiredError(error: unknown) {
	return error instanceof Error && error.name === "KungalAuthExpiredError";
}

export async function withKungalAuth<T>(
	fn: (token?: string, auth?: KungalAuth) => Promise<T>,
) {
	const auth = await getValidKungalAuth();
	const token = auth?.access_token;

	try {
		return await fn(token, auth ?? undefined);
	} catch (error) {
		if (!token || !isHttpStatus(error, 401)) throw error;
		if (!auth?.refresh_token) {
			return throwKungalAuthExpiredError(error, auth);
		}

		const refreshedAuth = await refreshKungalAuthForCredentials(auth);
		if (!refreshedAuth?.access_token) {
			return throwKungalAuthExpiredError(error, auth);
		}

		try {
			return await fn(refreshedAuth.access_token, refreshedAuth);
		} catch (retryError) {
			if (isHttpStatus(retryError, 401)) {
				return throwKungalAuthExpiredError(retryError, refreshedAuth);
			}
			throw retryError;
		}
	}
}

export async function initKungalAuthRefresh() {
	if (kungalRefreshTimer === null) {
		kungalRefreshTimer = window.setInterval(() => {
			void getValidKungalAuth().catch((error) => {
				console.error("KunGal OAuth 自动刷新检查失败:", error);
			});
		}, KUNGAL_REFRESH_CHECK_INTERVAL_MS);
	}

	try {
		await getValidKungalAuth();
	} catch (error) {
		console.error("KunGal OAuth 自动刷新检查失败:", error);
	}
}
