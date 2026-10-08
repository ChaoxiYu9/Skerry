import { convertFileSrc } from "@tauri-apps/api/core";
import AddPhotoAlternateRoundedIcon from "@mui/icons-material/AddPhotoAlternateRounded";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import ArrowDropDownRoundedIcon from "@mui/icons-material/ArrowDropDownRounded";
import ClearIcon from "@mui/icons-material/Clear";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import PanoramaRoundedIcon from "@mui/icons-material/PanoramaRounded";
import WallpaperRoundedIcon from "@mui/icons-material/WallpaperRounded";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import LinearProgress from "@mui/material/LinearProgress";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { snackbar } from "@/providers/snackBar";
import { fetchKunScreenshots } from "@/metadata/api/kun";
import { fetchVndbById } from "@/metadata/api/vndb";
import { getMetadataRequestContext } from "@/services/requestContext";
import {
	getCgIdentifierUrl,
	saveGalleryImageAs,
	saveRemoteCgs,
	uploadSelectedCgs,
} from "@/services/game/customCover";
import type { GameData, VndbData } from "@/types";
import { getUserErrorMessage } from "@/utils/errors";

type OnlineScreenshot = {
	url: string;
	source: "vndb" | "kun";
	previewUrl?: string;
};

export interface DetailGalleryDialogProps {
	open: boolean;
	onClose: () => void;
	game: GameData;
	activeCustomRoot?: string | null;
	onPersistCustomData: (
		patch: Partial<NonNullable<GameData["custom_data"]>>,
	) => Promise<void>;
}

