import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import SaveAsRoundedIcon from "@mui/icons-material/SaveAsRounded";
import { Switch, TextField, Typography } from "@mui/material";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import { type ChangeEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { ButtonLoadingIndicator } from "@/components/ui/ButtonLoadingIndicator";
import { snackbar } from "@/providers/snackBar";
import { exportUserData } from "@/services/fs/dataMaintenance";
import { openDatabaseBackupFolder } from "@/services/fs/savedataBackup";
import { useStore } from "@/store/appStore";
import { getUserErrorMessage } from "@/utils/errors";
import { SettingsGroup, SettingsItem } from "./SettingsLayout";

type BackupNumberFieldProps = {
	id: string;
	label: string;
	value: number;
	min: number;
	disabled: boolean;
	onChange: (event: ChangeEvent<HTMLInputElement>) => void;
	helperText?: string;
};

const BackupNumberField = ({
	id,
	label,
	value,
	min,
	disabled,
	onChange,
	helperText,
}: BackupNumberFieldProps) => (
	<Box className="auto-backup-number-setting">
		<Typography
			component="label"
			htmlFor={id}
			variant="caption"
			className="auto-backup-number-setting__label"
		>
			{label}
		</Typography>
		<TextField
			id={id}
			type="number"
			size="small"
			value={value}
			onChange={onChange}
			disabled={disabled}
			helperText={helperText}
			fullWidth
			slotProps={{ htmlInput: { min } }}
		/>
	</Box>
);

export const DatabaseBackupSettings = () => {
	const { t } = useTranslation();
	const [isExportingUserData, setIsExportingUserData] = useState(false);
	const {
		autoBackupLastError,
		autoBackupLastSuccessAt,
		autoBackupMinIntervalHours,
		autoBackupOnExit,
		autoBackupRetentionCount,
		setAutoBackupMinIntervalHours,
		setAutoBackupOnExit,
		setAutoBackupRetentionCount,
	} = useStore(
		useShallow((s) => ({
			autoBackupLastError: s.autoBackupLastError,
			autoBackupLastSuccessAt: s.autoBackupLastSuccessAt,
			autoBackupMinIntervalHours: s.autoBackupMinIntervalHours,
			autoBackupOnExit: s.autoBackupOnExit,
			autoBackupRetentionCount: s.autoBackupRetentionCount,
			setAutoBackupMinIntervalHours: s.setAutoBackupMinIntervalHours,
			setAutoBackupOnExit: s.setAutoBackupOnExit,
			setAutoBackupRetentionCount: s.setAutoBackupRetentionCount,
		})),
	);

	const handleMinIntervalChange = (event: ChangeEvent<HTMLInputElement>) => {
		setAutoBackupMinIntervalHours(Number(event.target.value));
	};

	const handleRetentionCountChange = (event: ChangeEvent<HTMLInputElement>) => {
		setAutoBackupRetentionCount(Number(event.target.value));
	};

	const lastAutoBackupText = autoBackupLastSuccessAt
		? new Date(autoBackupLastSuccessAt).toLocaleString()
		: t("pages.Settings.databaseBackup.autoNever", "从未自动备份");

	const handleOpenBackupFolder = async () => {
		try {
			await openDatabaseBackupFolder();
		} catch (error) {
			const errorMessage = getUserErrorMessage(
				error,
				t,
				t("pages.Settings.databaseBackup.openFolderFailed", "打开文件夹失败"),
			);
			snackbar.error(
				t(
					"pages.Settings.databaseBackup.openFolderError",
					"打开备份文件夹失败: {{error}}",
					{
						error: errorMessage,
					},
				),
			);
		}
	};

	const handleExportUserData = async () => {
		setIsExportingUserData(true);
		try {
			const result = await exportUserData();
			if (result) {
				snackbar.success(`${result.message}: ${result.path}`);
			}
		} catch (error) {
			snackbar.error(`用户数据导出失败: ${getUserErrorMessage(error, t)}`);
		} finally {
			setIsExportingUserData(false);
		}
	};

	return (
		<SettingsGroup
			title={t("pages.Settings.databaseBackup.title", "数据备份与恢复")}
		>
			<Stack
				direction="row"
				spacing={2}
				useFlexGap
				alignItems="center"
				flexWrap="wrap"
			>
				<Button
					variant="contained"
					color="primary"
					onClick={handleExportUserData}
					disabled={isExportingUserData}
					startIcon={
						isExportingUserData ? (
							<ButtonLoadingIndicator color="inherit" />
						) : (
							<SaveAsRoundedIcon />
						)
					}
					className="px-6 py-2 skerry-button-level-a skerry-button-level-a-gradient"
				>
					{isExportingUserData ? "导出中..." : "一键导出用户数据"}
				</Button>

				<Button
					variant="outlined"
					color="primary"
					onClick={handleOpenBackupFolder}
					startIcon={<FolderOpenIcon />}
					className="px-6 py-2"
				>
					{t("pages.Settings.databaseBackup.openFolder", "打开备份文件夹")}
				</Button>
			</Stack>

			<SettingsItem
				title={t(
					"pages.Settings.databaseBackup.autoBackupOnExit",
					"退出时自动备份",
				)}
				description={t(
					"pages.Settings.databaseBackup.autoBackupOnExitDescription",
					"开启后，软件正常退出时会自动备份数据库。",
				)}
			>
				<Switch
					checked={autoBackupOnExit}
					onChange={(event) => setAutoBackupOnExit(event.target.checked)}
					color="primary"
				/>
			</SettingsItem>
			<Box className="space-y-3">
				<Stack direction="row" spacing={2} useFlexGap flexWrap="wrap">
					<BackupNumberField
						id="auto-backup-min-interval-hours"
						label={t(
							"pages.Settings.databaseBackup.autoMinIntervalHours",
							"最小间隔（小时）",
						)}
						value={autoBackupMinIntervalHours}
						min={0}
						disabled={!autoBackupOnExit}
						onChange={handleMinIntervalChange}
						helperText={t(
							"pages.Settings.databaseBackup.autoMinIntervalHelp",
							"填 0 表示每次退出都备份",
						)}
					/>
					<BackupNumberField
						id="auto-backup-retention-count"
						label={t(
							"pages.Settings.databaseBackup.autoRetentionCount",
							"最多保留自动备份（份）",
						)}
						value={autoBackupRetentionCount}
						min={1}
						disabled={!autoBackupOnExit}
						onChange={handleRetentionCountChange}
					/>
				</Stack>

				<Typography variant="caption" color="text.secondary" className="block">
					{t(
						"pages.Settings.databaseBackup.lastAutoBackup",
						"上次自动备份：{{time}}",
						{ time: lastAutoBackupText },
					)}
				</Typography>
				{autoBackupLastError && (
					<Typography variant="caption" color="error" className="block mt-1">
						{t(
							"pages.Settings.databaseBackup.lastAutoBackupError",
							"上次自动备份失败：{{error}}",
							{ error: autoBackupLastError },
						)}
					</Typography>
				)}
			</Box>
		</SettingsGroup>
	);
};
