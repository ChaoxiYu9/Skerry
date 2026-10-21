import { listen } from "@tauri-apps/api/event";
import { open as openurl } from "@tauri-apps/plugin-shell";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useAllSettings,
	useHikarinagiCurrentUserProfile,
	useUpdateSettings,
} from "@/hooks/queries/useSettings";
import { completeHikarinagiAuth } from "@/metadata/api/hikarinagi";
import { snackbar } from "@/providers/snackBar";
import { settingsService } from "@/services/invoke";
import { logoutHikarinagiAuth } from "@/services/oauth/hikarinagiAuthSession";
import { createOAuthAttemptLifecycle } from "@/services/oauth/oauthAttemptLifecycle";
import { completeAndPersistOAuthAuth } from "@/services/oauth/oauthAuthCommit";
import {
	createOAuthSessionId,
	type OAuthCallbackErrorPayload,
	type OAuthCallbackPayload,
} from "@/services/oauth/oauthAuthSession";
import { getNetworkRequestContext } from "@/services/requestContext";
import { toError } from "@/utils/errors";

const hikarinagiOAuthAttempt = createOAuthAttemptLifecycle();

export function useHikarinagiAuthController() {
	const { t } = useTranslation();
	const { data: settings, isLoading: isSettingsLoading } = useAllSettings();
	const hikarinagiAuth = settings?.hikarinagi_auth;
	const { data: hikarinagiProfile } = useHikarinagiCurrentUserProfile();
	const updateSettingsMutation = useUpdateSettings();
	const [isOAuthLoading, setIsOAuthLoading] = useState(
		hikarinagiOAuthAttempt.isRunning,
	);

	useEffect(() => {
		return hikarinagiOAuthAttempt.subscribe(setIsOAuthLoading);
	}, []);

	const handleOAuthLogin = useCallback(async () => {
		if (hikarinagiOAuthAttempt.isRunning) {
			snackbar.info(
				t(
					"pages.Settings.hikarinagiAuth.oauthWaiting",
					"请在浏览器中完成 Hikarinagi 授权...",
				),
			);
			return;
		}

		const sessionId = createOAuthSessionId();
		const attemptId = hikarinagiOAuthAttempt.begin(sessionId);
		try {
			hikarinagiOAuthAttempt.setRunning(true);
			const authorizeUrl =
				await settingsService.hikarinagiOAuthStartLogin(sessionId);
			if (!hikarinagiOAuthAttempt.isCurrent(attemptId)) {
				await settingsService.hikarinagiOAuthCancelLogin(sessionId);
				return;
			}
			hikarinagiOAuthAttempt.clearEventListeners();
			const codeUnlisten = await listen<OAuthCallbackPayload>(
				"hikarinagi-oauth-code",
				async (event) => {
					if (
						!hikarinagiOAuthAttempt.isCurrent(attemptId) ||
						event.payload.session_id !== sessionId
					)
						return;
					hikarinagiOAuthAttempt.clearEventListeners();
					try {
						const codeVerifier = event.payload.code_verifier?.trim();
						if (!codeVerifier) {
							throw new Error("Hikarinagi OAuth 回调缺少 PKCE verifier");
						}
						const auth = await settingsService.hikarinagiOAuthExchangeCode(
							event.payload.code,
							codeVerifier,
						);
						const didPersist = await completeAndPersistOAuthAuth({
							auth,
							isCurrentAttempt: () =>
								hikarinagiOAuthAttempt.isCurrent(attemptId),
							completeAuth: (exchangedAuth) =>
								completeHikarinagiAuth(
									exchangedAuth,
									getNetworkRequestContext(),
								),
							persistAuth: (completedAuth) =>
								updateSettingsMutation.mutateAsync({
									hikarinagiAuth: completedAuth,
								}),
							setCommitting: (committing) => {
								hikarinagiOAuthAttempt.setCommitting(committing);
							},
						});
						if (!didPersist || !hikarinagiOAuthAttempt.isCurrent(attemptId))
							return;
						snackbar.success(
							t(
								"pages.Settings.hikarinagiAuth.oauthSuccess",
								"Hikarinagi OAuth 登录成功",
							),
						);
					} catch (error) {
						if (!hikarinagiOAuthAttempt.isCurrent(attemptId)) return;
						console.error(error);
						snackbar.error(
							t(
								"pages.Settings.hikarinagiAuth.oauthError",
								"Hikarinagi OAuth 登录失败: {{error}}",
								{ error: toError(error).message },
							),
						);
					} finally {
						hikarinagiOAuthAttempt.finish(attemptId, sessionId);
					}
				},
			);
			if (!hikarinagiOAuthAttempt.isCurrent(attemptId)) {
				codeUnlisten();
				await settingsService.hikarinagiOAuthCancelLogin(sessionId);
				return;
			}
			const errorUnlisten = await listen<OAuthCallbackErrorPayload>(
				"hikarinagi-oauth-error",
				(event) => {
					if (
						!hikarinagiOAuthAttempt.isCurrent(attemptId) ||
						event.payload.session_id !== sessionId
					)
						return;
					hikarinagiOAuthAttempt.clearEventListeners();
					hikarinagiOAuthAttempt.finish(attemptId, sessionId);
					snackbar.error(
						t(
							"pages.Settings.hikarinagiAuth.oauthError",
							"Hikarinagi OAuth 登录失败: {{error}}",
							{ error: event.payload.message },
						),
					);
				},
			);
			if (!hikarinagiOAuthAttempt.isCurrent(attemptId)) {
				codeUnlisten();
				errorUnlisten();
				await settingsService.hikarinagiOAuthCancelLogin(sessionId);
				return;
			}
			hikarinagiOAuthAttempt.setEventListeners([codeUnlisten, errorUnlisten]);
			void openurl(authorizeUrl).catch(async (error) => {
				if (!hikarinagiOAuthAttempt.isCurrent(attemptId)) return;
				console.error(error);
				hikarinagiOAuthAttempt.clearEventListeners();
				const failedAttemptId = hikarinagiOAuthAttempt.invalidate();
				await settingsService
					.hikarinagiOAuthCancelLogin(sessionId)
					.catch((cancelError) => {
						console.error(cancelError);
					});
				if (failedAttemptId !== hikarinagiOAuthAttempt.attemptId) return;
				hikarinagiOAuthAttempt.finish(failedAttemptId, sessionId);
				snackbar.error(
					t(
						"pages.Settings.hikarinagiAuth.oauthStartError",
						"启动 Hikarinagi OAuth 登录失败: {{error}}",
						{ error: toError(error).message },
					),
				);
			});
			snackbar.info(
				t(
					"pages.Settings.hikarinagiAuth.oauthWaiting",
					"请在浏览器中完成 Hikarinagi 授权...",
				),
			);
		} catch (error) {
			if (!hikarinagiOAuthAttempt.isCurrent(attemptId)) {
				await settingsService
					.hikarinagiOAuthCancelLogin(sessionId)
					.catch((cancelError) => {
						console.error(cancelError);
					});
				return;
			}
			console.error(error);
			hikarinagiOAuthAttempt.clearEventListeners();
			const failedAttemptId = hikarinagiOAuthAttempt.invalidate();
			await settingsService
				.hikarinagiOAuthCancelLogin(sessionId)
				.catch((cancelError) => {
					console.error(cancelError);
				});
			if (failedAttemptId !== hikarinagiOAuthAttempt.attemptId) return;
			hikarinagiOAuthAttempt.finish(failedAttemptId, sessionId);
			snackbar.error(
				t(
					"pages.Settings.hikarinagiAuth.oauthStartError",
					"启动 Hikarinagi OAuth 登录失败: {{error}}",
					{ error: toError(error).message },
				),
			);
		}
	}, [t, updateSettingsMutation]);

	const handleCancelOAuth = useCallback(async () => {
		if (
			!hikarinagiOAuthAttempt.isRunning ||
			hikarinagiOAuthAttempt.isCommitting
		)
			return;

		const sessionId = hikarinagiOAuthAttempt.sessionId;
		const cancelAttemptId = hikarinagiOAuthAttempt.invalidate();
		hikarinagiOAuthAttempt.clearEventListeners();
		try {
			if (sessionId !== null) {
				await settingsService.hikarinagiOAuthCancelLogin(sessionId);
			}
			if (cancelAttemptId !== hikarinagiOAuthAttempt.attemptId) return;
			snackbar.info(
				t(
					"pages.Settings.hikarinagiAuth.oauthCancelled",
					"Hikarinagi OAuth 登录已取消",
				),
			);
		} catch (error) {
			if (cancelAttemptId !== hikarinagiOAuthAttempt.attemptId) return;
			console.error(error);
			snackbar.error(
				t(
					"pages.Settings.hikarinagiAuth.oauthCancelError",
					"取消 Hikarinagi OAuth 登录失败: {{error}}",
					{ error: toError(error).message },
				),
			);
		} finally {
			hikarinagiOAuthAttempt.finish(cancelAttemptId, sessionId);
		}
	}, [t]);

	const handleLogout = useCallback(async () => {
		try {
			await logoutHikarinagiAuth();
			snackbar.success(
				t(
					"pages.Settings.hikarinagiAuth.logoutSuccess",
					"已退出 Hikarinagi 登录",
				),
			);
		} catch (error) {
			console.error(error);
			snackbar.error(
				t(
					"pages.Settings.hikarinagiAuth.logoutError",
					"退出 Hikarinagi 登录失败",
				),
			);
		}
	}, [t]);

	return {
		hikarinagiAuth,
		hikarinagiProfile,
		isSettingsLoading,
		isOAuthLoading,
		isSaving: updateSettingsMutation.isPending,
		handleOAuthLogin,
		handleCancelOAuth,
		handleLogout,
	};
}
