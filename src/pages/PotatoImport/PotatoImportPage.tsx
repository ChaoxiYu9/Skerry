import CheckCircleOutlineRoundedIcon from "@mui/icons-material/CheckCircleOutlineRounded";
import CloudUploadRoundedIcon from "@mui/icons-material/CloudUploadRounded";
import FolderOpenRoundedIcon from "@mui/icons-material/FolderOpenRounded";
import WarningAmberRoundedIcon from "@mui/icons-material/WarningAmberRounded";
import {
	Alert,
	Box,
	Button,
	CircularProgress,
	Divider,
	List,
	ListItem,
	ListItemText,
	LinearProgress,
	Paper,
	Stack,
	Typography,
} from "@mui/material";
import { useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { basename, join } from "pathe";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	gameKeys,
	useAllGames,
	useBatchAddGames,
} from "@/hooks/queries/useGames";
import { snackbar } from "@/providers/snackBar";
import { fileService, gameService, statsService } from "@/services/invoke";
import type { UserDataPreviewResult } from "@/services/invoke";
import {
	importUserDataByPath,
	inspectUserDataPreview,
	selectUserDataArchive,
} from "@/services/fs/dataMaintenance";
import { restartApp } from "@/services/appExit";
import type { FullGameData } from "@/types";
import { getcustomCoverFolder } from "@/utils/game";
import {
	buildSessionEntries,
	findDuplicate,
	type PotatoImportPreview,
	readPotatoExport,
	readPotatoFromFolder,
	readPotatoFromWebFiles,
	toInsertGame,
} from "./potatoImport";

interface ImportableRecord {
	record: PotatoImportPreview["records"][number];
	duplicate: FullGameData | null;
}

