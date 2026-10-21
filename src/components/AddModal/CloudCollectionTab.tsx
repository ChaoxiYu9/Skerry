import CloudDownloadIcon from "@mui/icons-material/CloudDownload";
import RefreshIcon from "@mui/icons-material/Refresh";
import {
	Alert,
	Box,
	Button,
	Checkbox,
	Chip,
	DialogActions,
	DialogContent,
	FormControl,
	InputLabel,
	LinearProgress,
	Link,
	ListItemIcon,
	ListItemText,
	MenuItem,
	Select,
	Stack,
	TextField,
	Typography,
} from "@mui/material";
import { open as openurl } from "@tauri-apps/plugin-shell";
import {
	useCallback,
	useDeferredValue,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Virtuoso } from "react-virtuoso";
import "./CloudCollectionTab.css";
import { PlayStatusIcon } from "@/components/PlayStatusIcon";
import { SmartImage } from "@/components/SmartImage";
import { ButtonLoadingIndicator } from "@/components/ui/ButtonLoadingIndicator";
import { SkerryButton } from "@/components/ui/SkerryButton";
import { useBulkGameAddActions } from "@/hooks/features/games/useGameMetadataFacade";
import { getRuntimeSourceAdapter } from "@/metadata/sourceRegistry";
import { snackbar } from "@/providers/snackBar";
import {
	type CloudCollectionItem,
	loadCloudCollection,
	prepareCloudCollectionItems,
} from "@/services/cloudCollectionImport";
import type { CloudCollectionSource } from "@/types";
import {
	ALL_PLAY_STATUSES,
	PLAY_STATUS_I18N_KEYS,
	type PlayStatus,
} from "@/types/collection";
import { isAbortError } from "@/utils/async";
import { getUserErrorMessage } from "@/utils/errors";

type ImportState = "pending" | "imported" | "error";
type ImportPhase = "idle" | "loading" | "ready" | "preparing" | "importing";

interface CloudCollectionUiItem extends CloudCollectionItem {
	error?: string;
	importState: ImportState;
}

interface ImportSummary {
	failed: number;
	imported: number;
	skipped: number;
}

interface CloudCollectionTabProps {
	hidden: boolean;
	initialSource?: CloudCollectionSource;
	onBusyChange: (busy: boolean) => void;
	onClose: () => void;
	open: boolean;
}

const SOURCE_LABELS: Record<CloudCollectionSource, string> = {
	bgm: "Bangumi",
	vndb: "VNDB",
	hikarinagi: "Hikarinagi",
	kun: "KunGal",
};

function getDisplayName(item: CloudCollectionItem, language: string) {
	return language === "zh-CN" && item.nameCn ? item.nameCn : item.name;
}

