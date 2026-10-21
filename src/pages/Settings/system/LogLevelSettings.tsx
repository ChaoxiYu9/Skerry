import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import Button from "@mui/material/Button";
import MenuItem from "@mui/material/MenuItem";
import Select, { type SelectChangeEvent } from "@mui/material/Select";
import { path } from "@tauri-apps/api";
import { join } from "pathe";
import { useTranslation } from "react-i18next";
import { useLogLevel, useSetLogLevel } from "@/hooks/queries/useSettings";
import { snackbar } from "@/providers/snackBar";
import { fileService } from "@/services/invoke";
import { getUserErrorMessage } from "@/utils/errors";
import { SettingsGroup, SettingsItem } from "../SettingsLayout";
import { logLevelOptions, parseSelectableLogLevel } from "./logLevelOptions";

export const LogLevelSettings = () => {
	const { t } = useTranslation();
	const { data: logLevel = "error" } = useLogLevel();
	const setLogLevelMutation = useSetLogLevel();

	const handleChange = async (event: SelectChangeEvent) => {
		const level = parseSelectableLogLevel(event.target.value);
		if (!level) return;

		try {
			await setLogLevelMutation.mutateAsync(level);
			snackbar.success(
				t("pages.Settings.logLevel.changed", "日志级别已切换为 {{level}}", {
					level,
				}),
			);
		} catch {
			snackbar.error(
				t("pages.Settings.logLevel.changeFailed", "切换日志级别失败"),
			);
		}
	};

	const handleOpenLogFolder = async () => {
		try {
			const AppLocalData = await path.appLocalDataDir();
			const logDir = join(AppLocalData, "logs");
			await fileService.openDirectory(logDir);
		} catch (error) {
			const errorMessage = getUserErrorMessage(
				error,
				t,
				t("pages.Settings.logLevel.openFolderFailed", "打开文件夹失败"),
			);
			snackbar.error(
				t(
					"pages.Settings.logLevel.openFolderError",
					"打开日志文件夹失败: {{error}}",
					{ error: errorMessage },
				),
			);
		}
	};

	return (
		<SettingsGroup title={t("pages.Settings.logLevel.title", "日志设置")}>
			<SettingsItem
				title={t("pages.Settings.logLevel.levelLabel", "日志输出级别")}
				description={t(
					"pages.Settings.logLevel.description",
					"仅当前会话有效，不会保存。用于临时调整后端日志输出详尽程度。",
				)}
			>
				<Select
					value={logLevel}
					onChange={handleChange}
					className="min-w-40"
					size="small"
					MenuProps={{
						PaperProps: {
							className:
								"skerry-select-menu-compact-paper skerry-select-menu-w-40",
						},
						MenuListProps: { className: "skerry-select-menu-compact" },
					}}
				>
					{logLevelOptions.map((option) => (
						<MenuItem key={option.value} value={option.value}>
							{option.label}
						</MenuItem>
					))}
				</Select>
			</SettingsItem>
			<SettingsItem
				stacked
				title={t("pages.Settings.logLevel.openFolder", "打开日志文件夹")}
			>
				<Button
					variant="outlined"
					color="primary"
					onClick={handleOpenLogFolder}
					startIcon={<FolderOpenIcon />}
					className="px-6 py-2"
				>
					{t("pages.Settings.logLevel.openFolder", "打开日志文件夹")}
				</Button>
			</SettingsItem>
		</SettingsGroup>
	);
};
