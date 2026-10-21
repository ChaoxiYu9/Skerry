import DeleteIcon from "@mui/icons-material/Delete";
import EditIcon from "@mui/icons-material/Edit";
import {
	Box,
	Chip,
	CircularProgress,
	FormControl,
	IconButton,
	MenuItem,
	Select,
	Stack,
	Typography,
} from "@mui/material";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Virtuoso } from "react-virtuoso";
import { SmartImage } from "@/components/SmartImage";
import {
	getCandidateSourceData,
	getRuntimeSourceAdapter,
	SEARCHABLE_SOURCE_KEYS,
} from "@/metadata";
import type { GameLaunchType, GameMetadataDraft } from "@/types";

export interface BulkImportItem {
	key: string;
	name: string;
	path?: string;
	executables: string[];
	status:
		| "pending"
		| "matched"
		| "imported"
		| "error"
		| "not found"
		| "duplicate";
	matchedData?: GameMetadataDraft;
	selectedExe?: string;
	launch_type?: GameLaunchType;
	steam_launch_id?: string;
}

export type VisibleBulkImportItem = BulkImportItem & {
	status: Exclude<BulkImportItem["status"], "imported">;
};

interface BulkImportResultTableProps {
	items: VisibleBulkImportItem[];
	loading: boolean;
	emptyMessage: string;
	onDeleteItem: (key: string) => void;
	onEditItem: (item: VisibleBulkImportItem) => void;
	onExecutableChange: (key: string, executable: string) => void;
}

const gridTemplateColumns =
	"var(--bulk-import-result-columns, minmax(220px, 1.2fr) minmax(230px, 1.2fr) minmax(100px, 0.55fr) minmax(260px, 1.5fr) 88px)";

const gridSx = {
	display: "grid",
	gridTemplateColumns,
	columnGap: 2,
	alignItems: "center",
	width: "100%",
	minWidth: 0,
} as const;

const cellSx = {
	minWidth: 0,
	overflow: "hidden",
	textOverflow: "ellipsis",
	whiteSpace: "nowrap",
} as const;

function getMatchedGameDisplay(
	gameData: GameMetadataDraft | undefined,
	language: string,
): { name: string; image?: string; source: string } {
	if (!gameData) {
		return { name: "", source: "" };
	}

	const useChineseName = language === "zh-CN";
	const displays = SEARCHABLE_SOURCE_KEYS.map((source) => {
		const adapter = getRuntimeSourceAdapter(source);
		const data = getCandidateSourceData(gameData, source);
		return data
			? { label: adapter.label, fields: adapter.toDisplayFields(data) }
			: null;
	});

	let name =
		displays.find((display) => display?.fields.name)?.fields.name ?? "";
	if (useChineseName) {
		const chineseName = displays.find((display) => display?.fields.name_cn)
			?.fields.name_cn;
		if (chineseName) name = chineseName;
	}

	const image =
		gameData.custom_data?.image ??
		displays.find((display) => display?.fields.image)?.fields.image ??
		undefined;
	const source = displays
		.filter((display) => display !== null)
		.map((display) => display.label)
		.join(" + ");
	return { name, image, source };
}

function getStatusLabel(
	status: VisibleBulkImportItem["status"],
	t: TFunction,
): string {
	switch (status) {
		case "pending":
			return t("components.BulkImportModal.statusPending", "待处理");
		case "matched":
			return t("components.BulkImportModal.statusMatched", "已匹配");
		case "not found":
			return t("components.BulkImportModal.statusNotFound", "未找到");
		case "error":
			return t("components.BulkImportModal.statusError", "错误");
		case "duplicate":
			return t("components.BulkImportModal.statusDuplicate", "已存在 (跳过)");
	}
}

