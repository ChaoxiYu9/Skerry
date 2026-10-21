import { listen } from "@tauri-apps/api/event";
import { open as openurl } from "@tauri-apps/plugin-shell";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAllSettings, useUpdateSettings } from "@/hooks/queries/useSettings";
import { buildManualBgmAuth, completeBgmAuth } from "@/metadata/api/bgm";
import { snackbar } from "@/providers/snackBar";
import { settingsService } from "@/services/invoke";
import { logoutBgmAuth } from "@/services/oauth/bgmAuthSession";
import { createOAuthAttemptLifecycle } from "@/services/oauth/oauthAttemptLifecycle";
import { completeAndPersistOAuthAuth } from "@/services/oauth/oauthAuthCommit";
import {
	createOAuthSessionId,
	type OAuthCallbackErrorPayload,
	type OAuthCallbackPayload,
} from "@/services/oauth/oauthAuthSession";
import { getNetworkRequestContext } from "@/services/requestContext";
import { toError } from "@/utils/errors";

const bgmOAuthAttempt = createOAuthAttemptLifecycle();

export function useBgmAuthController() {
	const { t } = useTranslation();
	const { data: settings, isLoading: isSettingsLoading } = useAllSettings();
	const bgmAuth = settings?.bgm_auth;
	const bgmToken = bgmAuth?.access_token ?? "";
	const updateSettingsMutation = useUpdateSettings();
	const [inputToken, setInputToken] = useState("");
	const [isOAuthLoading, setIsOAuthLoading] = useState(
		bgmOAuthAttempt.isRunning,
	);
	const [isCompletingAuth, setIsCompletingAuth] = useState(false);
	const [isSavingToken, setIsSavingToken] = useState(false);
	const isSavingTokenRef = useRef(false);

	useEffect(() => {
		setInputToken(bgmToken);
	}, [bgmToken]);

	useEffect(() => {
		return bgmOAuthAttempt.subscribe(setIsOAuthLoading);
	}, []);

	const handleOpenTokenPage = () => {
		openurl("https://next.bgm.tv/demo/access-token/create");
	};

	const handleSaveToken = async () => {
		const accessToken = inputToken.trim();
		if (accessToken === bgmToken || isSavingTokenRef.current) return;

		try {
			isSavingTokenRef.current = true;
			setIsSavingToken(true);
			if (!accessToken) {
				await logoutBgmAuth();
				return;
			}

			const auth = await buildManualBgmAuth(
				accessToken,
				getNetworkRequestContext(),
			);

			await updateSettingsMutation.mutateAsync({
				bgmAuth: auth,
			});
			snackbar.success(
				t("pages.Settings.bgmTokenSettings.saveSuccess", "BGM Token 保存成功"),
			);
		} catch (error) {
			console.error(error);
			snackbar.error(
				t(
					"pages.Settings.bgmTokenSettings.saveErrorWithDetail",
					"BGM Token 保存失败: {{error}}",
					{ error: toError(error).message },
				),
			);
		} finally {
			isSavingTokenRef.current = false;
			setIsSavingToken(false);
		}
	};

	const handleClearToken = async () => {
		setInputToken("");
		if (!bgmToken || isSavingTokenRef.current) return;

		try {
			isSavingTokenRef.current = true;
			setIsSavingToken(true);
			await logoutBgmAuth();
			snackbar.success(
				t("pages.Settings.bgmTokenSettings.logoutSuccess", "已退出 BGM 登录"),
			);
		} catch (error) {
			console.error(error);
			setInputToken(bgmToken);
			snackbar.error(
				t("pages.Settings.bgmTokenSettings.logoutError", "退出登录失败"),
			);
		} finally {
			isSavingTokenRef.current = false;
			setIsSavingToken(false);
		}
	};

	const handleOAuthLogin = useCallback(async () => {
		if (bgmOAuthAttempt.isRunning) {
			snackbar.info(
				t(
					"pages.Settings.bgmTokenSettings.oauthWaiting",
					"请在浏览器中完成授权...",
				),
			);
			return;
		}

		const sessionId = createOAuthSessionId();
		const attemptId = bgmOAuthAttempt.begin(sessionId);
		try {
			bgmOAuthAttempt.setRunning(true);
			const authorizeUrl = await settingsService.bgmOAuthStartLogin(sessionId);
			if (!bgmOAuthAttempt.isCurrent(attemptId)) {
				await settingsService.bgmOAuthCancelLogin(sessionId);
				return;
			}
			bgmOAuthAttempt.clearEventListeners();
			const codeUnlisten = await listen<OAuthCallbackPayload>(
				"bgm-oauth-code",
				async (event) => {
					if (
						!bgmOAuthAttempt.isCurrent(attemptId) ||
						event.payload.session_id !== sessionId
					)
						return;
					bgmOAuthAttempt.clearEventListeners();
					try {
						const auth = await settingsService.bgmOAuthExchangeCode(
							event.payload.code,
						);
						const didPersist = await completeAndPersistOAuthAuth({
							auth,
							isCurrentAttempt: () => bgmOAuthAttempt.isCurrent(attemptId),
							completeAuth: (exchangedAuth) =>
								completeBgmAuth(exchangedAuth, getNetworkRequestContext()),
							persistAuth: (completedAuth) =>
								updateSettingsMutation.mutateAsync({
									bgmAuth: completedAuth,
								}),
							setCommitting: (committing) => {
								bgmOAuthAttempt.setCommitting(committing);
							},
						});
						if (!didPersist || !bgmOAuthAttempt.isCurrent(attemptId)) return;
						snackbar.success(
							t(
								"pages.Settings.bgmTokenSettings.oauthSuccess",
								"Bangumi OAuth 登录成功",
							),
						);
					} catch (error) {
						if (!bgmOAuthAttempt.isCurrent(attemptId)) return;
						console.error(error);
						snackbar.error(
							t(
								"pages.Settings.bgmTokenSettings.oauthError",
								"OAuth 登录失败: {{error}}",
								{ error: toError(error).message },
							),
						);
					} finally {
						bgmOAuthAttempt.finish(attemptId, sessionId);
					}
				},
			);
			if (!bgmOAuthAttempt.isCurrent(attemptId)) {
				codeUnlisten();
				await settingsService.bgmOAuthCancelLogin(sessionId);
				return;
			}
			const errorUnlisten = await listen<OAuthCallbackErrorPayload>(
				"bgm-oauth-error",
				(event) => {
					if (
						!bgmOAuthAttempt.isCurrent(attemptId) ||
						event.payload.session_id !== sessionId
					)
						return;
					bgmOAuthAttempt.clearEventListeners();
					bgmOAuthAttempt.finish(attemptId, sessionId);
					snackbar.error(
						t(
							"pages.Settings.bgmTokenSettings.oauthError",
							"OAuth 登录失败: {{error}}",
							{ error: event.payload.message },
						),
					);
				},
			);
			if (!bgmOAuthAttempt.isCurrent(attemptId)) {
				codeUnlisten();
				errorUnlisten();
				await settingsService.bgmOAuthCancelLogin(sessionId);
				return;
			}
			bgmOAuthAttempt.setEventListeners([codeUnlisten, errorUnlisten]);
			void openurl(authorizeUrl).catch(async (error) => {
				if (!bgmOAuthAttempt.isCurrent(attemptId)) return;
				console.error(error);
				bgmOAuthAttempt.clearEventListeners();
				const failedAttemptId = bgmOAuthAttempt.invalidate();
				await settingsService
					.bgmOAuthCancelLogin(sessionId)
					.catch((cancelError) => {
						console.error(cancelError);
					});
				if (failedAttemptId !== bgmOAuthAttempt.attemptId) return;
				bgmOAuthAttempt.finish(failedAttemptId, sessionId);
				snackbar.error(
					t(
						"pages.Settings.bgmTokenSettings.oauthStartError",
						"启动 OAuth 登录失败: {{error}}",
						{ error: toError(error).message },
					),
				);
			});
			snackbar.info(
				t(
					"pages.Settings.bgmTokenSettings.oauthWaiting",
					"请在浏览器中完成授权...",
				),
			);
		} catch (error) {
			if (!bgmOAuthAttempt.isCurrent(attemptId)) {
				await settingsService
					.bgmOAuthCancelLogin(sessionId)
					.catch((cancelError) => {
						console.error(cancelError);
					});
				return;
			}
			console.error(error);
			bgmOAuthAttempt.clearEventListeners();
			const failedAttemptId = bgmOAuthAttempt.invalidate();
			await settingsService
				.bgmOAuthCancelLogin(sessionId)
				.catch((cancelError) => {
					console.error(cancelError);
				});
			if (failedAttemptId !== bgmOAuthAttempt.attemptId) return;
			bgmOAuthAttempt.finish(failedAttemptId, sessionId);
			snackbar.error(
				t(
					"pages.Settings.bgmTokenSettings.oauthStartError",
					"启动 OAuth 登录失败: {{error}}",
					{ error: toError(error).message },
				),
			);
		}
	}, [t, updateSettingsMutation]);

	const handleCancelOAuth = useCallback(async () => {
		if (!bgmOAuthAttempt.isRunning || bgmOAuthAttempt.isCommitting) return;

		const sessionId = bgmOAuthAttempt.sessionId;
		const cancelAttemptId = bgmOAuthAttempt.invalidate();
		bgmOAuthAttempt.clearEventListeners();
		try {
			if (sessionId !== null) {
				await settingsService.bgmOAuthCancelLogin(sessionId);
			}
			if (cancelAttemptId !== bgmOAuthAttempt.attemptId) return;
			snackbar.info(
				t(
					"pages.Settings.bgmTokenSettings.oauthCancelled",
					"BGM OAuth 登录已取消",
				),
			);
		} catch (error) {
			if (cancelAttemptId !== bgmOAuthAttempt.attemptId) return;
			console.error(error);
			snackbar.error(
				t(
					"pages.Settings.bgmTokenSettings.oauthCancelError",
					"取消 BGM OAuth 登录失败: {{error}}",
					{ error: toError(error).message },
				),
			);
		} finally {
			bgmOAuthAttempt.finish(cancelAttemptId, sessionId);
		}
	}, [t]);

	const handleCompleteAuth = useCallback(async () => {
		if (!bgmAuth?.access_token) return;
		try {
			setIsCompletingAuth(true);

			await updateSettingsMutation.mutateAsync({
				bgmAuth: await completeBgmAuth(bgmAuth, getNetworkRequestContext()),
			});
			snackbar.success(
				t(
					"pages.Settings.bgmTokenSettings.tokenStatusSuccess",
					"授权信息已更新",
				),
			);
		} catch (error) {
			console.error(error);
			snackbar.error(
				t(
					"pages.Settings.bgmTokenSettings.tokenStatusError",
					"无法查询 Token 状态: {{error}}",
					{ error: toError(error).message },
				),
			);
		} finally {
			setIsCompletingAuth(false);
		}
	}, [bgmAuth, t, updateSettingsMutation]);

	const handleLogout = useCallback(async () => {
		try {
			await logoutBgmAuth();
			setInputToken("");
			snackbar.success(
				t("pages.Settings.bgmTokenSettings.logoutSuccess", "已退出 BGM 登录"),
			);
		} catch (error) {
			console.error(error);
			snackbar.error(
				t("pages.Settings.bgmTokenSettings.logoutError", "退出登录失败"),
			);
		}
	}, [t]);

	return {
		bgmAuth,
		isSettingsLoading,
		inputToken,
		isOAuthLoading,
		isCompletingAuth,
		isSavingToken: isSavingToken || updateSettingsMutation.isPending,
		setInputToken,
		handleOpenTokenPage,
		handleSaveToken,
		handleClearToken,
		handleOAuthLogin,
		handleCancelOAuth,
		handleCompleteAuth,
		handleLogout,
	};
}