export default function CloudCollectionTab({
	hidden,
	initialSource,
	onBusyChange,
	onClose,
	open,
}: CloudCollectionTabProps) {
	const { t, i18n } = useTranslation();
	const { addGamesFromBulkImport, checkGameExists, isAddingGames } =
		useBulkGameAddActions();
	const [source, setSource] = useState<CloudCollectionSource>(
		initialSource ?? "bgm",
	);
	const [phase, setPhase] = useState<ImportPhase>("idle");
	const [items, setItems] = useState<CloudCollectionUiItem[]>([]);
	const [selectedKeys, setSelectedKeys] = useState<Set<string>>(
		() => new Set(),
	);
	const [searchText, setSearchText] = useState("");
	const deferredSearchText = useDeferredValue(searchText.trim().toLowerCase());
	const [statusFilter, setStatusFilter] = useState<"all" | PlayStatus>("all");
	const [folderFilter, setFolderFilter] = useState<string>("all");
	const [filteredExistingCount, setFilteredExistingCount] = useState<number>(0);
	const [progress, setProgress] = useState({ completed: 0, total: 0 });
	const [summary, setSummary] = useState<ImportSummary | null>(null);
	const abortControllerRef = useRef<AbortController | null>(null);

	const busy =
		phase === "loading" ||
		phase === "preparing" ||
		phase === "importing" ||
		isAddingGames;

	useEffect(() => {
		onBusyChange(busy);
	}, [busy, onBusyChange]);

	const reset = useCallback(() => {
		abortControllerRef.current?.abort();
		abortControllerRef.current = null;
		setPhase("idle");
		setItems([]);
		setSelectedKeys(new Set());
		setSearchText("");
		setStatusFilter("all");
		setFolderFilter("all");
		setFilteredExistingCount(0);
		setProgress({ completed: 0, total: 0 });
		setSummary(null);
	}, []);

	useEffect(() => {
		if (!open) {
			reset();
			return;
		}
		if (initialSource) setSource(initialSource);
	}, [initialSource, open, reset]);

	useEffect(() => {
		return () => abortControllerRef.current?.abort();
	}, []);

	const availableFolders = useMemo(() => {
		const folders = new Set<string>();
		for (const item of items) {
			if (item.folderName) folders.add(item.folderName);
		}
		return Array.from(folders);
	}, [items]);

	const visibleItems = useMemo(() => {
		return items.filter((item) => {
			if (statusFilter !== "all" && item.playStatus !== statusFilter) {
				return false;
			}
			if (folderFilter !== "all" && item.folderName !== folderFilter) {
				return false;
			}
			if (!deferredSearchText) return true;
			return [
				item.developer,
				item.name,
				item.nameCn,
				item.originalName,
				item.externalId,
				item.releaseDate,
			].some((value) => value?.toLowerCase().includes(deferredSearchText));
		});
	}, [deferredSearchText, folderFilter, items, statusFilter]);

	const selectableVisibleItems = useMemo(
		() => visibleItems.filter((item) => item.importState !== "imported"),
		[visibleItems],
	);
	const selectionState = useMemo(() => {
		let count = 0;
		let allFailed = true;
		for (const item of items) {
			if (!selectedKeys.has(item.key)) continue;
			count += 1;
			if (item.importState !== "error") allFailed = false;
		}
		return { count, allFailed: count > 0 && allFailed };
	}, [items, selectedKeys]);
	const selectedCount = selectionState.count;

	const handleLoad = async () => {
		abortControllerRef.current?.abort();
		const controller = new AbortController();
		abortControllerRef.current = controller;
		setPhase("loading");
		setItems([]);
		setSelectedKeys(new Set());
		setSummary(null);
		try {
			const collection = await loadCloudCollection(source, controller.signal);
			const nextItems: CloudCollectionUiItem[] = [];
			let existingCount = 0;
			for (const item of collection) {
				if (
					checkGameExists({
						sourceIds: { [item.source]: item.externalId },
					})
				) {
					existingCount += 1;
					continue;
				}
				nextItems.push({
					...item,
					importState: "pending",
				});
			}
			setFilteredExistingCount(existingCount);
			setItems(nextItems);
			setSelectedKeys(new Set(nextItems.map((item) => item.key)));
			setPhase("ready");
		} catch (error) {
			if (isAbortError(error)) {
				setPhase("idle");
				return;
			}
			setPhase("idle");
			snackbar.error(getUserErrorMessage(error, t));
		} finally {
			if (abortControllerRef.current === controller) {
				abortControllerRef.current = null;
			}
		}
	};

	const handleToggleItem = (key: string) => {
		setSelectedKeys((current) => {
			const next = new Set(current);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	const handleSelectVisible = () => {
		setSelectedKeys((current) => {
			const next = new Set(current);
			for (const item of selectableVisibleItems) next.add(item.key);
			return next;
		});
	};

	const handleClearVisible = () => {
		setSelectedKeys((current) => {
			const next = new Set(current);
			for (const item of visibleItems) next.delete(item.key);
			return next;
		});
	};

	const handleImport = async () => {
		const selectedItems = items.filter(
			(item) => selectedKeys.has(item.key) && item.importState !== "imported",
		);
		if (selectedItems.length === 0) return;

		const controller = new AbortController();
		abortControllerRef.current = controller;
		setPhase("preparing");
		setProgress({ completed: 0, total: selectedItems.length });
		setSummary(null);
		try {
			const prepared = await prepareCloudCollectionItems(
				selectedItems,
				controller.signal,
				(result) => {
					setItems((current) =>
						current.map((item) => {
							if (item.key !== result.item.key) return item;
							if (result.metadata) {
								return {
									...item,
									metadata: result.metadata,
									importState:
										item.importState === "imported" ? "imported" : "pending",
									error: undefined,
								};
							}
							return {
								...item,
								importState: "error",
								error: getUserErrorMessage(result.error, t),
							};
						}),
					);
				},
				(completed, total) => setProgress({ completed, total }),
			);
			const failedDetails = new Map(
				prepared
					.filter((result) => result.error)
					.map((result) => [
						result.item.key,
						getUserErrorMessage(result.error, t),
					]),
			);
			const ready = prepared.filter(
				(
					result,
				): result is typeof result & {
					metadata: NonNullable<typeof result.metadata>;
				} => Boolean(result.metadata),
			);

			if (ready.length === 0) {
				setSummary({ imported: 0, skipped: 0, failed: failedDetails.size });
				setPhase("ready");
				return;
			}

			setPhase("importing");
			const result = await addGamesFromBulkImport(
				ready.map(({ item, metadata }) => ({
					name: getDisplayName(item, i18n.language),
					matchedData: metadata,
					playStatus: item.playStatus,
					skipCloudStatusLookup: true,
				})),
			);
			const states = new Map<string, { error?: string; state: ImportState }>();
			const duplicateKeys = new Set<string>();
			for (const [itemIndex, outcome] of result.itemOutcomes.entries()) {
				const key = ready[itemIndex]?.item.key;
				if (!key) continue;
				if (!outcome) continue;

				switch (outcome.kind) {
					case "duplicate":
						duplicateKeys.add(key);
						break;
					case "preparation-error":
					case "request-error":
					case "insertion-error":
						states.set(key, { state: "error", error: outcome.message });
						break;
					case "imported":
						states.set(key, { state: "imported" });
						break;
				}
			}

			setItems((current) =>
				current
					.filter((item) => !duplicateKeys.has(item.key))
					.map((item) => {
						const next = states.get(item.key);
						return next
							? { ...item, importState: next.state, error: next.error }
							: item;
					}),
			);
			setSelectedKeys((current) => {
				const next = new Set(current);
				for (const key of duplicateKeys) next.delete(key);
				for (const [key, state] of states) {
					if (state.state === "imported") {
						next.delete(key);
					}
				}
				return next;
			});
			const imported = [...states.values()].filter(
				(state) => state.state === "imported",
			).length;
			const skipped = duplicateKeys.size;
			const failed =
				failedDetails.size +
				[...states.values()].filter((state) => state.state === "error").length;
			setSummary({ imported, skipped, failed });
			if (imported > 0) {
				snackbar.success(
					t("components.CloudCollectionImport.success", {
						defaultValue: "成功导入 {{count}} 个云端游戏",
						count: imported,
					}),
				);
			}
			setPhase("ready");
		} catch (error) {
			if (isAbortError(error)) {
				snackbar.info(
					t(
						"components.CloudCollectionImport.cancelled",
						"已停止，已获取的元数据将在当前弹窗中保留",
					),
				);
			} else {
				snackbar.error(getUserErrorMessage(error, t));
			}
			setPhase("ready");
		} finally {
			if (abortControllerRef.current === controller) {
				abortControllerRef.current = null;
			}
		}
	};

	const handleCancel = () => {
		abortControllerRef.current?.abort();
	};

	const handleOpenExternal = (item: CloudCollectionItem) => {
		const url = getRuntimeSourceAdapter(item.source).getExternalUrl(
			item.externalId,
		);
		void openurl(url).catch((error) => {
			snackbar.error(getUserErrorMessage(error, t));
		});
	};

	const progressValue =
		progress.total > 0 ? (progress.completed / progress.total) * 100 : 0;

	return (
		<>
			<DialogContent
				className={
					hidden
						? "hidden skerry-cloud-import-content"
						: "skerry-cloud-import-content flex min-h-0 flex-1 flex-col"
				}
			>
				<Stack
					spacing={2}
					className="skerry-cloud-import-layout min-h-0 flex-1 pt-1"
				>
					<Stack
						direction={{ xs: "column", md: "row" }}
						spacing={1.5}
						className="skerry-cloud-import-toolbar"
					>
						<FormControl size="small" className="min-w-44">
							<InputLabel id="cloud-collection-source-label">
								{t("components.CloudCollectionImport.source", "收藏来源")}
							</InputLabel>
							<Select
								labelId="cloud-collection-source-label"
								label={t("components.CloudCollectionImport.source", "收藏来源")}
								value={source}
								onChange={(event) => {
									setSource(event.target.value as CloudCollectionSource);
									reset();
								}}
								disabled={busy}
							>
								{Object.entries(SOURCE_LABELS).map(([value, label]) => (
									<MenuItem key={value} value={value}>
										{label}
									</MenuItem>
								))}
							</Select>
						</FormControl>
						<Button
							variant="contained"
							startIcon={
								phase === "loading" ? (
									<ButtonLoadingIndicator color="inherit" />
								) : (
									<CloudDownloadIcon />
								)
							}
							onClick={() => void handleLoad()}
							disabled={busy}
						>
							{t("components.CloudCollectionImport.load", "读取收藏")}
						</Button>
						<TextField
							size="small"
							value={searchText}
							onChange={(event) => setSearchText(event.target.value)}
							placeholder={t(
								"components.CloudCollectionImport.search",
								"搜索名称或来源 ID",
							)}
							disabled={items.length === 0}
							className="min-w-52 flex-1"
						/>
						{source === "kun" && availableFolders.length > 0 && (
							<FormControl size="small" className="min-w-36">
								<InputLabel id="cloud-collection-folder-label">
									{t("components.CloudCollectionImport.folder", "收藏夹")}
								</InputLabel>
								<Select
									labelId="cloud-collection-folder-label"
									label={t("components.CloudCollectionImport.folder", "收藏夹")}
									value={folderFilter}
									onChange={(event) => setFolderFilter(event.target.value)}
									disabled={items.length === 0}
								>
									<MenuItem value="all">
										{t("common.all", "全部收藏夹")}
									</MenuItem>
									{availableFolders.map((folder) => (
										<MenuItem key={folder} value={folder}>
											{folder}
										</MenuItem>
									))}
								</Select>
							</FormControl>
						)}
						<FormControl size="small" className="min-w-36">
							<InputLabel id="cloud-collection-status-label">
								{t("components.CloudCollectionImport.status", "游玩状态")}
							</InputLabel>
							<Select
								labelId="cloud-collection-status-label"
								label={t("components.CloudCollectionImport.status", "游玩状态")}
								value={statusFilter}
								onChange={(event) =>
									setStatusFilter(event.target.value as "all" | PlayStatus)
								}
								disabled={items.length === 0}
								renderValue={(value) => {
									if (value === "all") return t("common.all", "全部");
									const status = value as PlayStatus;
									return (
										<Stack direction="row" spacing={1} alignItems="center">
											<PlayStatusIcon status={status} />
											<span>{t(PLAY_STATUS_I18N_KEYS[status])}</span>
										</Stack>
									);
								}}
							>
								<MenuItem value="all">{t("common.all", "全部")}</MenuItem>
								{ALL_PLAY_STATUSES.map((status) => (
									<MenuItem key={status} value={status}>
										<ListItemIcon>
											<PlayStatusIcon status={status} />
										</ListItemIcon>
										<ListItemText primary={t(PLAY_STATUS_I18N_KEYS[status])} />
									</MenuItem>
								))}
							</Select>
						</FormControl>
					</Stack>

					<Stack
						direction="row"
						spacing={1}
						alignItems="center"
						flexWrap="wrap"
						className="skerry-cloud-import-selection"
					>
						<SkerryButton
							level="secondary"
							size="sm"
							className="cloud-collection-action-btn"
							onClick={handleSelectVisible}
							disabled={busy || selectableVisibleItems.length === 0}
						>
							{t("components.CloudCollectionImport.selectVisible", "全选")}
						</SkerryButton>
						<SkerryButton
							level="secondary"
							size="sm"
							className="cloud-collection-action-btn"
							onClick={handleClearVisible}
							disabled={busy || selectedCount === 0}
						>
							{t("components.CloudCollectionImport.clearVisible", "清空")}
						</SkerryButton>
						<Typography variant="body2" color="text.secondary">
							{t("components.CloudCollectionImport.selectionSummary", {
								defaultValue: "已选择 {{selected}} / {{total}}",
								selected: selectedCount,
								total: items.length,
							})}
						</Typography>
					</Stack>

					{(phase === "preparing" || phase === "importing") && (
						<Box>
							<Stack
								direction="row"
								justifyContent="space-between"
								className="mb-1"
							>
								<Typography variant="caption">
									{phase === "preparing"
										? t(
												"components.CloudCollectionImport.fetchingDetails",
												"正在获取完整元数据",
											)
										: t(
												"components.CloudCollectionImport.writingGames",
												"正在写入游戏库",
											)}
								</Typography>
								<Typography variant="caption">
									{progress.completed}/{progress.total}
								</Typography>
							</Stack>
							<LinearProgress
								variant={
									phase === "importing" ? "indeterminate" : "determinate"
								}
								value={progressValue}
							/>
						</Box>
					)}

					{filteredExistingCount > 0 && phase === "ready" && (
						<Alert severity="info" className="py-0.5">
							{t(
								"components.CloudCollectionImport.filteredExisting",
								"已自动过滤 {{count}} 部本地游戏库中已存在的游戏",
								{ count: filteredExistingCount },
							)}
						</Alert>
					)}
					{summary && (
						<Alert severity={summary.failed > 0 ? "warning" : "success"}>
							{t("components.CloudCollectionImport.resultSummary", {
								defaultValue:
									"导入 {{imported}} 个，跳过 {{skipped}} 个，失败 {{failed}} 个",
								imported: summary.imported,
								skipped: summary.skipped,
								failed: summary.failed,
							})}
						</Alert>
					)}

					<Box className="skerry-cloud-import-list min-h-56 flex-1 overflow-hidden rounded border border-solid border-[var(--mui-palette-divider)]">
						{items.length === 0 ? (
							<Box className="flex h-full min-h-56 items-center justify-center p-6">
								<Typography color="text.secondary">
									{phase === "loading"
										? t(
												"components.CloudCollectionImport.loading",
												"正在读取云端收藏...",
											)
										: phase === "ready"
											? t(
													"components.CloudCollectionImport.noImportableGames",
													"没有可导入的游戏",
												)
											: t(
													"components.CloudCollectionImport.empty",
													"请选择来源并读取收藏（为防止重复请不要同时导入多源收藏！）",
												)}
								</Typography>
							</Box>
						) : visibleItems.length === 0 ? (
							<Box className="flex h-full min-h-56 items-center justify-center p-6">
								<Typography color="text.secondary">
									{t(
										"components.CloudCollectionImport.noImportableGames",
										"没有可导入的游戏",
									)}
								</Typography>
							</Box>
						) : (
							<Virtuoso
								style={{ height: "100%", width: "100%" }}
								data={visibleItems}
								computeItemKey={(_, item) => item.key}
								overscan={300}
								itemContent={(_, item) => {
									const name = getDisplayName(item, i18n.language);
									const originalName =
										item.originalName && item.originalName !== name
											? item.originalName
											: undefined;
									const metadataText = [
										item.releaseDate,
										originalName
											? t(
													"components.CloudCollectionImport.originalName",
													"原名：{{name}}",
													{ name: originalName },
												)
											: undefined,
										item.developer
											? t(
													"components.CloudCollectionImport.developer",
													"开发商：{{name}}",
													{ name: item.developer },
												)
											: undefined,
									]
										.filter(Boolean)
										.join(" · ");
									const statusChip =
										item.importState === "imported"
											? {
													color: "success" as const,
													label: t(
														"components.CloudCollectionImport.imported",
														"已导入",
													),
												}
											: item.importState === "error"
												? {
														color: "error" as const,
														label: t(
															"components.CloudCollectionImport.failed",
															"失败",
														),
													}
												: null;
									return (
										<Box className="skerry-cloud-import-row grid min-h-16 grid-cols-[auto_44px_minmax(0,1fr)_auto] items-center gap-3 border-0 border-b border-solid border-[var(--mui-palette-divider)] px-3 py-2">
											<Checkbox
												checked={selectedKeys.has(item.key)}
												onChange={() => handleToggleItem(item.key)}
												disabled={busy || item.importState === "imported"}
											/>
											<SmartImage
												src={item.image}
												alt=""
												loading="lazy"
												decoding="async"
												className="h-14 w-11 rounded object-cover bg-[var(--mui-palette-action-hover)]"
											/>
											<Box className="min-w-0">
												<Link
													component="button"
													variant="body2"
													underline="hover"
													onClick={() => handleOpenExternal(item)}
													className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-left"
													title={name}
												>
													{name}
												</Link>
												<Typography variant="caption" color="text.secondary">
													{SOURCE_LABELS[item.source]} · {item.externalId}
													{item.folderName
														? ` · 收藏夹: ${item.folderName}`
														: ""}
												</Typography>
												{metadataText && (
													<Typography
														variant="caption"
														color="text.secondary"
														className="block"
														noWrap
														title={metadataText}
													>
														{metadataText}
													</Typography>
												)}
												{item.error && (
													<Typography
														variant="caption"
														color="error"
														className="block"
														noWrap
													>
														{item.error}
													</Typography>
												)}
											</Box>
											<Stack spacing={0.5} alignItems="flex-end">
												{item.playStatus !== undefined && (
													<Chip
														size="small"
														label={
															<Stack
																direction="row"
																spacing={0.5}
																alignItems="center"
															>
																<PlayStatusIcon status={item.playStatus} />
																<span>
																	{t(PLAY_STATUS_I18N_KEYS[item.playStatus])}
																</span>
															</Stack>
														}
													/>
												)}
												{statusChip && (
													<Chip
														size="small"
														color={statusChip.color}
														label={statusChip.label}
													/>
												)}
											</Stack>
										</Box>
									);
								}}
							/>
						)}
					</Box>
				</Stack>
			</DialogContent>
			<DialogActions className={hidden ? "hidden" : undefined}>
				<Button
					onClick={busy ? handleCancel : onClose}
					disabled={phase === "importing" || isAddingGames}
				>
					{busy
						? t("components.CloudCollectionImport.cancel", "取消任务")
						: t("common.close", "关闭")}
				</Button>
				<Button
					variant="contained"
					startIcon={
						selectionState.allFailed ? <RefreshIcon /> : <CloudDownloadIcon />
					}
					onClick={() => void handleImport()}
					disabled={busy || selectedCount === 0}
				>
					{selectionState.allFailed
						? t("components.CloudCollectionImport.retry", "重试失败项")
						: t("components.CloudCollectionImport.importSelected", {
								defaultValue: "导入所选（{{count}}）",
								count: selectedCount,
							})}
				</Button>
			</DialogActions>
		</>
	);
}
