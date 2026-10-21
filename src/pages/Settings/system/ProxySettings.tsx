import Box from "@mui/material/Box";
import TextField from "@mui/material/TextField";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "@/store/appStore";
import { SettingsGroup } from "../SettingsLayout";

export const ProxySettings = () => {
	const { t } = useTranslation();
	const proxyConfig = useStore((state) => state.proxyConfig);
	const proxyConfigSyncFailed = useStore(
		(state) => state.proxyConfigSyncFailed,
	);
	const setProxyConfig = useStore((state) => state.setProxyConfig);
	const [proxyUrl, setProxyUrl] = useState(proxyConfig.url);
	const [proxyUrlError, setProxyUrlError] = useState("");
	const [isSaving, setIsSaving] = useState(false);
	const isSavingRef = useRef(false);
	const proxySyncErrorMessage = proxyConfigSyncFailed
		? t(
				"pages.Settings.proxy.syncFailed",
				"代理设置未应用。按 Enter 或离开输入框可重试。",
			)
		: "";

	useEffect(() => {
		setProxyUrl(proxyConfig.url);
	}, [proxyConfig.url]);

	const validateProxyUrl = (value: string) => {
		if (!/^https?:\/\//i.test(value)) {
			return false;
		}

		try {
			const parsed = new URL(value);
			return (
				(parsed.protocol === "http:" || parsed.protocol === "https:") &&
				Boolean(parsed.hostname)
			);
		} catch {
			return false;
		}
	};

	const saveProxyUrl = async () => {
		if (isSavingRef.current) return false;

		const value = proxyUrl.trim();
		const currentConfig = useStore.getState().proxyConfig;
		if (value && !validateProxyUrl(value)) {
			setProxyUrlError(
				t(
					"pages.Settings.proxy.invalidUrl",
					"请输入以 http:// 或 https:// 开头的有效代理地址",
				),
			);
			return false;
		}

		if (
			value === currentConfig.url &&
			!useStore.getState().proxyConfigSyncFailed
		) {
			setProxyUrl(value);
			setProxyUrlError("");
			return true;
		}

		isSavingRef.current = true;
		setIsSaving(true);
		setProxyUrlError("");
		try {
			await setProxyConfig({ url: value });
			setProxyUrl(value);
			return true;
		} catch (error) {
			console.error("保存代理设置失败:", error);
			setProxyUrlError(
				t("pages.Settings.proxy.saveFailed", "代理设置保存失败，当前值未应用"),
			);
			return false;
		} finally {
			isSavingRef.current = false;
			setIsSaving(false);
		}
	};

	const handleUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		setProxyUrl(e.target.value);
		if (proxyUrlError) {
			setProxyUrlError("");
		}
	};

	return (
		<SettingsGroup
			title={t("pages.Settings.proxy.title", "网络代理设置")}
			description={t(
				"pages.Settings.proxy.description",
				"填写代理地址后应用网络请求将使用该代理；留空则使用系统网络设置。",
			)}
		>
			<Box>
				<TextField
					label={t("pages.Settings.proxy.url", "代理服务器地址")}
					variant="outlined"
					value={proxyUrl}
					onChange={handleUrlChange}
					onBlur={() => void saveProxyUrl()}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.nativeEvent.isComposing) {
							event.preventDefault();
							void saveProxyUrl();
						}
						if (event.key === "Escape") {
							setProxyUrl(proxyConfig.url);
							setProxyUrlError("");
						}
					}}
					error={Boolean(proxyUrlError)}
					helperText={proxyUrlError || proxySyncErrorMessage}
					className="w-full"
					size="small"
					placeholder="http://127.0.0.1:7890"
					disabled={isSaving}
				/>
			</Box>
		</SettingsGroup>
	);
};