export default function BulkImportResultTable({
	items,
	loading,
	emptyMessage,
	onDeleteItem,
	onEditItem,
	onExecutableChange,
}: BulkImportResultTableProps) {
	const { t, i18n } = useTranslation();

	return (
		<Box
			sx={{
				alignSelf: "stretch",
				display: "flex",
				flex: "1 1 auto",
				flexDirection: "column",
				minHeight: 0,
				width: "100%",
			}}
		>
			<Box
				sx={{
					...gridSx,
					borderBottom: 1,
					borderColor: "divider",
					color: "text.primary",
					flexShrink: 0,
					fontWeight: 600,
				}}
				className="bulk-import-result-header px-4 py-1.5"
			>
				<Typography variant="subtitle2" sx={cellSx}>
					{t("components.BulkImportModal.localGame", "本地游戏")}
				</Typography>
				<Typography variant="subtitle2" sx={cellSx}>
					{t("components.BulkImportModal.matchedGame", "匹配的游戏")}
				</Typography>
				<Typography variant="subtitle2" sx={cellSx}>
					{t("components.BulkImportModal.status", "状态")}
				</Typography>
				<Typography variant="subtitle2" sx={cellSx}>
					{t("components.BulkImportModal.executable", "启动程序")}
				</Typography>
				<Typography variant="subtitle2" align="center" sx={cellSx}>
					{t("components.BulkImportModal.actions", "操作")}
				</Typography>
			</Box>

			{items.length === 0 ? (
				<Box
					sx={{
						alignItems: "center",
						display: "flex",
						flex: "1 1 auto",
						justifyContent: "center",
						minHeight: 120,
					}}
				>
					{loading ? (
						<Stack spacing={1.5} alignItems="center">
							<CircularProgress size={28} />
							<Typography color="text.secondary">{emptyMessage}</Typography>
						</Stack>
					) : (
						<Typography color="text.secondary">{emptyMessage}</Typography>
					)}
				</Box>
			) : (
				<Box sx={{ flex: "1 1 auto", minHeight: 0, width: "100%" }}>
					<Virtuoso
						style={{ height: "100%", width: "100%" }}
						className="bulk-import-virtuoso"
						data={items}
						computeItemKey={(_, item) => item.key}
						overscan={300}
						itemContent={(_, item) => {
							const matched = getMatchedGameDisplay(
								item.matchedData,
								i18n.language,
							);
							return (
								<Box
									sx={{
										...gridSx,
										borderBottom: 1,
										borderColor: "divider",
									}}
									className="bulk-import-result-row min-h-16 px-4 py-2"
								>
									<Stack spacing={0.25} sx={cellSx}>
										<Typography
											variant="body2"
											fontWeight={650}
											noWrap
											title={item.name}
										>
											{item.name}
										</Typography>
										<Typography
											variant="caption"
											color="text.secondary"
											noWrap
											title={item.path}
										>
											{item.path || ""}
										</Typography>
									</Stack>
									<Stack
										direction="row"
										spacing={1}
										alignItems="center"
										sx={{ minWidth: 0 }}
									>
										{matched.image ? (
											<SmartImage
												src={matched.image}
												alt=""
												loading="lazy"
												decoding="async"
												className="bulk-import-match-image"
											/>
										) : (
											<Box className="bulk-import-match-image-placeholder">
												{item.name.slice(0, 1)}
											</Box>
										)}
										<Stack spacing={0.25} sx={cellSx}>
											<Typography variant="body2" noWrap title={matched.name}>
												{matched.name || "-"}
											</Typography>
											<Typography
												variant="caption"
												color="text.secondary"
												noWrap
											>
												{matched.source || ""}
											</Typography>
										</Stack>
									</Stack>
									<Chip
										size="small"
										className="bulk-import-status-chip"
										data-status={item.status}
										variant="outlined"
										label={getStatusLabel(item.status, t)}
									/>
									<Box sx={{ minWidth: 0 }}>
										{item.launch_type === "steam" ? (
											<Typography variant="body2" noWrap title={item.path}>
												Steam · {item.steam_launch_id}
												{item.selectedExe ? ` · ${item.selectedExe}` : ""}
											</Typography>
										) : item.executables.length === 0 ? (
											<Typography variant="body2" color="text.secondary">
												{t(
													"components.BulkImportModal.gameDirectory",
													"游戏目录",
												)}
											</Typography>
										) : item.executables.length === 1 ? (
											<Typography
												variant="body2"
												noWrap
												title={item.executables[0]}
											>
												{item.executables[0]}
											</Typography>
										) : (
											<FormControl size="small" fullWidth>
												<Select
													value={item.selectedExe || ""}
													size="small"
													onChange={(event) =>
														onExecutableChange(item.key, event.target.value)
													}
													displayEmpty
													disabled={loading}
													sx={{
														"& .MuiSelect-select": {
															py: 0.75,
														},
													}}
													renderValue={(selected) => (
														<Typography
															variant="body2"
															noWrap
															color={selected ? undefined : "text.secondary"}
														>
															{selected ||
																t(
																	"components.BulkImportModal.selectExe",
																	"请选择启动程序",
																)}
														</Typography>
													)}
												>
													<MenuItem value="" disabled>
														{t(
															"components.BulkImportModal.selectExe",
															"请选择启动程序",
														)}
													</MenuItem>
													{item.executables.map((exe) => (
														<MenuItem key={exe} value={exe}>
															{exe}
														</MenuItem>
													))}
												</Select>
											</FormControl>
										)}
									</Box>
									<Stack direction="row" justifyContent="center">
										<IconButton
											size="small"
											onClick={() => onEditItem(item)}
											disabled={loading}
										>
											<EditIcon fontSize="small" />
										</IconButton>
										<IconButton
											size="small"
											onClick={() => onDeleteItem(item.key)}
											disabled={loading}
										>
											<DeleteIcon fontSize="small" />
										</IconButton>
									</Stack>
								</Box>
							);
						}}
					/>
				</Box>
			)}
		</Box>
	);
}
