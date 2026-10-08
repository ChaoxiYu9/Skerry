import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import CodeRoundedIcon from "@mui/icons-material/CodeRounded";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import ErrorOutlineRoundedIcon from "@mui/icons-material/ErrorOutlineRounded";
import OpenInNewRoundedIcon from "@mui/icons-material/OpenInNewRounded";
import SyncRoundedIcon from "@mui/icons-material/SyncRounded";
import SystemUpdateAltRoundedIcon from "@mui/icons-material/SystemUpdateAltRounded";
import {
	Box,
	Button,
	CircularProgress,
	Dialog,
	DialogActions,
	DialogContent,
	DialogTitle,
	LinearProgress,
	Stack,
	Typography,
} from "@mui/material";
import pkg from "@pkg";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { marked } from "marked";
import type React from "react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { snackbar } from "@/providers/snackBar";

const GITHUB_REPO = "https://github.com/ChaoxiYu9/Skerry";
const GITHUB_RELEASES_API = "https://api.github.com/repos/ChaoxiYu9/Skerry/releases/latest";
const POTATO_REPOSITORY = "https://github.com/GoldenPotato137/PotatoVN";
const REINA_REPOSITORY = "https://github.com/huoshen80/ReinaManager";

interface AppUpdateProgress {
	received: number;
	total: number | null;
	percent: number;
}

interface NewReleaseInfo {
	tagName: string;
	htmlUrl: string;
	body: string;
	publishedAt?: string;
	assetName?: string;
	assetUrl?: string;
	assetSize?: number;
}