export function PotatoImport() {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const fileInputRef = useRef<HTMLInputElement>(null);
	const folderInputRef = useRef<HTMLInputElement>(null);
	const [preview, setPreview] = useState<PotatoImportPreview | null>(null);
	const [isReading, setIsReading] = useState(false);
	const [isImporting, setIsImporting] = useState(false);
	const [userDataPreview, setUserDataPreview] =
		useState<UserDataPreviewResult | null>(null);
	const [isReadingUserData, setIsReadingUserData] = useState(false);
	const [isImportingUserData, setIsImportingUserData] = useState(false);
	const { data: games = [] } = useAllGames();
	const batchAddGames = useBatchAddGames();
	const importableRecords = useMemo<ImportableRecord[]>(
		() =>
			preview?.records.map((record) => ({
				record,
				duplicate: findDuplicate(record, games),
			})) ?? [],
		[games, preview],
	);
	const newRecords = importableRecords.filter(
		(item) => item.duplicate === null,
	);
	const duplicateCount = importableRecords.length - newRecords.length;
	const isUserDataBusy = isReadingUserData || isImportingUserData;

	const handleSelectUserData = async () => {
		if (isUserDataBusy) return;
		const archivePath = await selectUserDataArchive();
		if (!archivePath) return;
		setIsReadingUserData(true);
		setUserDataPreview(null);
		try {
			const result = await inspectUserDataPreview(archivePath);
			setUserDataPreview(result);
		} catch (error) {
			snackbar.error(String(error));
		} finally {
			setIsReadingUserData(false);
		}
	};

	const handleImportUserData = async () => {
		if (!userDataPreview || isImportingUserData) return;
		setIsImportingUserData(true);
		try {
			const result = await importUserDataByPath(userDataPreview.archivePath);
			if (result.success) {
				snackbar.success(result.message);
				setTimeout(() => void restartApp(), 3000);
			} else {
				snackbar.error(result.message);
			}
		} catch (error) {
			snackbar.error(String(error));
		} finally {
			setIsImportingUserData(false);
		}
	};

	const handleSelectFile = async () => {
		if (isReading || isImporting || isUserDataBusy) return;
		try {
			const selected = await open({
				title: "选择 PotatoVN 导出文件",
				multiple: false,
				directory: false,
				filters: [
					{
						name: "PotatoVN 导出文件 (*.pvnExport, *.zip)",
						extensions: ["pvnExport", "zip"],
					},
					{ name: "所有文件 (*.*)", extensions: ["*"] },
				],
			});
			if (!selected || typeof selected !== "string") return;
			setIsReading(true);
			setPreview(null);
			const isDir = await fileService.isDirectory(selected);
			if (isDir) {
				const res = await readPotatoFromFolder(
					selected,
					(p) => fileService.readFileBytes(p),
					(p) => fileService.listDirectoryFiles(p),
				);
				setPreview(res);
			} else {
				const bytes = await fileService.readFileBytes(selected);
				setPreview(readPotatoExport(basename(selected), bytes));
			}
		} catch (error) {
			console.warn("使用系统对话框选择文件失败，回退文件选择器:", error);
			fileInputRef.current?.click();
		} finally {
			setIsReading(false);
		}
	};

	const handleSelectFolder = async () => {
		if (isReading || isImporting || isUserDataBusy) return;
		try {
			const selected = await open({
				title: "选择 PotatoVN 导出文件夹",
				multiple: false,
				directory: true,
			});
			if (!selected || typeof selected !== "string") return;
			setIsReading(true);
			setPreview(null);
			const res = await readPotatoFromFolder(
				selected,
				(p) => fileService.readFileBytes(p),
				(p) => fileService.listDirectoryFiles(p),
			);
			setPreview(res);
		} catch (error) {
			console.warn("使用系统对话框选择文件夹失败，回退目录选择器:", error);
			folderInputRef.current?.click();
		} finally {
			setIsReading(false);
		}
	};

	const handleWebFile = async (file: File | undefined) => {
		if (!file) return;
		setIsReading(true);
		try {
			const bytes = new Uint8Array(await file.arrayBuffer());
			setPreview(readPotatoExport(file.name, bytes));
		} catch {
			setPreview(null);
			snackbar.error(
				t("pages.PotatoImport.readFailed", "读取 PotatoVN 导出文件失败"),
			);
		} finally {
			setIsReading(false);
		}
	};

	const handleWebFolder = async (files: FileList | null) => {
		if (!files || files.length === 0) return;
		setIsReading(true);
		try {
			const result = await readPotatoFromWebFiles(files);
			setPreview(result);
		} catch {
			setPreview(null);
			snackbar.error("读取 PotatoVN 文件夹失败");
		} finally {
			setIsReading(false);
		}
	};

	const handleImport = async () => {
		if (newRecords.length === 0 || isImporting) return;
		setIsImporting(true);
		try {
			const result = await batchAddGames.mutateAsync(
				newRecords.map((item) => toInsertGame(item.record)),
			);
			const failedIndexes = new Set(
				(result.errors ?? []).map((error) => error.index),
			);
			const successful = newRecords.filter(
				(_, index) => !failedIndexes.has(index),
			);
			const insertedGames = result.games ?? [];
			for (let index = 0; index < successful.length; index += 1) {
				const gameId = insertedGames[index]?.id;
				if (!gameId) continue;
				const coverImage = successful[index].record.coverImage;
				const bannerImage = successful[index].record.bannerImage;
				const customDataPatch: Record<string, unknown> = {
					...insertedGames[index]?.custom_data,
				};
				let needsCustomDataUpdate = false;

				if (coverImage) {
					const extension =
						basename(coverImage.name).split(".").at(-1)?.toLowerCase() || "jpg";
					const coverId = `${extension}_${Date.now()}_${index}`;
					await fileService.writeFileBytes(
						join(getcustomCoverFolder(gameId), `cover_${gameId}_${coverId}`),
						coverImage.bytes,
					);
					customDataPatch.image = coverId;
					needsCustomDataUpdate = true;
				}

				if (bannerImage) {
					const extension =
						basename(bannerImage.name).split(".").at(-1)?.toLowerCase() || "png";
					const bannerId = `${extension}_${Date.now()}_${index}`;
					await fileService.writeFileBytes(
						join(getcustomCoverFolder(gameId), `banner_${gameId}_${bannerId}`),
						bannerImage.bytes,
					);
					customDataPatch.banner = bannerId;
					needsCustomDataUpdate = true;
				}

				if (needsCustomDataUpdate) {
					await gameService.updateGame(gameId, {
						custom_data: customDataPatch,
					});
				}

				for (const session of buildSessionEntries(
					gameId,
					successful[index].record,
				)) {
					try {
						await statsService.createManualGameSession(
							session.gameId,
							session.startTime,
							session.duration,
						);
					} catch {
						// Future or malformed dates are skipped while the game import remains valid.
					}
				}
			}
			await queryClient.invalidateQueries({ queryKey: gameKeys.all });
			await queryClient.invalidateQueries({ queryKey: ["stats"] });
			snackbar.success(
				t("pages.PotatoImport.success", "已导入 {{count}} 个游戏", {
					count: result.success,
				}),
			);
			setPreview((current) =>
				current
					? { ...current, duplicates: duplicateCount + result.failed }
					: current,
			);
		} catch (error) {
			snackbar.error(String(error));
		} finally {
			setIsImporting(false);
		}
	};

	return (
		<Box className="mx-auto w-full max-w-[1100px] p-4 sm:p-6">
			<Stack spacing={3}>
				<Box>
					<Typography className="atlas-kicker">SKERRY / IMPORT</Typography>
					<Typography variant="h4" fontWeight={800} className="mt-2">
						导入用户数据
					</Typography>
				</Box>
				<Paper variant="outlined" className="p-5">
					<input
						ref={fileInputRef}
						hidden
						type="file"
						accept=".pvnExport,.zip,.pvnExport.zip,application/zip,*"
						onChange={(event) => void handleWebFile(event.target.files?.[0])}
					/>
					<input
						ref={folderInputRef}
						hidden
						type="file"
						multiple
						{...({ webkitdirectory: "", directory: "" } as Record<string, unknown>)}
						onChange={(event) => void handleWebFolder(event.target.files)}
					/>
					<Box className="mb-4">
						<Typography variant="h6" fontWeight={700}>
							PotatoVN 导入
						</Typography>
						<Typography variant="body2" color="text.secondary">
							导入 Pot（PotatoVN）导出的游戏、多平台数据源编号、封面及游玩记录数据。支持直接选择 .pvnExport/.zip 数据包或已解压的文件夹。
						</Typography>
					</Box>
					<Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
						<Button
							variant="outlined"
							startIcon={<CloudUploadRoundedIcon />}
							onClick={() => void handleSelectFile()}
							disabled={isReading || isImporting || isUserDataBusy}
						>
							{isReading
								? t("pages.PotatoImport.reading", "正在读取...")
								: t("pages.PotatoImport.chooseFile", "选择数据包文件 (.pvnExport / .zip)")}
						</Button>
						<Button
							variant="outlined"
							startIcon={<FolderOpenRoundedIcon />}
							onClick={() => void handleSelectFolder()}
							disabled={isReading || isImporting || isUserDataBusy}
						>
							{isReading
								? t("pages.PotatoImport.reading", "正在读取...")
								: "选择导出文件夹"}
						</Button>
					</Stack>
					{preview && (
						<Typography variant="body2" color="text.secondary" className="mt-3">
							已加载：{preview.fileName}
						</Typography>
					)}
				</Paper>

				{preview && (
					<>
						<Box className="grid grid-cols-2 gap-3 md:grid-cols-4">
							<Paper variant="outlined" className="p-4">
								<Typography variant="body2" color="text.secondary">
									{t("pages.PotatoImport.total", "记录总数")}
								</Typography>
								<Typography variant="h6" fontWeight={700}>
									{preview.total}
								</Typography>
							</Paper>
							<Paper variant="outlined" className="p-4">
								<Typography variant="body2" color="text.secondary">
									{t("pages.PotatoImport.importable", "可导入")}
								</Typography>
								<Typography variant="h6" fontWeight={700}>
									{newRecords.length}
								</Typography>
							</Paper>
							<Paper variant="outlined" className="p-4">
								<Typography variant="body2" color="text.secondary">
									{t("pages.PotatoImport.duplicates", "重复跳过")}
								</Typography>
								<Typography variant="h6" fontWeight={700}>
									{duplicateCount}
								</Typography>
							</Paper>
							<Paper variant="outlined" className="p-4">
								<Typography variant="body2" color="text.secondary">
									{t("pages.PotatoImport.history", "含游玩记录")}
								</Typography>
								<Typography variant="h6" fontWeight={700}>
									{preview.withPlayHistory}
								</Typography>
							</Paper>
						</Box>
						{preview.warnings.map((warning) => (
							<Alert
								key={warning}
								severity="warning"
								icon={<WarningAmberRoundedIcon />}
							>
								{warning}
							</Alert>
						))}
						<Paper variant="outlined" className="overflow-hidden">
							<Box className="px-4 py-3">
								<Typography variant="subtitle1" fontWeight={700}>
									{t("pages.PotatoImport.preview", "预览")}
								</Typography>
							</Box>
							<Divider />
							<List dense disablePadding>
								{importableRecords.slice(0, 80).map(({ record, duplicate }) => (
									<ListItem
										key={record.name + JSON.stringify(record.ids)}
										secondaryAction={
											duplicate ? (
												<Typography color="text.secondary">
													{t("pages.PotatoImport.skipped", "跳过")}
												</Typography>
											) : (
												<CheckCircleOutlineRoundedIcon color="success" />
											)
										}
									>
										<ListItemText
											primary={record.name}
											secondary={
												record.developer ??
												t("category.unknownDeveloper", "未知开发商")
											}
										/>
									</ListItem>
								))}
							</List>
						</Paper>
						<Button
							variant="contained"
							onClick={() => void handleImport()}
							disabled={newRecords.length === 0 || isImporting}
							startIcon={
								isImporting ? (
									<CircularProgress size={18} color="inherit" />
								) : (
									<CheckCircleOutlineRoundedIcon />
								)
							}
						>
							{isImporting
								? t("pages.PotatoImport.importing", "正在导入...")
								: t("pages.PotatoImport.import", "导入 {{count}} 个新游戏", {
										count: newRecords.length,
									})}
						</Button>
					</>
				)}

				<Paper variant="outlined" className="p-5">
					<Box className="mb-4">
						<Typography variant="h6" fontWeight={700}>
							Skerry 导入
						</Typography>
						<Typography variant="body2" color="text.secondary">
							导入本程序自身的用户数据包，包括游戏库、资料源、统计、封面和本地偏好，导入后自动重启。
						</Typography>
					</Box>
					{isReadingUserData && (
						<Box>
							<LinearProgress />
							<Typography
								variant="body2"
								color="text.secondary"
								className="mt-2"
							>
								正在读取用户数据包...
							</Typography>
						</Box>
					)}
					<Button
						variant="outlined"
						startIcon={<CloudUploadRoundedIcon />}
						onClick={() => void handleSelectUserData()}
						disabled={isUserDataBusy || isReading || isImporting}
					>
						{isReadingUserData
							? "正在读取..."
							: userDataPreview
								? "重新选择用户数据包"
								: "选择用户数据包"}
					</Button>
				</Paper>

				{userDataPreview && !isReadingUserData && (
					<>
						<Box className="grid grid-cols-2 gap-3 md:grid-cols-4">
							<Paper variant="outlined" className="p-4">
								<Typography variant="body2" color="text.secondary">
									游戏数量
								</Typography>
								<Typography variant="h6" fontWeight={700}>
									{userDataPreview.games.length}
								</Typography>
							</Paper>
							<Paper variant="outlined" className="p-4">
								<Typography variant="body2" color="text.secondary">
									包大小
								</Typography>
								<Typography variant="h6" fontWeight={700}>
									{(userDataPreview.archiveSize / 1024 / 1024).toFixed(2)} MB
								</Typography>
							</Paper>
							<Paper variant="outlined" className="p-4">
								<Typography variant="body2" color="text.secondary">
									导出版本
								</Typography>
								<Typography variant="h6" fontWeight={700}>
									{userDataPreview.manifest.appVersion}
								</Typography>
							</Paper>
							<Paper variant="outlined" className="p-4">
								<Typography variant="body2" color="text.secondary">
									导出时间
								</Typography>
								<Typography variant="h6" fontWeight={700}>
									{new Date(
										userDataPreview.manifest.exportedAt,
									).toLocaleString()}
								</Typography>
							</Paper>
						</Box>
						{userDataPreview.warnings.map((warning) => (
							<Alert
								key={warning}
								severity="warning"
								icon={<WarningAmberRoundedIcon />}
							>
								{warning}
							</Alert>
						))}
						<Paper variant="outlined" className="overflow-hidden">
							<Box className="px-4 py-3">
								<Typography variant="subtitle1" fontWeight={700}>
									{userDataPreview.message}
								</Typography>
							</Box>
							<Divider />
							<List dense disablePadding>
								{userDataPreview.games.slice(0, 80).map((game) => (
									<ListItem key={game.id}>
										<ListItemText
											primary={game.name}
											secondary={`${game.developer ?? "未知开发商"} · ${game.sourceCount} 个数据源`}
										/>
									</ListItem>
								))}
							</List>
						</Paper>
						<Button
							variant="contained"
							color="warning"
							onClick={() => void handleImportUserData()}
							disabled={isUserDataBusy}
							startIcon={
								isImportingUserData ? (
									<CircularProgress size={18} color="inherit" />
								) : (
									<CheckCircleOutlineRoundedIcon />
								)
							}
						>
							{isImportingUserData
								? "正在导入..."
								: `确认导入 ${userDataPreview.games.length} 个游戏`}
						</Button>
					</>
				)}
			</Stack>
		</Box>
	);
}
