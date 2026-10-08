# -*- coding: utf-8 -*-
code = '''/**
 * @file PathSettingsModal 路径设置控制台
 * @description 资源插槽式路径与外部工具控制台，管理游戏库、备份与第三方工具联动（LE/Magpie）
 * @module src/components/PathSettingsModal/index
 * @copyright AGPL-3.0
 */

import BuildRoundedIcon from "@mui/icons-material/BuildRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import FolderOpenRoundedIcon from "@mui/icons-material/FolderOpenRounded";
import OpenInNewRoundedIcon from "@mui/icons-material/OpenInNewRounded";
import StorageRoundedIcon from "@mui/icons-material/StorageRounded";
import WallpaperRoundedIcon from "@mui/icons-material/WallpaperRounded";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import Switch from "@mui/material/Switch";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { dirname } from "pathe";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAllSettings, useUpdateSettings } from "@/hooks/queries/useSettings";
import { snackbar } from "@/providers/snackBar";
import { handleExeFile, handleFolder } from "@/services/fs/fileDialog";
import { getAppDataDirPath } from "@/services/fs/pathCache";
import { moveBackupFolder } from "@/services/fs/savedataBackup";
import { fileService } from "@/services/invoke";
import { getUserErrorMessage } from "@/utils/errors";

interface PathSettingsModalProps {
	open: boolean;
	onClose: () => void;
	inSettingsPage?: boolean;
}

type PathSettingsStringKey =
	| "installRootPath"
	| "savePath"
	| "lePath"
	| "magpiePath"
	| "dbBackupPath"
	| "detailBackdropPath";

interface PathSettingsDraft {
	installRootPath: string;
	savePath: string;
	lePath: string;
	magpiePath: string;
	dbBackupPath: string;
	detailBackdropPath: string;
	defaultLeLaunch: boolean;
	defaultMagpie: boolean;
}

const EMPTY_DRAFT: PathSettingsDraft = {
	installRootPath: "",
	savePath: "",
	lePath: "",
	magpiePath: "",
	dbBackupPath: "",
	detailBackdropPath: "",
	defaultLeLaunch: false,
	defaultMagpie: false,
};

interface ResourceSlotCardProps {
	icon: React.ReactNode;
	title: string;
	note: string;
	path: string;
	placeholder: string;
	onBrowse: () => void;
	onOpenExplorer?: () => void;
	onChangePath: (value: string) => void;
	onBlur: () => void;
	onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
	extraControl?: React.ReactNode;
}

const ResourceSlotCard: React.FC<ResourceSlotCardProps> = ({
	icon,
	title,
	note,
	path,
	placeholder,
	onBrowse,
	onOpenExplorer,
	onChangePath,
	onBlur,
	onKeyDown,
	extraControl,
}) => {
	const hasConfigured = Boolean(path && path.trim().length > 0);

	return (
		<Box className="rounded-2xl border border-[var(--mui-palette-divider)]/40 bg-black/[0.02] dark:bg-white/[0.02] hover:border-[var(--mui-palette-primary-main)]/35 hover:bg-black/[0.03] dark:hover:bg-white/[0.03] transition-all p-3.5 space-y-2.5">
			<Box className="flex items-center justify-between gap-3">
				<Box className="flex items-center gap-2.5 min-w-0">
					<Box
						sx={{
							width: 32,
							height: 32,
							borderRadius: "10px",
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							backgroundColor: "rgba(224, 82, 32, 0.1)",
							color: "#E05220",
							border: "1px solid rgba(224, 82, 32, 0.2)",
							flexShrink: 0,
						}}
					>
						{icon}
					</Box>
					<Box className="min-w-0">
						<Box className="flex items-center gap-2">
							<Typography variant="subtitle2" className="font-bold text-xs tracking-tight truncate text-[var(--mui-palette-text-primary)]">
								{title}
							</Typography>
							<Box
								className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${
									hasConfigured
										? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25"
										: "bg-neutral-500/10 text-neutral-500 dark:text-neutral-400 border border-neutral-500/20"
								}`}
							>
								<Box
									className={`w-1.5 h-1.5 rounded-full ${
										hasConfigured ? "bg-emerald-500 animate-pulse" : "bg-neutral-400"
									}`}
								/>
								{hasConfigured ? "已配置" : "默认目录"}
							</Box>
						</Box>
						<Typography variant="caption" color="text.secondary" className="block text-[11px] truncate mt-0.5">
							{note}
						</Typography>
					</Box>
				</Box>

				{extraControl && <Box className="shrink-0">{extraControl}</Box>}
			</Box>

			{/* 一体化路径输入控制栏 */}
			<Box className="flex items-center gap-2 p-1 pl-2.5 rounded-xl border border-[var(--mui-palette-divider)]/40 bg-black/[0.03] dark:bg-black/30 hover:border-[var(--mui-palette-primary-main)]/30 focus-within:border-[var(--mui-palette-primary-main)]/60 transition-colors">
				<FolderOpenRoundedIcon sx={{ fontSize: 18, color: "text.secondary", opacity: 0.7, flexShrink: 0 }} />
				<input
					type="text"
					value={path}
					placeholder={placeholder}
					onChange={(e) => onChangePath(e.target.value)}
					onBlur={onBlur}
					onKeyDown={onKeyDown}
					className="font-mono text-xs flex-1 py-1 bg-transparent text-[var(--mui-palette-text-primary)] placeholder:text-[var(--mui-palette-text-secondary)]/50 focus:outline-none min-w-0"
				/>

				{hasConfigured && onOpenExplorer && (
					<Tooltip title="在系统资源管理器中打开">
						<IconButton
							size="small"
							onClick={onOpenExplorer}
							className="rounded-lg hover:bg-black/10 dark:hover:bg-white/10 transition-colors p-1"
						>
							<OpenInNewRoundedIcon sx={{ fontSize: 16, color: "text.secondary" }} />
						</IconButton>
					</Tooltip>
				)}

				<Button
					size="small"
					onClick={onBrowse}
					sx={{
						borderRadius: "10px",
						px: 1.5,
						py: 0.4,
						minWidth: "unset",
						fontSize: "0.75rem",
						fontWeight: 700,
						color: "#ffffff",
						background: "linear-gradient(135deg, #E05220 0%, #F16E36 100%)",
						boxShadow: "0 2px 8px rgba(224, 82, 32, 0.25)",
						textTransform: "none",
						flexShrink: 0,
						"&:hover": {
							filter: "brightness(1.06)",
						},
					}}
				>
					{hasConfigured ? "更改" : "浏览选择"}
				</Button>
			</Box>
		</Box>
	);
};

export const PathSettingsModal: React.FC<PathSettingsModalProps> = ({
	open,
	onClose,
	inSettingsPage = true,
}) => {
	const { t } = useTranslation();
	const { data: settings } = useAllSettings({ enabled: open });
	const updateSettingsMutation = useUpdateSettings();

	const [draft, setDraft] = useState<PathSettingsDraft>(EMPTY_DRAFT);
	const [initialDraft, setInitialDraft] = useState<PathSettingsDraft>(EMPTY_DRAFT);
	const initialSavePathRef = useRef("");

	useEffect(() => {
		if (!open) return;
		if (settings) {
			const loadedDraft: PathSettingsDraft = {
				installRootPath: settings.install_root_path || "",
				savePath: settings.save_path || "",
				lePath: settings.le_path || "",
				magpiePath: settings.magpie_path || "",
				dbBackupPath: settings.db_backup_path || "",
				detailBackdropPath: settings.detail_backdrop_path || "",
				defaultLeLaunch: Boolean(settings.default_le_launch),
				defaultMagpie: Boolean(settings.default_magpie),
			};
			setDraft(loadedDraft);
			setInitialDraft(loadedDraft);
			initialSavePathRef.current = loadedDraft.savePath;
		}
	}, [open, settings]);

	const updateDraft = useCallback(
		<K extends keyof PathSettingsDraft>(key: K, value: PathSettingsDraft[K]) => {
			setDraft((prev) => ({ ...prev, [key]: value }));
		},
		[],
	);

	const handleCommitPath = useCallback(
		async (key: PathSettingsStringKey, explicitValue?: string) => {
			const value = (explicitValue ?? draft[key]).trim();
			if (value === initialDraft[key]) return;

			if (key === "savePath") {
				const from = initialSavePathRef.current;
				const to = value || (await getAppDataDirPath());
				if (from) {
					try {
						await moveBackupFolder(from, to);
						initialSavePathRef.current = value;
					} catch (error) {
						snackbar.error(
							`移动备份文件夹失败: ${getUserErrorMessage(error, t)}`,
						);
						return;
					}
				}
			}

			const payloadKeyMap: Record<PathSettingsStringKey, string> = {
				installRootPath: "install_root_path",
				savePath: "save_path",
				lePath: "le_path",
				magpiePath: "magpie_path",
				dbBackupPath: "db_backup_path",
				detailBackdropPath: "detail_backdrop_path",
			};

			try {
				await updateSettingsMutation.mutateAsync({
					[payloadKeyMap[key]]: value || null,
				});
				setInitialDraft((prev) => ({ ...prev, [key]: value }));
				snackbar.success(t("common.saved", "已保存"));
			} catch (error) {
				snackbar.error(getUserErrorMessage(error, t));
			}
		},
		[draft, initialDraft, t, updateSettingsMutation],
	);

	const handleBrowseFolder = useCallback(
		async (key: "installRootPath" | "savePath" | "dbBackupPath" | "detailBackdropPath") => {
			const selected = await handleFolder();
			if (selected) {
				updateDraft(key, selected);
				await handleCommitPath(key, selected);
			}
		},
		[handleCommitPath, updateDraft],
	);

	const handleBrowseExe = useCallback(
		async (key: "lePath" | "magpiePath") => {
			const selected = await handleExeFile();
			if (selected) {
				updateDraft(key, selected);
				await handleCommitPath(key, selected);
			}
		},
		[handleCommitPath, updateDraft],
	);

	const handleOpenInExplorer = useCallback(
		async (path: string) => {
			if (!path) return;
			try {
				await fileService.openPath(dirname(path));
			} catch (error) {
				snackbar.error(getUserErrorMessage(error, t));
			}
		},
		[t],
	);

	const handleToggleTool = useCallback(
		async (key: "defaultLeLaunch" | "defaultMagpie", nextVal: boolean) => {
			updateDraft(key, nextVal);
			const payloadKey = key === "defaultLeLaunch" ? "default_le_launch" : "default_magpie";
			try {
				await updateSettingsMutation.mutateAsync({
					[payloadKey]: nextVal,
				});
				setInitialDraft((prev) => ({ ...prev, [key]: nextVal }));
				snackbar.success(t("common.saved", "已保存"));
			} catch (error) {
				snackbar.error(getUserErrorMessage(error, t));
			}
		},
		[t, updateDraft, updateSettingsMutation],
	);

	const handleSaveAll = useCallback(async () => {
		try {
			await updateSettingsMutation.mutateAsync({
				install_root_path: draft.installRootPath.trim() || null,
				save_path: draft.savePath.trim() || null,
				le_path: draft.lePath.trim() || null,
				magpie_path: draft.magpiePath.trim() || null,
				db_backup_path: draft.dbBackupPath.trim() || null,
				detail_backdrop_path: draft.detailBackdropPath.trim() || null,
				default_le_launch: draft.defaultLeLaunch,
				default_magpie: draft.defaultMagpie,
			});
			snackbar.success(t("common.saved", "设置已保存"));
			onClose();
		} catch (error) {
			snackbar.error(getUserErrorMessage(error, t));
		}
	}, [draft, onClose, t, updateSettingsMutation]);

	return (
		<Dialog
			open={open}
			onClose={onClose}
			maxWidth="md"
			fullWidth
			slotProps={{
				paper: {
					className: "rounded-[28px] border border-[var(--mui-palette-divider)]/40 shadow-2xl overflow-hidden backdrop-blur-2xl",
					sx: {
						backgroundColor: "var(--skerry-glass-surface, rgba(255, 255, 255, 0.94))",
					},
				},
			}}
		>
			{/* 标题栏 */}
			<DialogTitle className="flex items-center justify-between pb-3 px-6 pt-5 border-b border-[var(--mui-palette-divider)]/25">
				<Box className="flex items-center gap-3">
					<Box
						sx={{
							width: 36,
							height: 36,
							borderRadius: "12px",
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							backgroundColor: "rgba(224, 82, 32, 0.1)",
							color: "#E05220",
							border: "1px solid rgba(224, 82, 32, 0.2)",
						}}
					>
						<StorageRoundedIcon fontSize="small" />
					</Box>
					<Box>
						<Typography variant="h6" className="font-black text-base tracking-tight leading-tight text-[var(--mui-palette-text-primary)]">
							{t("components.PathSettingsModal.title", "路径设置")}
						</Typography>
						<Typography variant="caption" color="text.secondary" className="block text-[11px] font-medium mt-0.5">
							{t(
								"components.PathSettingsModal.subtitle",
								"集中管理游戏安装库、存档备份存储位置及第三方增强工具联动",
							)}
						</Typography>
					</Box>
				</Box>
				<IconButton
					size="small"
					onClick={onClose}
					className="rounded-xl border border-[var(--mui-palette-divider)]/40 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
					aria-label="close"
				>
					<CloseRoundedIcon fontSize="small" />
				</IconButton>
			</DialogTitle>

			<DialogContent className="px-6 py-5 space-y-5">
				{/* 第一组：存储与数据插槽 */}
				<Box className="space-y-3">
					<Box className="flex items-center gap-2 px-1">
						<StorageRoundedIcon sx={{ fontSize: 16, color: "#E05220" }} />
						<Typography variant="subtitle2" className="font-bold text-xs text-[var(--mui-palette-text-primary)] uppercase tracking-wider">
							存储与数据目录
						</Typography>
					</Box>

					<Box className="grid grid-cols-1 md:grid-cols-2 gap-3">
						<ResourceSlotCard
							icon={<FolderOpenRoundedIcon sx={{ fontSize: 18 }} />}
							title={t("components.PathSettingsModal.installRootPath", "一键安装游戏目录")}
							note={t("components.PathSettingsModal.installRootPathNote", "书音等来源的一键安装会把游戏解压到此目录")}
							path={draft.installRootPath}
							placeholder="选择用于安装游戏的目录"
							onBrowse={() => void handleBrowseFolder("installRootPath")}
							onOpenExplorer={
								draft.installRootPath
									? () => void handleOpenInExplorer(draft.installRootPath)
									: undefined
							}
							onChangePath={(v) => updateDraft("installRootPath", v)}
							onBlur={() => void handleCommitPath("installRootPath")}
							onKeyDown={(e) => {
								if (e.key === "Enter") void handleCommitPath("installRootPath");
							}}
						/>

						<ResourceSlotCard
							icon={<StorageRoundedIcon sx={{ fontSize: 18 }} />}
							title={t("components.PathSettingsModal.savePath", "游戏存档备份路径")}
							note={t("components.PathSettingsModal.savePathNote", "设置游戏存档的备份根目录路径，留空将使用默认路径")}
							path={draft.savePath}
							placeholder="留空使用默认路径"
							onBrowse={() => void handleBrowseFolder("savePath")}
							onOpenExplorer={
								draft.savePath
									? () => void handleOpenInExplorer(draft.savePath)
									: undefined
							}
							onChangePath={(v) => updateDraft("savePath", v)}
							onBlur={() => void handleCommitPath("savePath")}
							onKeyDown={(e) => {
								if (e.key === "Enter") void handleCommitPath("savePath");
							}}
						/>

						<ResourceSlotCard
							icon={<StorageRoundedIcon sx={{ fontSize: 18 }} />}
							title={t("components.PathSettingsModal.dbBackupPath", "数据库备份路径")}
							note={t("components.PathSettingsModal.dbBackupPathNote", "设置数据库备份文件的保存路径，留空将使用默认路径")}
							path={draft.dbBackupPath}
							placeholder="留空使用默认路径"
							onBrowse={() => void handleBrowseFolder("dbBackupPath")}
							onOpenExplorer={
								draft.dbBackupPath
									? () => void handleOpenInExplorer(draft.dbBackupPath)
									: undefined
							}
							onChangePath={(v) => updateDraft("dbBackupPath", v)}
							onBlur={() => void handleCommitPath("dbBackupPath")}
							onKeyDown={(e) => {
								if (e.key === "Enter") void handleCommitPath("dbBackupPath");
							}}
						/>

						<ResourceSlotCard
							icon={<WallpaperRoundedIcon sx={{ fontSize: 18 }} />}
							title={t("components.PathSettingsModal.detailBackdropPath", "详情页底图与 CG 缓存路径")}
							note={t("components.PathSettingsModal.detailBackdropPathNote", "详情页底图与大图素材本地缓存位置")}
							path={draft.detailBackdropPath}
							placeholder="留空使用默认应用数据目录"
							onBrowse={() => void handleBrowseFolder("detailBackdropPath")}
							onOpenExplorer={
								draft.detailBackdropPath
									? () => void handleOpenInExplorer(draft.detailBackdropPath)
									: undefined
							}
							onChangePath={(v) => updateDraft("detailBackdropPath", v)}
							onBlur={() => void handleCommitPath("detailBackdropPath")}
							onKeyDown={(e) => {
								if (e.key === "Enter") void handleCommitPath("detailBackdropPath");
							}}
						/>
					</Box>
				</Box>

				{/* 第二组：外部工具联动与自动化 */}
				<Box className="space-y-3">
					<Box className="flex items-center gap-2 px-1">
						<BuildRoundedIcon sx={{ fontSize: 16, color: "#E05220" }} />
						<Typography variant="subtitle2" className="font-bold text-xs text-[var(--mui-palette-text-primary)] uppercase tracking-wider">
							外部工具联动与自动化
						</Typography>
					</Box>

					<Box className="grid grid-cols-1 md:grid-cols-2 gap-3">
						<ResourceSlotCard
							icon={<BuildRoundedIcon sx={{ fontSize: 18 }} />}
							title="LE转区软件路径"
							note="设置LE转区软件的可执行文件路径，用于新游戏默认启动"
							path={draft.lePath}
							placeholder="选择LE转区软件的可执行文件"
							onBrowse={() => void handleBrowseExe("lePath")}
							onOpenExplorer={
								draft.lePath
									? () => void handleOpenInExplorer(draft.lePath)
									: undefined
							}
							onChangePath={(v) => updateDraft("lePath", v)}
							onBlur={() => void handleCommitPath("lePath")}
							onKeyDown={(e) => {
								if (e.key === "Enter") void handleCommitPath("lePath");
							}}
							extraControl={
								<FormControlLabel
									control={
										<Switch
											size="small"
											checked={draft.defaultLeLaunch}
											onChange={(e) => void handleToggleTool("defaultLeLaunch", e.target.checked)}
											sx={{
												"& .MuiSwitch-switchBase.Mui-checked": {
													color: "#E05220",
													"& + .MuiSwitch-track": {
														backgroundColor: "#E05220",
													},
												},
											}}
										/>
									}
									label={<Typography variant="caption" className="font-semibold text-xs">默认启用</Typography>}
									className="m-0"
								/>
							}
						/>

						<ResourceSlotCard
							icon={<BuildRoundedIcon sx={{ fontSize: 18 }} />}
							title="Magpie软件路径"
							note="设置Magpie软件的可执行文件路径，用于新游戏默认启用缩放"
							path={draft.magpiePath}
							placeholder="选择Magpie软件的可执行文件"
							onBrowse={() => void handleBrowseExe("magpiePath")}
							onOpenExplorer={
								draft.magpiePath
									? () => void handleOpenInExplorer(draft.magpiePath)
									: undefined
							}
							onChangePath={(v) => updateDraft("magpiePath", v)}
							onBlur={() => void handleCommitPath("magpiePath")}
							onKeyDown={(e) => {
								if (e.key === "Enter") void handleCommitPath("magpiePath");
							}}
							extraControl={
								<FormControlLabel
									control={
										<Switch
											size="small"
											checked={draft.defaultMagpie}
											onChange={(e) => void handleToggleTool("defaultMagpie", e.target.checked)}
											sx={{
												"& .MuiSwitch-switchBase.Mui-checked": {
													color: "#E05220",
													"& + .MuiSwitch-track": {
														backgroundColor: "#E05220",
													},
												},
											}}
										/>
									}
									label={<Typography variant="caption" className="font-semibold text-xs">默认启用</Typography>}
									className="m-0"
								/>
							}
						/>
					</Box>
				</Box>
			</DialogContent>

			{/* 底部操作条 */}
			<DialogActions className="px-6 py-4 flex items-center justify-end gap-3 border-t border-[var(--mui-palette-divider)]/25">
				<Button
					onClick={onClose}
					className="rounded-xl px-5 py-2 font-semibold text-xs border border-[var(--mui-palette-divider)]/60 hover:bg-black/5 dark:hover:bg-white/5 text-[var(--mui-palette-text-secondary)]"
				>
					{t("common.cancel", "取消")}
				</Button>
				<Button
					variant="contained"
					onClick={() => void handleSaveAll()}
					sx={{
						borderRadius: "12px",
						px: 3.5,
						py: 1,
						fontWeight: 800,
						fontSize: "0.8125rem",
						color: "#ffffff",
						background: "linear-gradient(135deg, #E05220 0%, #F16E36 100%)",
						boxShadow: "0 4px 14px rgba(224, 82, 32, 0.28)",
						textTransform: "none",
						"&:hover": {
							filter: "brightness(1.06)",
						},
						"&:active": {
							transform: "scale(0.98)",
						},
					}}
				>
					{t("common.confirm", "确认")}
				</Button>
			</DialogActions>
		</Dialog>
	);
};

export default PathSettingsModal;
'''

with open(r"E:\galgame\Codex_xm\Wangy\Skerry\Skerry\src\components\PathSettingsModal.tsx", "w", encoding="utf-8") as f:
    f.write(code)

print("PathSettingsModal.tsx updated successfully.")