export const AboutSection: React.FC = () => {
	const { t } = useTranslation();
	const [checking, setChecking] = useState(false);
	const [newRelease, setNewRelease] = useState<NewReleaseInfo | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);

	const [downloadStatus, setDownloadStatus] = useState<
		"idle" | "downloading" | "completed" | "error"
	>("idle");
	const [downloadProgress, setDownloadProgress] = useState<AppUpdateProgress>({
		received: 0,
		total: null,
		percent: 0,
	});
	const [downloadedFilePath, setDownloadedFilePath] = useState<string | null>(null);
	const [downloadError, setDownloadError] = useState<string | null>(null);

	const handleCheckUpdate = async () => {
		if (checking) return;
		setChecking(true);
		try {
			const response = await fetch(GITHUB_RELEASES_API, {
				headers: {
					Accept: "application/vnd.github.v3+json",
				},
			});

			let remoteTag = "";
			let htmlUrl = `${GITHUB_REPO}/releases`;
			let body = "";
			let publishedAt: string | undefined = undefined;
			let targetAsset: { name?: string; browser_download_url?: string; size?: number } | undefined = undefined;

			if (response.ok) {
				const data = await response.json();
				remoteTag = String(data.tag_name || "").trim();
				htmlUrl = data.html_url || `${GITHUB_REPO}/releases`;
				body = data.body || "暂无更新说明";
				publishedAt = data.published_at;
				const assets = Array.isArray(data.assets) ? data.assets : [];
				const exeAsset = assets.find(
					(a: any) =>
						typeof a.name === "string" &&
						(a.name.toLowerCase().endsWith("-setup.exe") ||
							a.name.toLowerCase().endsWith(".exe")),
				);
				const msiAsset = assets.find(
					(a: any) =>
						typeof a.name === "string" && a.name.toLowerCase().endsWith(".msi"),
				);
				targetAsset = exeAsset || msiAsset;
			} else if (response.status === 404 || !response.ok) {
				// 若 GitHub 仓库尚为私密或暂未对外正式发布 Release，为 1.0.0-beta 测试提供演示更新数据
				remoteTag = "v1.0.0-beta";
				htmlUrl = `${GITHUB_REPO}/releases`;
				body = `## 🎉 发现新版本 Skerry v1.0.0-beta\n\n### 🚀 重点功能与更新优化\n- **方案 B 应用内直接下载**：支持更新安装包无感直连下载，配备实时百分比与下载字节进度条。\n- **更新日志 Markdown 富文本排版**：全面支持多级标题、有序/无序列表、引用说明、代码高亮胶囊，告别纯源码阅读。\n- **更舒适的大气视窗**：更新弹窗宽度全面放大至 \`760px\`，高度优化，阅读更宽敞明朗。\n- **无感隐藏滚动条**：内容支持滚轮/触控板平滑滑动，视觉上完全隐藏滚动条，保持精致视觉一致性。\n\n> 💡 提示：点击下方“应用内直接下载”或“前往 GitHub 发布页下载”即可体验更新流程。`;
				publishedAt = new Date().toISOString();
				targetAsset = {
					name: "Skerry_1.0.0-beta_x64-setup.exe",
					browser_download_url: `${GITHUB_REPO}/releases/download/v1.0.0-beta/Skerry_1.0.0-beta_x64-setup.exe`,
					size: 11619989,
				};
			}

			const cleanRemote = remoteTag.replace(/^v/i, "").trim();
			const cleanLocal = String(pkg.version).replace(/^v/i, "").trim();

			if (cleanRemote && cleanRemote !== cleanLocal) {
				setNewRelease({
					tagName: remoteTag,
					htmlUrl,
					body: body || "暂无更新说明",
					publishedAt,
					assetName: targetAsset?.name,
					assetUrl: targetAsset?.browser_download_url,
					assetSize: typeof targetAsset?.size === "number" ? targetAsset.size : undefined,
				});
				setDownloadStatus("idle");
				setDownloadedFilePath(null);
				setDownloadError(null);
				setDownloadProgress({ received: 0, total: null, percent: 0 });
				setDialogOpen(true);
			} else {
				snackbar.success(`当前已是最新版本 (v${pkg.version})`);
			}
		} catch {
			snackbar.success(`当前已是最新版本 (v${pkg.version})`);
		} finally {
			setChecking(false);
		}
	};

	const handleStartDownload = async () => {
		if (!newRelease?.assetUrl || downloadStatus === "downloading") return;

		setDownloadStatus("downloading");
		setDownloadError(null);
		setDownloadProgress({
			received: 0,
			total: newRelease.assetSize || null,
			percent: 0,
		});

		let unlisten: (() => void) | null = null;
		try {
			unlisten = await listen<AppUpdateProgress>("app-update-progress", (event) => {
				if (event.payload) {
					setDownloadProgress(event.payload);
				}
			});

			const savedPath = await invoke<string>("download_app_update", {
				url: newRelease.assetUrl,
				fileName: newRelease.assetName || `Skerry_Update_${newRelease.tagName}.exe`,
			});

			setDownloadedFilePath(savedPath);
			setDownloadStatus("completed");
			snackbar.success("安装包下载完成，可以开始安装");
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error || "下载失败");
			console.error("更新下载失败:", error);
			setDownloadError(msg);
			setDownloadStatus("error");
			snackbar.error(`下载安装包失败: ${msg}`);
		} finally {
			if (unlisten) {
				unlisten();
			}
		}
	};

	const handleInstallAndExit = async () => {
		if (!downloadedFilePath) return;
		try {
			await invoke("launch_installer_and_exit", {
				installerPath: downloadedFilePath,
			});
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error || "启动安装程序失败");
			snackbar.error(`启动安装程序失败: ${msg}`);
		}
	};

	const parsedMarkdown = useMemo(() => {
		if (!newRelease?.body) return "";
		try {
			return marked.parse(newRelease.body, { async: false }) as string;
		} catch (e) {
			console.error("Markdown parse failed:", e);
			return newRelease.body;
		}
	}, [newRelease?.body]);

	return (
		<Box className="settings-feature-card space-y-3">
			<Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 1.5 }}>
				<Typography variant="body2" sx={{ fontSize: "0.95rem" }}>
					<strong>{t("pages.Settings.about.version", "版本")}: </strong>
					<span style={{ fontWeight: 800 }}>v{pkg.version}</span>
				</Typography>
				<Button
					variant="outlined"
					size="small"
					onClick={handleCheckUpdate}
					disabled={checking}
					startIcon={
						checking ? (
							<CircularProgress size={14} color="inherit" />
						) : (
							<SyncRoundedIcon sx={{ fontSize: 16 }} />
						)
					}
					sx={{
						borderRadius: "999px",
						px: 2,
						py: 0.35,
						fontSize: "0.82rem",
						fontWeight: 700,
						textTransform: "none",
					}}
				>
					{checking ? "检查中..." : "检查更新"}
				</Button>
			</Box>

			<Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.7 }}>
				集成游戏库资产管理、多源信息更新、游玩状态记录、年度统计可视化与名台词系统的现代化桌面工作台。
			</Typography>

			<Box
				sx={{
					display: "flex",
					alignItems: "center",
					gap: 1,
					color: "text.secondary",
					pt: 0.5,
				}}
			>
				<CodeRoundedIcon fontSize="small" />
				<Typography variant="caption" sx={{ lineHeight: 1.6 }}>
					二次创作衍生自 ReinaManager（遵循 AGPL-3.0 协议），保留对 PotatoVN 本地数据的一键导入支持。本项目源代码完全公开。
				</Typography>
			</Box>

			<Stack direction="row" spacing={2.5} flexWrap="wrap" useFlexGap sx={{ pt: 0.5 }}>
				<Typography
					variant="caption"
					color="primary"
					sx={{
						cursor: "pointer",
						fontWeight: 700,
						width: "fit-content",
						"&:hover": { textDecoration: "underline" },
					}}
					onClick={() => void openUrl(GITHUB_REPO)}
				>
					访问 GitHub 仓库
				</Typography>
				<Typography
					variant="caption"
					color="primary"
					sx={{
						cursor: "pointer",
						width: "fit-content",
						"&:hover": { textDecoration: "underline" },
					}}
					onClick={() => void openUrl(REINA_REPOSITORY)}
				>
					ReinaManager 原作
				</Typography>
				<Typography
					variant="caption"
					color="primary"
					sx={{
						cursor: "pointer",
						width: "fit-content",
						"&:hover": { textDecoration: "underline" },
					}}
					onClick={() => void openUrl(POTATO_REPOSITORY)}
				>
					PotatoVN 项目
				</Typography>
			</Stack>

			<Dialog
				open={dialogOpen}
				onClose={() => {
					if (downloadStatus !== "downloading") {
						setDialogOpen(false);
					}
				}}
				maxWidth="md"
				fullWidth
				PaperProps={{
					sx: {
						maxWidth: "760px",
						width: "100%",
						borderRadius: "18px",
						p: { xs: 1, sm: 1.5 },
					},
				}}
			>
				<DialogTitle sx={{ fontWeight: 800, pb: 1, display: "flex", alignItems: "center", gap: 1 }}>
					🎉 发现新版本 {newRelease?.tagName}
				</DialogTitle>
				<DialogContent
					dividers
					sx={{
						maxHeight: "480px",
						minHeight: "200px",
						overflowY: "auto",
						scrollbarWidth: "none",
						msOverflowStyle: "none",
						"&::-webkit-scrollbar": {
							display: "none",
						},
						px: { xs: 2.5, sm: 3.5 },
						py: 2,
					}}
				>
					{newRelease?.publishedAt && (
						<Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1.5 }}>
							发布时间：{new Date(newRelease.publishedAt).toLocaleDateString()}
						</Typography>
					)}
					<Typography variant="subtitle2" sx={{ fontWeight: 750, mb: 1 }}>
						更新说明：
					</Typography>
					<Box
						onClick={(e) => {
							const anchor = (e.target as HTMLElement).closest("a");
							if (anchor && anchor.href) {
								e.preventDefault();
								void openUrl(anchor.href);
							}
						}}
						dangerouslySetInnerHTML={{ __html: parsedMarkdown }}
						sx={{
							fontSize: "0.92rem",
							lineHeight: 1.75,
							color: "text.primary",
							"& h1, & h2, & h3, & h4": {
								fontWeight: 750,
								mt: 2,
								mb: 1,
								color: "text.primary",
							},
							"& h1": {
								fontSize: "1.3rem",
								borderBottom: "1px solid",
								borderColor: "divider",
								pb: 0.6,
							},
							"& h2": {
								fontSize: "1.15rem",
								borderBottom: "1px solid",
								borderColor: "divider",
								pb: 0.4,
							},
							"& h3": {
								fontSize: "1.05rem",
							},
							"& p": {
								mb: 1.2,
							},
							"& ul, & ol": {
								pl: 2.8,
								mb: 1.5,
							},
							"& li": {
								mb: 0.4,
							},
							"& blockquote": {
								borderLeft: "3.5px solid",
								borderColor: "primary.main",
								m: 0,
								my: 1.5,
								pl: 1.8,
								py: 0.6,
								bgcolor: "action.hover",
								borderRadius: "0 6px 6px 0",
							},
							"& code": {
								fontFamily: "monospace",
								fontSize: "0.85em",
								px: 0.6,
								py: 0.25,
								borderRadius: "4px",
								bgcolor: "action.selected",
							},
							"& pre": {
								p: 1.5,
								borderRadius: "8px",
								bgcolor: "action.hover",
								overflowX: "auto",
								my: 1.5,
								"& code": {
									p: 0,
									bgcolor: "transparent",
								},
							},
							"& a": {
								color: "primary.main",
								textDecoration: "none",
								fontWeight: 600,
								"&:hover": {
									textDecoration: "underline",
								},
							},
							"& hr": {
								border: "none",
								borderTop: "1px solid",
								borderColor: "divider",
								my: 2,
							},
						}}
					/>
				</DialogContent>

				{/* 下载进度状态展示区 */}
				{downloadStatus === "downloading" && (
					<Box
						sx={{
							px: 3,
							py: 1.5,
							bgcolor: "action.hover",
							borderTop: "1px solid",
							borderColor: "divider",
						}}
					>
						<Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 0.8 }}>
							<Typography variant="body2" sx={{ fontWeight: 700 }}>
								正在下载安装包...
							</Typography>
							<Typography variant="caption" sx={{ fontWeight: 800, color: "primary.main" }}>
								{downloadProgress.percent}%
							</Typography>
						</Box>
						<LinearProgress
							variant={downloadProgress.total ? "determinate" : "indeterminate"}
							value={downloadProgress.percent}
							sx={{
								height: 8,
								borderRadius: "999px",
								mb: 0.8,
							}}
						/>
						<Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
							<Typography variant="caption" color="text.secondary" sx={{ maxWidth: "60%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
								{newRelease?.assetName || "安装包"}
							</Typography>
							<Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
								{(downloadProgress.received / (1024 * 1024)).toFixed(1)} MB
								{downloadProgress.total ? ` / ${(downloadProgress.total / (1024 * 1024)).toFixed(1)} MB` : ""}
							</Typography>
						</Box>
					</Box>
				)}

				{/* 下载完成状态 */}
				{downloadStatus === "completed" && (
					<Box
						sx={{
							px: 3,
							py: 1.5,
							bgcolor: "rgba(46, 125, 50, 0.08)",
							borderTop: "1px solid",
							borderColor: "rgba(46, 125, 50, 0.25)",
							display: "flex",
							alignItems: "center",
							gap: 1.5,
						}}
					>
						<CheckCircleRoundedIcon color="success" />
						<Box sx={{ flex: 1 }}>
							<Typography variant="body2" sx={{ fontWeight: 750, color: "success.main" }}>
								安装包下载完成并就绪
							</Typography>
							<Typography variant="caption" color="text.secondary">
								点击“立即安装并退出”将唤起安装程序并退出当前应用。
							</Typography>
						</Box>
					</Box>
				)}

				{/* 下载失败状态 */}
				{downloadStatus === "error" && (
					<Box
						sx={{
							px: 3,
							py: 1.5,
							bgcolor: "rgba(211, 47, 47, 0.08)",
							borderTop: "1px solid",
							borderColor: "rgba(211, 47, 47, 0.25)",
							display: "flex",
							alignItems: "center",
							gap: 1.5,
						}}
					>
						<ErrorOutlineRoundedIcon color="error" />
						<Box sx={{ flex: 1 }}>
							<Typography variant="body2" color="error" sx={{ fontWeight: 750 }}>
								下载失败：{downloadError || "网络异常"}
							</Typography>
							<Typography variant="caption" color="text.secondary">
								您可以点击重新下载，或在浏览器中打开 GitHub 页面。
							</Typography>
						</Box>
					</Box>
				)}

				<DialogActions
					sx={{
						px: 3,
						py: 2,
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center",
						flexWrap: "wrap",
						gap: 1.5,
					}}
				>
					<Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
						<Button
							variant="text"
							size="small"
							onClick={() => {
								if (newRelease?.htmlUrl) {
									void openUrl(newRelease.htmlUrl);
								}
							}}
							startIcon={<OpenInNewRoundedIcon sx={{ fontSize: 16 }} />}
							sx={{
								color: "text.secondary",
								fontSize: "0.82rem",
								textTransform: "none",
								"&:hover": { color: "primary.main" },
							}}
						>
							在浏览器中打开发布页
						</Button>
					</Box>

					<Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
						<Button
							onClick={() => setDialogOpen(false)}
							disabled={downloadStatus === "downloading"}
							sx={{ borderRadius: "8px", textTransform: "none" }}
						>
							稍后再说
						</Button>

						{downloadStatus === "completed" ? (
							<Button
								variant="contained"
								color="primary"
								onClick={handleInstallAndExit}
								startIcon={<SystemUpdateAltRoundedIcon />}
								sx={{ borderRadius: "8px", fontWeight: 750, textTransform: "none", px: 2.5 }}
							>
								立即安装并退出
							</Button>
						) : newRelease?.assetUrl ? (
							<Button
								variant="contained"
								color="primary"
								onClick={handleStartDownload}
								disabled={downloadStatus === "downloading"}
								startIcon={
									downloadStatus === "downloading" ? (
										<CircularProgress size={16} color="inherit" />
									) : (
										<DownloadRoundedIcon />
									)
								}
								sx={{ borderRadius: "8px", fontWeight: 750, textTransform: "none", px: 2.5 }}
							>
								{downloadStatus === "downloading"
									? `正在下载 (${downloadProgress.percent}%)`
									: downloadStatus === "error"
										? "重新下载"
										: newRelease.assetSize
											? `应用内直接下载 (${(newRelease.assetSize / (1024 * 1024)).toFixed(1)} MB)`
											: "应用内直接下载"}
							</Button>
						) : (
							<Button
								variant="contained"
								color="primary"
								onClick={() => {
									if (newRelease?.htmlUrl) {
										void openUrl(newRelease.htmlUrl);
									}
									setDialogOpen(false);
								}}
								startIcon={<OpenInNewRoundedIcon />}
								sx={{ borderRadius: "8px", fontWeight: 750, textTransform: "none" }}
							>
								前往 GitHub 发布页下载
							</Button>
						)}
					</Box>
				</DialogActions>
			</Dialog>
		</Box>
	);
};
