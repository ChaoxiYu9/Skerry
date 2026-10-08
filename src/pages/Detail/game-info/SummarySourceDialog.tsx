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
	return (
		<Dialog
			open={open}
			onClose={onClose}
			fullWidth
			maxWidth="md"
			PaperProps={{
				sx: {
					borderRadius: 3.5,
					overflow: "hidden",
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
					按数据源拉取简介，选择后只会填入当前编辑框，保存前不会覆盖其他资料。
				</Typography>
				<Box
					sx={{
						display: "grid",
						gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" },
						gap: 2,
					}}
				>
					{SUMMARY_SOURCE_KEYS.map((source) => {
						const adapter = getRuntimeSourceAdapter(source);
						const state = states[source];
						const hasSourceId = Boolean(sourceIds[source]?.trim());
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
									opacity: hasSourceId ? 1 : 0.65,
									display: "flex",
									flexDirection: "column",
									gap: 1.5,
									minWidth: 0,
									boxSizing: "border-box",
									transition: "border-color 0.2s ease, background-color 0.2s ease, opacity 0.2s ease",
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
										disabled={disabled || !hasSourceId || isLoading}
										startIcon={
											isLoading ? <CircularProgress size={13} color="inherit" /> : undefined
										}
										onClick={() => onFetch(source)}
										sx={{ flexShrink: 0, px: 1.5, minWidth: 64 }}
									>
										{isLoading ? "拉取中" : "拉取"}
									</Button>
								</Stack>

								{/* 中部 Body：固定高度预览视口，保证所有卡片高度统一对称 */}
								<Box
									sx={{
										height: 150,
										minHeight: 150,
										maxHeight: 150,
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
									{!hasSourceId ? (
										<Box
											sx={{
												flex: 1,
												display: "flex",
												alignItems: "center",
												justifyContent: "center",
												textAlign: "center",
											}}
										>
											<Typography variant="caption" color="text.disabled">
												未填写该数据源编号，无法拉取
											</Typography>
										</Box>
									) : isLoading ? (
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
										<Box sx={{ flex: 1, display: "flex", alignItems: "center" }}>
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
												color: state.summary ? "text.primary" : "text.secondary",
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

								{/* 底部 Footer：固定底部操作按钮，对齐所有卡片底边 */}
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
			</DialogContent>
			<DialogActions sx={{ px: 3, pb: 2.5 }}>
				<Button onClick={onClose} disabled={disabled} variant="outlined">
					关闭
				</Button>
			</DialogActions>
		</Dialog>
	);
}
