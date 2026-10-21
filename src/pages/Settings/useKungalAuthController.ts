import { listen } from "@tauri-apps/api/event";
import { open as openurl } from "@tauri-apps/plugin-shell";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAllSettings, useUpdateSettings } from "@/hooks/queries/useSettings";
import { snackbar } from "@/providers/snackBar";
import { settingsService } from "@/services/invoke";
import { logoutKungalAuth } from "@/services/oauth/kungalAuthSession";
import { createOAuthAttemptLifecycle } from "@/services/oauth/oauthAttemptLifecycle";
import { completeAndPersistOAuthAuth } from "@/services/oauth/oauthAuthCommit";
import {
	createOAuthSessionId,
	type OAuthCallbackErrorPayload,
	type OAuthCallbackPayload,
} from "@/services/oauth/oauthAuthSession";
import { toError } from "@/utils/errors";

const kungalOAuthAttempt = createOAuthAttemptLifecycle();

export function useKungalAuthController() {
	const { t } = useTranslation();
	const { data: settings, isLoading: isSettingsLoading } = useAllSettings();
	const kungalAuth = settings?.kungal_auth;
	const updateSettingsMutation = useUpdateSettings();
	const [isOAuthLoading, setIsOAuthLoading] = useState(
		kungalOAuthAttempt.isRunning,
	);

	useEffect(() => {
		return kungalOAuthAttempt.subscribe(setIsOAuthLoading);
	}, []);

	const handleOAuthLogin = useCallback(async () => {
		if (kungalOAuthAttempt.isRunning) {
			snackbar.info(
				t(
					"pages.Settings.kungalAuth.oauthWaiting",
					"请在浏览器中完成 KunGal / NextMoe 授权...",
				),
			);
			return;
		}

		const sessionId = createOAuthSessionId();
		const attemptId = kungalOAuthAttempt.begin(sessionId);
		try {
			kungalOAuthAttempt.setRunning(true);
			const authorizeUrl =
				await settingsService.kungalOAuthStartLogin(sessionId);
			if (!kungalOAuthAttempt.isCurrent(attemptId)) {
				await settingsService.kungalOAuthCancelLogin(sessionId);
				return;
			}
			kungalOAuthAttempt.clearEventListeners();

			const codeUnlisten = await listen<OAuthCallbackPayload>(
				"kungal-oauth-code",
				async (event) => {
					if (
						!kungalOAuthAttempt.isCurrent(attemptId) ||
						event.payload.session_id !== sessionId
					)
						return;
					kungalOAuthAttempt.clearEventListeners();
					try {
						const codeVerifier = event.payload.code_verifier?.trim();
						if (!codeVerifier) {
							throw new Error("KunGal OAuth 回调缺少 PKCE verifier");
						}
						const auth = await settingsService.kungalOAuthExchangeCode(
							event.payload.code,
							codeVerifier,
						);
						const didPersist = await completeAndPersistOAuthAuth({
							auth,
							isCurrentAttempt: () => kungalOAuthAttempt.isCurrent(attemptId),
							persistAuth: (exchangedAuth) =>
								updateSettingsMutation.mutateAsync({
									kungalAuth: exchangedAuth,
								}),
							setCommitting: (committing) => {
								kungalOAuthAttempt.setCommitting(committing);
							},
						});
						if (!didPersist || !kungalOAuthAttempt.isCurrent(attemptId)) return;
						snackbar.success(
							t(
								"pages.Settings.kungalAuth.oauthSuccess",
								"KunGal OAuth 登录成功",
							),
						);
					} catch (error) {
						if (!kungalOAuthAttempt.isCurrent(attemptId)) return;
						console.error(error);
						snackbar.error(
							t(
								"pages.Settings.kungalAuth.oauthError",
								"KunGal OAuth 登录失败: {{error}}",
								{ error: toError(error).message },
							),
						);
					} finally {
						kungalOAuthAttempt.finish(attemptId, sessionId);
					}
				},
			);

			if (!kungalOAuthAttempt.isCurrent(attemptId)) {
				codeUnlisten();
				await settingsService.kungalOAuthCancelLogin(sessionId);
				return;
			}

			const errorUnlisten = await listen<OAuthCallbackErrorPayload>(
				"kungal-oauth-error",
				(event) => {
					if (
						!kungalOAuthAttempt.isCurrent(attemptId) ||
						event.payload.session_id !== sessionId
					)
						return;
					kungalOAuthAttempt.clearEventListeners();
					kungalOAuthAttempt.finish(attemptId, sessionId);
					snackbar.error(
						t(
							"pages.Settings.kungalAuth.oauthError",
							"KunGal OAuth 登录失败: {{error}}",
							{ error: event.payload.message },
						),
					);
				},
			);

			if (!kungalOAuthAttempt.isCurrent(attemptId)) {
				codeUnlisten();
				errorUnlisten();
				await settingsService.kungalOAuthCancelLogin(sessionId);
				return;
			}

			kungalOAuthAttempt.setEventListeners([codeUnlisten, errorUnlisten]);
			void openurl(authorizeUrl).catch(async (error) => {
				if (!kungalOAuthAttempt.isCurrent(attemptId)) return;
				console.error(error);
				kungalOAuthAttempt.clearEventListeners();
				const failedAttemptId = kungalOAuthAttempt.invalidate();
				await settingsService
					.kungalOAuthCancelLogin(sessionId)
					.catch((cancelError) => {
						console.error(cancelError);
					});
				if (failedAttemptId !== kungalOAuthAttempt.attemptId) return;
				kungalOAuthAttempt.finish(failedAttemptId, sessionId);
				snackbar.error(
					t(
						"pages.Settings.kungalAuth.oauthStartError",
						"启动 KunGal OAuth 登录失败: {{error}}",
						{ error: toError(error).message },
					),
				);
			});

			snackbar.info(
				t(
					"pages.Settings.kungalAuth.oauthWaiting",
					"请在浏览器中完成 KunGal 授权...",
				),
			);
		} catch (error) {
			if (!kungalOAuthAttempt.isCurrent(attemptId)) {
				await settingsService
					.kungalOAuthCancelLogin(sessionId)
					.catch((cancelError) => {
						console.error(cancelError);
					});
				return;
			}
			console.error(error);
			kungalOAuthAttempt.clearEventListeners();
			const failedAttemptId = kungalOAuthAttempt.invalidate();
			await settingsService
				.kungalOAuthCancelLogin(sessionId)
				.catch((cancelError) => {
					console.error(cancelError);
				});
			if (failedAttemptId !== kungalOAuthAttempt.attemptId) return;
			kungalOAuthAttempt.finish(failedAttemptId, sessionId);
			snackbar.error(
				t(
					"pages.Settings.kungalAuth.oauthStartError",
					"启动 KunGal OAuth 登录失败: {{error}}",
					{ error: toError(error).message },
				),
			);
		}
	}, [t, updateSettingsMutation]);

	const handleCancelOAuth = useCallback(async () => {
		if (!kungalOAuthAttempt.isRunning || kungalOAuthAttempt.isCommitting)
			return;

		const sessionId = kungalOAuthAttempt.sessionId;
		const cancelAttemptId = kungalOAuthAttempt.invalidate();
		kungalOAuthAttempt.clearEventListeners();
		try {
			if (sessionId !== null) {
				await settingsService.kungalOAuthCancelLogin(sessionId);
			}
			if (cancelAttemptId !== kungalOAuthAttempt.attemptId) return;
			snackbar.info(
				t(
					"pages.Settings.kungalAuth.oauthCancelled",
					"KunGal OAuth 登录已取消",
				),
			);
		} catch (error) {
			if (cancelAttemptId !== kungalOAuthAttempt.attemptId) return;
			console.error(error);
			snackbar.error(
				t(
					"pages.Settings.kungalAuth.oauthCancelError",
					"取消 KunGal OAuth 登录失败: {{error}}",
					{ error: toError(error).message },
				),
			);
		} finally {
			kungalOAuthAttempt.finish(cancelAttemptId, sessionId);
		}
	}, [t]);

	const handleLogout = useCallback(async () => {
		try {
			await logoutKungalAuth();
			snackbar.success(
				t("pages.Settings.kungalAuth.logoutSuccess", "已退出 KunGal 登录"),
			);
		} catch (error) {
			console.error(error);
			snackbar.error(
				t("pages.Settings.kungalAuth.logoutError", "退出 KunGal 登录失败"),
			);
		}
	}, [t]);

	return {
		kungalAuth,
		isSettingsLoading,
		isOAuthLoading,
		isSaving: updateSettingsMutation.isPending,
		handleOAuthLogin,
		handleCancelOAuth,
		handleLogout,
	};
}