export const DetailGalleryDialog = memo(function DetailGalleryDialog({
	open,
	onClose,
	game,
	activeCustomRoot,
	onPersistCustomData,
}: DetailGalleryDialogProps) {
	const { t } = useTranslation();
	const id = game.id;

	const [onlineScreenshots, setOnlineScreenshots] = useState<OnlineScreenshot[]>([]);
	const [selectedScreenshotUrls, setSelectedScreenshotUrls] = useState<string[]>([]);
	const [pendingLocalCgPaths, setPendingLocalCgPaths] = useState<string[]>([]);
	const [selectedLocalCgPaths, setSelectedLocalCgPaths] = useState<string[]>([]);
	const [isLoadingScreenshots, setIsLoadingScreenshots] = useState(false);
	const [isSavingScreenshots, setIsSavingScreenshots] = useState(false);
	const [isAddingCg, setIsAddingCg] = useState(false);
	const [isImportingBanner, setIsImportingBanner] = useState(false);
	const [importActionsMenuAnchor, setImportActionsMenuAnchor] = useState<HTMLElement | null>(null);

	const customCgs: string[] = (game.custom_data as any)?.cgs ?? [];
	const importedScreenshotUrls: string[] =
		game.custom_data?.imported_screenshot_urls ?? [];
	const importedScreenshotMap: Record<string, string> =
		game.custom_data?.imported_screenshot_map ?? {};
	const hiddenSourceScreenshotUrls: string[] =
		game.custom_data?.hidden_source_screenshots ?? [];

	const customCgUrls = useMemo(
		() => customCgs.map((entry) => getCgIdentifierUrl(id, entry, activeCustomRoot)),
		[customCgs, id, activeCustomRoot],
	);

	const sourceScreenshots: string[] = useMemo(
		() =>
			(game.screenshots ?? []).filter(
				(url) =>
					!importedScreenshotUrls.includes(url) &&
					!hiddenSourceScreenshotUrls.includes(url),
			),
		[game.screenshots, importedScreenshotUrls, hiddenSourceScreenshotUrls],
	);

	const managedGalleryEntries = useMemo(
		() => [
			...customCgUrls.map((src, index) => ({
				kind: "custom" as const,
				src,
				index,
			})),
			...sourceScreenshots.map((src, index) => ({
				kind: "source" as const,
				src,
				index,
			})),
		],
		[customCgUrls, sourceScreenshots],
	);

	const onlineScreenshotGroups = useMemo(
		() =>
			[
				{
					source: "vndb" as const,
					label: "VNDB",
					screenshots: onlineScreenshots.filter(
						(screenshot) => screenshot.source === "vndb",
					),
				},
				{
					source: "kun" as const,
					label: "KunGal",
					screenshots: onlineScreenshots.filter(
						(screenshot) => screenshot.source === "kun",
					),
				},
			].filter((group) => group.screenshots.length > 0),
		[onlineScreenshots],
	);

	const isCgActionBusy =
		isAddingCg ||
		isImportingBanner ||
		isLoadingScreenshots ||
		isSavingScreenshots;

	const cgLoadingStage = isAddingCg
		? "正在添加本地 CG..."
		: isImportingBanner
			? "正在导入背景图..."
			: isLoadingScreenshots
				? "正在获取在线截图..."
				: isSavingScreenshots
					? "正在保存选中的截图..."
					: "";

	const handleSelectLocalCgs = async () => {
		try {
			const selected = await openFileDialog({
				title: "选择本地 CG 图片",
				multiple: true,
				directory: false,
				filters: [
					{
						name: "图片文件",
						extensions: ["png", "jpg", "jpeg", "webp", "bmp", "avif"],
					},
				],
			});
			if (!selected) return;
			const paths = Array.isArray(selected) ? selected : [selected];
			setPendingLocalCgPaths(paths);
			setSelectedLocalCgPaths(paths);
		} catch (error) {
			snackbar.error("选择本地 CG 失败: " + getUserErrorMessage(error, t));
		}
	};

	const handleSelectBackdropImage = async () => {
		try {
			const selected = await openFileDialog({
				title: "选择本地底图图片",
				multiple: false,
				directory: false,
				filters: [
					{
						name: "图片文件",
						extensions: ["png", "jpg", "jpeg", "webp", "bmp", "avif"],
					},
				],
			});
			if (!selected || Array.isArray(selected)) return;
			setIsImportingBanner(true);
			const identifier = await saveGalleryImageAs(
				id,
				{ type: "local", path: selected },
				"detail",
				game.custom_data?.detail_backdrop,
			);
			await onPersistCustomData({
				detail_backdrop: identifier,
				detail_backdrop_focus: { x: 50, y: 50 },
			});
			snackbar.success("已导入底图");
		} catch (error) {
			snackbar.error("导入底图失败: " + getUserErrorMessage(error, t));
		} finally {
			setIsImportingBanner(false);
		}
	};

	const handleSelectBannerImage = async () => {
		try {
			const selected = await openFileDialog({
				title: "选择本地横幅图片",
				multiple: false,
				directory: false,
				filters: [
					{
						name: "图片文件",
						extensions: ["png", "jpg", "jpeg", "webp", "bmp", "avif"],
					},
				],
			});
			if (!selected || Array.isArray(selected)) return;
			setIsImportingBanner(true);
			const identifier = await saveGalleryImageAs(
				id,
				{ type: "local", path: selected },
				"banner",
				game.custom_data?.banner,
			);
			await onPersistCustomData({
				banner: identifier,
				banner_focus: { x: 50, y: 50 },
			});
			snackbar.success("已导入横幅图");
		} catch (error) {
			snackbar.error("导入横幅图失败: " + getUserErrorMessage(error, t));
		} finally {
			setIsImportingBanner(false);
		}
	};

	const handleDeleteCg = async (index: number) => {
		try {
			const deletedCg = customCgs[index];
			const deletedCgUrls = Object.entries(importedScreenshotMap)
				.filter(([, identifier]) => identifier === deletedCg)
				.map(([url]) => url);
			const nextImportedScreenshotMap = Object.fromEntries(
				Object.entries(importedScreenshotMap).filter(
					([, identifier]) => identifier !== deletedCg,
				),
			);
			const updated = customCgs.filter((_, i) => i !== index);
			await onPersistCustomData({
				cgs: updated,
				imported_screenshot_urls: importedScreenshotUrls.filter(
					(url) => !deletedCgUrls.includes(url),
				),
				imported_screenshot_map: nextImportedScreenshotMap,
			});
			snackbar.success("已删除该 CG");
		} catch (error) {
			snackbar.error("删除 CG 失败: " + getUserErrorMessage(error, t));
		}
	};

	const handleClearAllCgs = async () => {
		try {
			await onPersistCustomData({
				cgs: [],
				imported_screenshot_urls: [],
				imported_screenshot_map: {},
				hidden_source_screenshots: [
					...new Set([
						...hiddenSourceScreenshotUrls,
						...(game.screenshots ?? []),
					]),
				],
			});
			snackbar.success("已清空所有 CG");
		} catch (error) {
			snackbar.error("清空 CG 失败: " + getUserErrorMessage(error, t));
		}
	};

	const handleFetchOnlineScreenshots = useCallback(async () => {
		setIsLoadingScreenshots(true);
		try {
			const context = getMetadataRequestContext();
			const tasks: Array<Promise<OnlineScreenshot[]>> = [];
			const vndbId = game.sourceIds.vndb;
			const kunId = game.sourceIds.kun;

			if (vndbId) {
				tasks.push(
					fetchVndbById(vndbId, context).then((draft: any) => {
						const record = draft.sources?.find((source: any) => source.source === "vndb");
						const data = record?.data as VndbData | undefined;
						const screenshots = data?.screenshots ?? [];
						const thumbnails = data?.screenshot_thumbnails ?? [];
						return screenshots.map((url: string, index: number) => ({
							url,
							source: "vndb" as const,
							previewUrl: thumbnails[index] || url,
						}));
					}),
				);
			}
			if (kunId) {
				tasks.push(
					fetchKunScreenshots(kunId, context).then((screenshots: string[]) =>
						screenshots.map((url: string) => ({ url, source: "kun" as const, previewUrl: url })),
					),
				);
			}

			const results = await Promise.allSettled(tasks);
			const merged = new Map<string, OnlineScreenshot>();
			for (const result of results) {
				if (result.status === "fulfilled") {
					result.value.forEach((screenshot) => {
						if (screenshot.url && !merged.has(screenshot.url)) {
							merged.set(screenshot.url, screenshot);
						}
					});
				}
			}
			const available = [...merged.values()];
			setOnlineScreenshots(available);
			setSelectedScreenshotUrls([]);
			if (available.length === 0) {
				const failed = results.some((result) => result.status === "rejected");
				if (failed) {
					throw results.find((result) => result.status === "rejected");
				}
				snackbar.info("未获取到可用的在线截图");
			}
		} catch (error) {
			snackbar.error("获取在线截图失败: " + getUserErrorMessage(error, t));
		} finally {
			setIsLoadingScreenshots(false);
		}
	}, [game.sourceIds, t]);

	const toggleScreenshotUrl = (url: string) => {
		setSelectedScreenshotUrls((selected) =>
			selected.includes(url)
				? selected.filter((item) => item !== url)
				: [...selected, url],
		);
	};

	const handleAddSelectedScreenshots = async () => {
		const selectedUrls = selectedScreenshotUrls.filter(
			(url) => !importedScreenshotUrls.includes(url),
		);
		if (selectedUrls.length === 0) {
			if (selectedScreenshotUrls.length > 0) {
				snackbar.info("所选图片均已导入，无需重复导入");
			}
			return;
		}
		setIsSavingScreenshots(true);
		try {
			const identifiers = await saveRemoteCgs(id, selectedUrls);
			await onPersistCustomData({
				cgs: [...customCgs, ...identifiers],
				imported_screenshot_urls: [
					...new Set([...importedScreenshotUrls, ...selectedUrls]),
				],
				imported_screenshot_map: {
					...importedScreenshotMap,
					...Object.fromEntries(
						selectedUrls.map((url, index) => [url, identifiers[index]]),
					),
				},
			});
			setSelectedScreenshotUrls([]);
			snackbar.success(`已添加 ${identifiers.length} 张在线截图`);
		} catch (error) {
			snackbar.error("保存在线截图失败: " + getUserErrorMessage(error, t));
		} finally {
			setIsSavingScreenshots(false);
		}
	};

	const handleHideSourceScreenshot = async (url: string) => {
		try {
			await onPersistCustomData({
				hidden_source_screenshots: [
					...hiddenSourceScreenshotUrls,
					url,
				],
			});
			snackbar.success("已从画廊中隐藏该截图");
		} catch (error) {
			snackbar.error("隐藏截图失败: " + getUserErrorMessage(error, t));
		}
	};

	const handleAddSelectedLocalCgs = async () => {
		const selectedPaths = pendingLocalCgPaths.filter((path) =>
			selectedLocalCgPaths.includes(path),
		);
		if (selectedPaths.length === 0) return;
		setIsAddingCg(true);
		try {
			const identifiers = await uploadSelectedCgs(id, selectedPaths);
			await onPersistCustomData({
				cgs: [...customCgs, ...identifiers],
			});
			setPendingLocalCgPaths([]);
			setSelectedLocalCgPaths([]);
			snackbar.success(`已添加 ${selectedPaths.length} 张本地 CG`);
		} catch (error) {
			snackbar.error("添加本地 CG 失败: " + getUserErrorMessage(error, t));
		} finally {
			setIsAddingCg(false);
		}
	};

	const handleImportSelectedScreenshotsAsBackdrop = async () => {
		if (selectedScreenshotUrls.length !== 1) {
			snackbar.warning("请仅选择一张图片作为底图");
			return;
		}
		setIsImportingBanner(true);
		try {
			const identifier = await saveGalleryImageAs(
				id,
				{ type: "remote", url: selectedScreenshotUrls[0] },
				"detail",
				game.custom_data?.detail_backdrop,
			);
			await onPersistCustomData({
				detail_backdrop: identifier,
				detail_backdrop_focus: { x: 50, y: 50 },
			});
			setSelectedScreenshotUrls([]);
			snackbar.success("已导入底图");
		} catch (error) {
			snackbar.error("导入底图失败: " + getUserErrorMessage(error, t));
		} finally {
			setIsImportingBanner(false);
		}
	};

	const handleImportSelectedScreenshotsAsBanner = async () => {
		if (selectedScreenshotUrls.length !== 1) {
			snackbar.warning("请仅选择一张图片作为横幅图");
			return;
		}
		setIsImportingBanner(true);
		try {
			const identifier = await saveGalleryImageAs(
				id,
				{ type: "remote", url: selectedScreenshotUrls[0] },
				"banner",
				game.custom_data?.banner,
			);
			await onPersistCustomData({
				banner: identifier,
				banner_focus: { x: 50, y: 50 },
			});
			setSelectedScreenshotUrls([]);
			snackbar.success("已导入横幅图");
		} catch (error) {
			snackbar.error("导入横幅图失败: " + getUserErrorMessage(error, t));
		} finally {
			setIsImportingBanner(false);
		}
	};
	return (
		<Dialog
			open={open}
			onClose={onClose}
			maxWidth="md"
			fullWidth
			slotProps={{
				paper: {
					sx: {
						background: "#0d131f",
						border: "1px solid rgba(255, 255, 255, 0.12)",
						borderRadius: "12px",
						backgroundImage: "none",
						color: "#ffffff",
					},
				},
			}}
		>
			<DialogTitle
				sx={{
					m: 0,
					p: 2.5,
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
				}}
			>
				<Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
					<Typography
						variant="h6"
						sx={{
							fontWeight: 800,
							fontSize: "17px",
							color: "#00e5ff",
							letterSpacing: "0.02em",
						}}
					>
						CG管理画廊
					</Typography>
					<Typography
						variant="caption"
						sx={{ color: "text.secondary", fontWeight: 600 }}
					>
						共 {customCgs.length + sourceScreenshots.length} 张
					</Typography>
				</Box>
				<IconButton
					size="small"
					onClick={onClose}
					sx={{
						color: "text.secondary",
						"&:hover": {
							color: "text.primary",
							bgcolor: "action.hover",
						},
					}}
				>
					<ClearIcon fontSize="small" />
				</IconButton>
			</DialogTitle>

			<DialogContent
				dividers
				sx={{
					borderColor: "rgba(255, 255, 255, 0.08)",
					p: 3,
					scrollbarWidth: "none",
					"&::-webkit-scrollbar": { display: "none", width: 0, height: 0 },
				}}
			>
				{isCgActionBusy && (
					<Box sx={{ mb: 3 }}>
						<Box
							className="skerry-import-loading-strip"
							role="status"
							aria-live="polite"
						>
							<CircularProgress size={18} thickness={4} />
							<Box className="skerry-import-loading-copy">
								<Typography variant="body2" fontWeight={800}>
									{cgLoadingStage}
								</Typography>
								<Typography variant="caption" color="text.secondary">
									操作完成后会自动更新画廊。
								</Typography>
							</Box>
							<LinearProgress className="skerry-import-loading-progress" />
						</Box>
					</Box>
				)}

				<Box
					sx={{
						p: 2.5,
						mb: 3,
						borderRadius: "8px",
						background: "rgba(0, 229, 255, 0.04)",
						border: "1px dashed rgba(0, 229, 255, 0.3)",
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center",
					}}
				>
					<Box>
						<Typography
							sx={{ fontWeight: 700, fontSize: "14px", color: "#ffffff" }}
						>
							管理作品 CG
						</Typography>
						<Typography
							variant="caption"
							sx={{
								color: "rgba(255, 255, 255, 0.6)",
								mt: 0.5,
								display: "block",
							}}
						>
							支持选择单张或批量图片文件（PNG、JPG、WEBP）导入到本地画廊。
						</Typography>
					</Box>
					<Stack direction="row" spacing={1.5}>
						<Button
							variant="contained"
							size="small"
							className="detail-gallery-import-btn"
							endIcon={<ArrowDropDownRoundedIcon />}
							disabled={isCgActionBusy}
							onClick={(event) =>
								setImportActionsMenuAnchor(event.currentTarget)
							}
							sx={{
								borderRadius: "9999px",
								boxShadow: "none !important",
								"&:hover": {
									boxShadow: "0 2px 8px rgba(0, 0, 0, 0.12) !important",
								},
							}}
						>
							导入
						</Button>
						<Menu
							anchorEl={importActionsMenuAnchor}
							open={Boolean(importActionsMenuAnchor)}
							onClose={() => setImportActionsMenuAnchor(null)}
							anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
							transformOrigin={{ vertical: "top", horizontal: "left" }}
							PaperProps={{
								sx: {
									width: "max-content",
									minWidth: 120,
									maxWidth: "max-content",
								},
							}}
							MenuListProps={{ dense: true, sx: { py: 0.5 } }}
						>
							<MenuItem
								onClick={() => {
									setImportActionsMenuAnchor(null);
									void handleSelectLocalCgs();
								}}
							>
								<ListItemIcon>
									<AddPhotoAlternateRoundedIcon fontSize="small" />
								</ListItemIcon>
								<ListItemText primary="画廊" />
							</MenuItem>
							<MenuItem
								onClick={() => {
									setImportActionsMenuAnchor(null);
									void handleSelectBackdropImage();
								}}
							>
								<ListItemIcon>
									<WallpaperRoundedIcon fontSize="small" />
								</ListItemIcon>
								<ListItemText primary="底图" />
							</MenuItem>
							<MenuItem
								onClick={() => {
									setImportActionsMenuAnchor(null);
									void handleSelectBannerImage();
								}}
							>
								<ListItemIcon>
									<PanoramaRoundedIcon fontSize="small" />
								</ListItemIcon>
								<ListItemText primary="横幅图" />
							</MenuItem>
						</Menu>
						<Button
							variant="outlined"
							size="small"
							startIcon={<AddRoundedIcon fontSize="small" />}
							disabled={isLoadingScreenshots || isSavingScreenshots}
							onClick={() => void handleFetchOnlineScreenshots()}
							sx={{
								borderColor: "rgba(0, 229, 255, 0.35)",
								color: "#00e5ff",
								"&:hover": {
									borderColor: "#00e5ff",
									background: "rgba(0, 229, 255, 0.1)",
								},
							}}
						>
							获取截图
						</Button>
					</Stack>
				</Box>
				{pendingLocalCgPaths.length > 0 && (
					<Box
						sx={{
							p: 2.5,
							mb: 3,
							borderRadius: "8px",
							background: "rgba(255, 255, 255, 0.03)",
							border: "1px solid rgba(255, 255, 255, 0.12)",
						}}
					>
						<Box
							sx={{
								display: "flex",
								justifyContent: "space-between",
								alignItems: "center",
								mb: 2,
							}}
						>
							<Typography
								sx={{ fontWeight: 700, fontSize: "14px", color: "#ffffff" }}
							>
								画廊
							</Typography>
							<Stack direction="row" spacing={1} alignItems="center">
								<FormControlLabel
									checked={
										pendingLocalCgPaths.length > 0 &&
										pendingLocalCgPaths.every((path) =>
											selectedLocalCgPaths.includes(path),
										)
									}
									disabled={isAddingCg}
									onChange={(_, checked) => {
										setSelectedLocalCgPaths(checked ? pendingLocalCgPaths : []);
									}}
									control={
										<Checkbox
											size="small"
											color="primary"
											indeterminate={
												!pendingLocalCgPaths.every((path) =>
													selectedLocalCgPaths.includes(path),
												) && selectedLocalCgPaths.length > 0
											}
											sx={{ p: 0.25, "& .MuiSvgIcon-root": { fontSize: 15 } }}
										/>
									}
									label="全选"
									slotProps={{
										typography: {
											sx: {
												fontSize: "11.5px",
												fontWeight: 800,
												lineHeight: "15px",
												transform: "translateY(0.5px)",
												color:
													selectedLocalCgPaths.length > 0
														? "text.primary"
														: "text.secondary",
											},
										},
									}}
									sx={{
										m: 0,
										"& .MuiFormControlLabel-label": { userSelect: "none" },
									}}
								/>
								<Button
									variant="outlined"
									size="small"
									disabled={isAddingCg}
									onClick={() => {
										setPendingLocalCgPaths([]);
										setSelectedLocalCgPaths([]);
									}}
								>
									取消
								</Button>
								<Button
									variant="contained"
									size="small"
									disabled={isAddingCg || selectedLocalCgPaths.length === 0}
									onClick={() => void handleAddSelectedLocalCgs()}
									startIcon={<AddPhotoAlternateRoundedIcon fontSize="small" />}
									sx={{
										background: "#00e5ff",
										color: "#000000",
										fontWeight: 800,
										"&:hover": { background: "#00b8cc" },
									}}
								>
									导入画廊 ({selectedLocalCgPaths.length})
								</Button>
							</Stack>
						</Box>
						<Box
							sx={{
								display: "grid",
								gridTemplateColumns: "repeat(4, 1fr)",
								gap: 2,
							}}
						>
							{pendingLocalCgPaths.map((path) => {
								const selected = selectedLocalCgPaths.includes(path);
								return (
									<Box
										key={path}
										onClick={() => {
											setSelectedLocalCgPaths((paths) =>
												paths.includes(path)
													? paths.filter((item) => item !== path)
													: [...paths, path],
											);
										}}
										sx={{
											position: "relative",
											width: "100%",
											aspectRatio: "16/9",
											borderRadius: "6px",
											overflow: "hidden",
											cursor: "pointer",
											border: selected
												? "2px solid #00e5ff"
												: "1px solid rgba(255, 255, 255, 0.12)",
											boxShadow: selected
												? "0 0 0 2px rgba(0, 229, 255, 0.24)"
												: "none",
										}}
									>
										<Box
											component="img"
											src={convertFileSrc(path)}
											sx={{
												width: "100%",
												height: "100%",
												objectFit: "cover",
												display: "block",
											}}
										/>
										{selected && (
											<Box
												sx={{
													position: "absolute",
													inset: 0,
													background: "rgba(0, 229, 255, 0.16)",
													border: "2px solid #00e5ff",
													pointerEvents: "none",
												}}
											/>
										)}
									</Box>
								);
							})}
						</Box>
					</Box>
				)}

				{onlineScreenshotGroups.length > 0 && (
					<Box
						sx={{
							p: 2.5,
							mb: 3,
							borderRadius: "8px",
							background: "rgba(255, 255, 255, 0.03)",
							border: "1px solid rgba(255, 255, 255, 0.12)",
						}}
					>
						<Box
							sx={{
								display: "flex",
								justifyContent: "space-between",
								alignItems: "center",
								mb: 2,
							}}
						>
							<Typography
								sx={{ fontWeight: 700, fontSize: "14px", color: "#ffffff" }}
							>
								在线截图（已过滤 Explicit）
							</Typography>
							<Stack direction="row" spacing={1} alignItems="center">
								<Button
									variant="contained"
									size="small"
									disabled={
										!selectedScreenshotUrls.some(
											(url) => !importedScreenshotUrls.includes(url),
										) || isSavingScreenshots
									}
									onClick={() => void handleAddSelectedScreenshots()}
									startIcon={<AddPhotoAlternateRoundedIcon fontSize="small" />}
									sx={{
										background: "#00e5ff",
										color: "#000000",
										fontWeight: 800,
										"&:hover": { background: "#00b8cc" },
									}}
								>
									导入画廊
								</Button>
								<Button
									variant="contained"
									size="small"
									disabled={
										selectedScreenshotUrls.length !== 1 || isSavingScreenshots
									}
									onClick={() =>
										void handleImportSelectedScreenshotsAsBackdrop()
									}
									startIcon={<WallpaperRoundedIcon fontSize="small" />}
									sx={{
										background: "#00b8cc",
										color: "#000000",
										fontWeight: 800,
										"&:hover": { background: "#009aa8" },
									}}
								>
									设为底图
								</Button>
								<Button
									variant="contained"
									size="small"
									disabled={
										selectedScreenshotUrls.length !== 1 || isSavingScreenshots
									}
									onClick={() =>
										void handleImportSelectedScreenshotsAsBanner()
									}
									startIcon={<PanoramaRoundedIcon fontSize="small" />}
									sx={{
										background: "#00b8cc",
										color: "#000000",
										fontWeight: 800,
										"&:hover": { background: "#009aa8" },
									}}
								>
									设为横幅图
								</Button>
							</Stack>
						</Box>
						{onlineScreenshotGroups.map((group, groupIndex) => (
							<Box key={group.source} sx={groupIndex > 0 ? { mt: 3 } : undefined}>
								{(() => {
									const groupUrls = group.screenshots.map(
										(screenshot) => screenshot.url,
									);
									const groupAllSelected =
										groupUrls.length > 0 &&
										groupUrls.every((url) =>
											selectedScreenshotUrls.includes(url),
										);
									return (
										<Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
											<Typography
												sx={{
													fontSize: "12px",
													fontWeight: 800,
													color: "var(--skerry-accent)",
													letterSpacing: "0.06em",
												}}
											>
												{group.label}
											</Typography>
											<FormControlLabel
												checked={groupAllSelected}
												disabled={groupUrls.length === 0}
												onChange={(_, checked) => {
													if (checked) {
														setSelectedScreenshotUrls((urls) =>
															Array.from(new Set([...urls, ...groupUrls])),
														);
													} else {
														setSelectedScreenshotUrls((urls) =>
															urls.filter((url) => !groupUrls.includes(url)),
														);
													}
												}}
												control={
													<Checkbox
														size="small"
														color="primary"
														indeterminate={
															!groupAllSelected &&
															groupUrls.some((url) =>
																selectedScreenshotUrls.includes(url),
															)
														}
														sx={{
															p: 0.25,
															"& .MuiSvgIcon-root": { fontSize: 15 },
														}}
													/>
												}
												label="全选"
												slotProps={{
													typography: {
														sx: {
															fontSize: "11.5px",
															fontWeight: 800,
															lineHeight: "15px",
															display: "block",
															transform: "translateY(0.5px)",
															color: groupAllSelected
																? "text.primary"
																: "text.secondary",
														},
													},
												}}
												sx={{
													m: 0,
													ml: 0.25,
													"& .MuiFormControlLabel-label": {
														userSelect: "none",
													},
												}}
											/>
										</Box>
									);
								})()}
								<Box
									sx={{
										height: "1px",
										mt: 0.75,
										mb: 2,
										background:
											"linear-gradient(90deg, rgba(0, 229, 255, 0.55), rgba(0, 229, 255, 0.04))",
									}}
								/>
								<Box
									sx={{
										display: "grid",
										gridTemplateColumns: "repeat(4, 1fr)",
										gap: 2,
									}}
								>
									{group.screenshots.map((screenshot) => {
										const selected = selectedScreenshotUrls.includes(
											screenshot.url,
										);
										const imported = Boolean(
											importedScreenshotMap[screenshot.url],
										);
										return (
											<Box
												key={screenshot.url}
												onClick={() => toggleScreenshotUrl(screenshot.url)}
												sx={{
													position: "relative",
													width: "100%",
													aspectRatio: "16/9",
													borderRadius: "6px",
													overflow: "hidden",
													cursor: imported ? "default" : "pointer",
													opacity: imported ? 0.78 : 1,
													border: selected
														? "2px solid #00e5ff"
														: "1px solid rgba(255, 255, 255, 0.12)",
													boxShadow: selected
														? "0 0 0 2px rgba(0, 229, 255, 0.24)"
														: "none",
												}}
											>
												<Box
													component="img"
													src={screenshot.previewUrl}
													loading="lazy"
													decoding="async"
													sx={{
														width: "100%",
														height: "100%",
														objectFit: "cover",
														display: "block",
													}}
												/>
												{selected && (
													<Box
														sx={{
															position: "absolute",
															inset: 0,
															background: "rgba(0, 229, 255, 0.16)",
															border: "2px solid #00e5ff",
															pointerEvents: "none",
														}}
													/>
												)}
												{imported && (
													<Typography
														variant="caption"
														sx={{
															position: "absolute",
															left: 6,
															bottom: 4,
															px: 0.75,
															py: 0.25,
															borderRadius: "3px",
															background: "#00e5ff",
															color: "#000000",
															fontSize: "10px",
															fontWeight: 800,
															pointerEvents: "none",
														}}
													>
														已导入
													</Typography>
												)}
											</Box>
										);
									})}
								</Box>
							</Box>
						))}
					</Box>
				)}

				<Typography
					sx={{
						fontSize: "12px",
						fontWeight: 800,
						color: "rgba(255, 255, 255, 0.6)",
						textTransform: "uppercase",
						letterSpacing: "0.08em",
						mb: 2,
					}}
				>
					画廊图片 ({managedGalleryEntries.length})
				</Typography>

				{managedGalleryEntries.length === 0 ? (
					<Box
						sx={{
							py: 6,
							textAlign: "center",
							color: "rgba(255, 255, 255, 0.4)",
						}}
					>
						<Typography variant="body2">
							暂无画廊图片，请从上方导入本地 CG 或获取在线截图加入画廊。
						</Typography>
					</Box>
				) : (
					<Box
						sx={{
							display: "grid",
							gridTemplateColumns: "repeat(3, 1fr)",
							gap: 2,
						}}
					>
						{managedGalleryEntries.map((entry, galleryIndex) => (
							<Box
								key={
									entry.kind === "custom"
										? `custom-${entry.index}`
										: entry.src
								}
								sx={{
									position: "relative",
									width: "100%",
									aspectRatio: "16/9",
									borderRadius: "6px",
									overflow: "hidden",
									border: "1px solid rgba(255, 255, 255, 0.12)",
									background: "rgba(0, 0, 0, 0.4)",
								}}
							>
								<Box
									component="img"
									src={entry.src}
									sx={{
										width: "100%",
										height: "100%",
										objectFit: "cover",
										display: "block",
									}}
								/>
								<IconButton
									size="small"
									title={
										entry.kind === "custom" ? "删除本地 CG" : "从画廊隐藏"
									}
									onClick={() =>
										void (entry.kind === "custom"
											? handleDeleteCg(entry.index)
											: handleHideSourceScreenshot(entry.src))
									}
									sx={{
										position: "absolute",
										top: 6,
										right: 6,
										background: "rgba(0, 0, 0, 0.75)",
										color: "#ef4444",
										backdropFilter: "blur(6px)",
										padding: "4px",
										"&:hover": {
											background: "#ef4444",
											color: "#ffffff",
										},
									}}
								>
									<DeleteOutlineRoundedIcon sx={{ fontSize: 16 }} />
								</IconButton>
								<Typography
									variant="caption"
									className="cg-index-badge"
									sx={{
										position: "absolute",
										bottom: 4,
										left: 6,
										px: 0.75,
										py: 0.25,
										borderRadius: "3px",
										fontSize: "10px",
										fontWeight: 700,
									}}
								>
									#{galleryIndex + 1}
								</Typography>
							</Box>
						))}
					</Box>
				)}
			</DialogContent>

			<DialogActions
				sx={{
					p: 2,
					px: 3,
					justifyContent: "space-between",
					borderColor: "rgba(255, 255, 255, 0.08)",
				}}
			>
				{managedGalleryEntries.length > 0 ? (
					<Button
						color="error"
						variant="outlined"
						size="small"
						onClick={handleClearAllCgs}
						sx={{ fontWeight: 600 }}
					>
						清空所有 CG
					</Button>
				) : (
					<Box />
				)}
				<Button variant="outlined" size="small" onClick={onClose}>
					关闭
				</Button>
			</DialogActions>
		</Dialog>
	);
});
