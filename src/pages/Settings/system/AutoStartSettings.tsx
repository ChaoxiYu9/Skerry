import Switch from "@mui/material/Switch";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	getAutostartEnabled,
	setAutostartEnabled,
} from "@/services/plugins/autoStartService";
import {
	GPU_ACCELERATION_STORE_KEY,
	loadSystemSettingsStore,
	SILENT_STARTUP_STORE_KEY,
} from "./systemSettingsStore";
import { SettingsGroup, SettingsItem } from "../SettingsLayout";

export const AutoStartSettings = () => {
	const { t } = useTranslation();
	const [autoStart, setAutoStart] = useState(false);
	const [autoStartLoading, setAutoStartLoading] = useState(true);
	const autoStartActionLock = useRef(false);
	const [silentStartup, setSilentStartup] = useState(false);
	const [silentStartupLoading, setSilentStartupLoading] = useState(true);
	const [gpuAcceleration, setGpuAcceleration] = useState(true);
	const [gpuAccelerationLoading, setGpuAccelerationLoading] = useState(true);

	useEffect(() => {
		const checkAutoStart = async () => {
			try {
				setAutoStart(await getAutostartEnabled());
			} catch (error) {
				console.error("读取开机启动状态失败:", error);
			} finally {
				setAutoStartLoading(false);
			}
		};
		const loadSilentStartup = async () => {
			try {
				const store = await loadSystemSettingsStore();
				setSilentStartup(
					(await store.get<boolean>(SILENT_STARTUP_STORE_KEY)) ?? false,
				);
			} catch (error) {
				console.error("读取静默启动设置失败:", error);
			} finally {
				setSilentStartupLoading(false);
			}
		};

		const loadGpuAcceleration = async () => {
			try {
				const store = await loadSystemSettingsStore();
				const val = await store.get<boolean>(GPU_ACCELERATION_STORE_KEY);
				setGpuAcceleration(val ?? true);
			} catch (error) {
				console.error("读取 GPU 加速设置失败:", error);
				setGpuAcceleration(true);
			} finally {
				setGpuAccelerationLoading(false);
			}
		};

		void checkAutoStart();
		void loadSilentStartup();
		void loadGpuAcceleration();
	}, []);

	const handleAutoStartChange = async (enabled: boolean) => {
		if (autoStartActionLock.current) {
			return;
		}

		autoStartActionLock.current = true;
		const previous = autoStart;
		setAutoStartLoading(true);
		setAutoStart(enabled);

		try {
			setAutoStart(await setAutostartEnabled(enabled));
		} catch (error) {
			console.error("保存开机启动设置失败:", error);
			try {
				setAutoStart(await getAutostartEnabled());
			} catch (readError) {
				console.error("重新读取开机启动状态失败:", readError);
				setAutoStart(previous);
			}
		} finally {
			autoStartActionLock.current = false;
			setAutoStartLoading(false);
		}
	};

	const handleSilentStartupChange = async (enabled: boolean) => {
		setSilentStartup(enabled);
		setSilentStartupLoading(true);

		try {
			const store = await loadSystemSettingsStore();
			await store.set(SILENT_STARTUP_STORE_KEY, enabled);
			await store.save();
		} catch (error) {
			setSilentStartup(!enabled);
			console.error("保存静默启动设置失败:", error);
		} finally {
			setSilentStartupLoading(false);
		}
	};

	const handleGpuAccelerationChange = async (enabled: boolean) => {
		setGpuAcceleration(enabled);
		setGpuAccelerationLoading(true);

		try {
			const store = await loadSystemSettingsStore();
			await store.set(GPU_ACCELERATION_STORE_KEY, enabled);
			await store.save();
		} catch (error) {
			setGpuAcceleration(!enabled);
			console.error("保存 GPU 加速设置失败:", error);
		} finally {
			setGpuAccelerationLoading(false);
		}
	};

	return (
		<SettingsGroup
			title={t("pages.Settings.startup.title", "启动设置")}
			description={t(
				"pages.Settings.startup.description",
				"管理开机自启和应用窗口启动行为。",
			)}
		>
			<SettingsItem
				title={t("pages.Settings.autoStart", "开机自启")}
				description={t(
					"pages.Settings.autoStartDescription",
					"系统登录后自动启动应用。",
				)}
			>
				<Switch
					checked={autoStart}
					disabled={autoStartLoading}
					onChange={(_, enabled) => void handleAutoStartChange(enabled)}
					color="primary"
				/>
			</SettingsItem>
			<SettingsItem
				title={t("pages.Settings.silentStartup", "静默启动")}
				description={t(
					"pages.Settings.silentStartupDescription",
					"启动时不显示主窗口，应用将在系统托盘中运行。",
				)}
			>
				<Switch
					checked={silentStartup}
					onChange={(event) =>
						void handleSilentStartupChange(event.target.checked)
					}
					disabled={silentStartupLoading}
					color="primary"
				/>
			</SettingsItem>
			<SettingsItem
				title={t("pages.Settings.gpuAcceleration", "GPU 硬件加速")}
				description={t(
					"pages.Settings.gpuAccelerationDescription",
					"启用 Chromium GPU 栅格化与硬件合成加速，提升滚动与界面交互流畅度（修改后重启应用生效）。",
				)}
			>
				<Switch
					checked={gpuAcceleration}
					onChange={(event) =>
						void handleGpuAccelerationChange(event.target.checked)
					}
					disabled={gpuAccelerationLoading}
					color="primary"
				/>
			</SettingsItem>
		</SettingsGroup>
	);
};
