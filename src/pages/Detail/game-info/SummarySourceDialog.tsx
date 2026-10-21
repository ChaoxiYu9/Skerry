import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import {
	Alert,
	Box,
	Button,
	CircularProgress,
	Dialog,
	DialogActions,
	DialogContent,
	DialogTitle,
	Stack,
	Typography,
} from "@mui/material";
import { useMemo } from "react";
import { ButtonLoadingIndicator } from "@/components/ui/ButtonLoadingIndicator";
import { getRuntimeSourceAdapter } from "@/metadata";
import type { SourceType } from "@/types";

export const SUMMARY_SOURCE_KEYS = [
	"kun",
	"bgm",
	"hikarinagi",
	"dlsite",
	"erogamescape",
	"vndb",
] as const satisfies readonly SourceType[];

export interface SummarySourceState {
	status: "idle" | "loading" | "ready" | "error";
	summary?: string;
	message?: string;
}

interface SummarySourceDialogProps {
	open: boolean;
	sourceIds: Partial<Record<SourceType, string>>;
	states: Partial<Record<SourceType, SummarySourceState>>;
	disabled: boolean;
	onClose: () => void;
	onFetch: (source: SourceType) => void;
	onSelect: (source: SourceType, summary: string) => void;
}

export function SummarySourceDialog({
	open,
	sourceIds,
	states,
	disabled,
	onClose,
	onFetch,
	onSelect,
}: SummarySourceDialogProps) {
	// 仅筛选出当前已填写有效编号的数据源
	const availableSources = useMemo(() => {
		return SUMMARY_SOURCE_KEYS.filter((source) => {
			const idVal = sourceIds[source];
			return typeof idVal === "string" && idVal.trim().length > 0;
		});
	}, [sourceIds]);

	const count = availableSources.length;

	// 依据可用源数量自适应弹窗宽度，兼顾紧凑美观与留白平衡
	const dialogMaxWidth = useMemo(() => {
		if (count === 0 || count === 1) return "sm";
		if (count === 3) return "lg";
		return "md";
	}, [count]);

	// 依据数量自适应网格排版：
	// 1个：单列全宽自适应展开
	// 2个：双列平衡并排
	// 3个：大屏三列同排直接横向比对，移动端单列
	// 4个及以上：经典双列均匀网格排布
	const gridColumnsSx = useMemo(() => {
		if (count <= 1) return { xs: "1fr" };
		if (count === 2) return { xs: "1fr", sm: "1fr 1fr" };
		if (count === 3) return { xs: "1fr", sm: "1fr 1fr", md: "repeat(3, 1fr)" };
		return { xs: "1fr", md: "1fr 1fr" };
	}, [count]);

	return (
		<Dialog
			open={open}
			onClose={onClose}
			fullWidth
			maxWidth={dialogMaxWidth}
			PaperProps={{
				sx: {
					borderRadius: 3.5,
					overflow: "hidden",
					transition: "max-width 240ms ease",
				},
			}}
		>
			<DialogTitle sx={{ pb: 1, fontWeight: 700 }}>选择简介获取源</DialogTitle>
			<DialogContent
				sx={{
					overflowX: "hidden",
					scrollbarWidth: "none",
					"&::-webkit-scrollbar": {
						display: "none",
					},
				}}
			>
				<Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
					{count > 0
						? "按数据源拉取简介，选择后只会填入当前编辑框，保存前不会覆盖其他资料。"
						: "当前未检测到已填写编号的数据源。请先在编辑表单填写相应编号后再试。"}
				</Typography>

				{count === 0 ? (
					/* 零源空状态优雅卡片 */
					<Box
						sx={{
							p: 4,
							border: "1px dashed",
							borderColor: "divider",
							borderRadius: 3,
							backgroundColor: "action.hover",
							display: "flex",
							flexDirection: "column",
							alignItems: "center",
							justifyContent: "center",
							textAlign: "center",
							gap: 1.5,
							minHeight: 180,
						}}
					>
						<InfoOutlinedIcon sx={{ fontSize: 36, color: "text.secondary", opacity: 0.7 }} />
						<Typography variant="subtitle1" fontWeight={700} color="text.primary">
							暂无已配置编号的数据源
						</Typography>
						<Typography variant="body2" color="text.secondary" sx={{ maxWidth: 360 }}>
							请在编辑页下方的【数据源 ID】栏目中填写至少一个源的编号（如 Bangumi、Kungal、VNDB 等），即可在此直接快速拉取简介。
						</Typography>
					</Box>
				) : (
					<Box
						sx={{
							display: "grid",
							gridTemplateColumns: gridColumnsSx,
							gap: 2,
						}}
					>
						{availableSources.map((source) => {
							const adapter = getRuntimeSourceAdapter(source);
							const state = states[source];
							const isReady = state?.status === "ready";
							const isLoading = state?.status === "loading";
							const isError = state?.status === "error";

							return (
								<Box
									key={source}
									sx={{
										p: 2,
										border: "1px solid",
										borderColor: isReady ? "primary.main" : "divider",
										borderRadius: 2.5,
										backgroundColor: isReady
											? "action.selected"
											: "var(--mui-palette-background-paper)",
										display: "flex",
										flexDirection: "column",
										gap: 1.5,
										minWidth: 0,
										boxSizing: "border-box",
										transition:
											"border-color 0.2s ease, background-color 0.2s ease, transform 0.2s ease",
									}}
								>
									{/* 顶部 Header：图标、源名称、拉取按钮 */}
									<Stack
										direction="row"
										spacing={1.25}
										alignItems="center"
										sx={{ minHeight: 32 }}
									>
										<Box
											component="img"
											src={adapter.iconUrl}
											alt={adapter.label}
											sx={{
												width: 20,
												height: 20,
												borderRadius: 0.75,
												objectFit: "contain",
												flexShrink: 0,
											}}
										/>
										<Typography
											variant="subtitle2"
											fontWeight={700}
											noWrap
											sx={{ flex: 1, minWidth: 0 }}
										>
											{adapter.label}
										</Typography>
										<Button
											size="small"
											variant="outlined"
											className="skerry-button-level-b"
											disabled={disabled || isLoading}
											startIcon={
												isLoading ? (
													<ButtonLoadingIndicator color="inherit" />
												) : undefined
											}
											onClick={() => onFetch(source)}
											sx={{ flexShrink: 0, px: 1.5, minWidth: 64 }}
										>
											{isLoading ? "拉取中" : "拉取"}
										</Button>
									</Stack>

									{/* 中部 Body：自适应高度视口（1个源时拥有更舒适的大视口，多源时保持紧凑对齐） */}
									<Box
										sx={{
											height: count === 1 ? 220 : 160,
											minHeight: count === 1 ? 220 : 160,
											maxHeight: count === 1 ? 220 : 160,
											p: 1.5,
											borderRadius: 1.5,
											border: "1px solid",
											borderColor: "divider",
											backgroundColor: "action.hover",
											overflowY: "auto",
											overflowX: "hidden",
											display: "flex",
											flexDirection: "column",
											boxSizing: "border-box",
											scrollbarWidth: "none",
											"&::-webkit-scrollbar": {
												display: "none",
											},
										}}
									>
										{isLoading ? (
											<Box
												sx={{
													flex: 1,
													display: "flex",
													flexDirection: "column",
													alignItems: "center",
													justifyContent: "center",
													gap: 1,
												}}
											>
												<CircularProgress size={22} />
												<Typography variant="caption" color="text.secondary">
													正在拉取最新简介...
												</Typography>
											</Box>
										) : isError ? (
											<Box
												sx={{ flex: 1, display: "flex", alignItems: "center" }}
											>
												<Alert
													severity="error"
													sx={{
														width: "100%",
														fontSize: "0.78rem",
														p: 1,
														wordBreak: "break-word",
														overflowWrap: "anywhere",
													}}
												>
													{state?.message || "拉取失败"}
												</Alert>
											</Box>
										) : isReady ? (
											<Typography
												variant="body2"
												component="div"
												sx={{
													whiteSpace: "pre-wrap",
													wordBreak: "break-word",
													overflowWrap: "anywhere",
													fontSize: "0.82rem",
													lineHeight: 1.6,
													color: state.summary
														? "text.primary"
														: "text.secondary",
												}}
											>
												{state.summary || "该数据源没有简介内容。"}
											</Typography>
										) : (
											<Box
												sx={{
													flex: 1,
													display: "flex",
													alignItems: "center",
													justifyContent: "center",
													textAlign: "center",
												}}
											>
												<Typography variant="caption" color="text.secondary">
													点击右上角「拉取」获取简介预览
												</Typography>
											</Box>
										)}
									</Box>

									{/* 底部 Footer：确认填入操作按钮 */}
									<Button
										fullWidth
										size="small"
										variant={isReady && state?.summary ? "contained" : "outlined"}
										disabled={disabled || !isReady || !state?.summary}
										onClick={() => onSelect(source, state?.summary || "")}
										sx={{
											minHeight: 32,
											...(!isReady || !state?.summary
												? { opacity: 0.5, borderColor: "divider" }
												: {}),
										}}
									>
										使用这份简介
									</Button>
								</Box>
							);
						})}
					</Box>
				)}
			</DialogContent>
			<DialogActions sx={{ px: 3, pb: 2.5 }}>
				<Button onClick={onClose} disabled={disabled} variant="outlined">
					关闭
				</Button>
			</DialogActions>
		</Dialog>
	);
}
