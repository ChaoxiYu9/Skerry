import React, { useState, useMemo } from "react";
import {
	Box,
	Button,
	Dialog,
	DialogActions,
	DialogContent,
	DialogTitle,
	IconButton,
	Paper,
	Stack,
	TextField,
	Tooltip,
	Typography,
} from "@mui/material";
import EmojiEventsRoundedIcon from "@mui/icons-material/EmojiEventsRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import FlagRoundedIcon from "@mui/icons-material/FlagRounded";
import { SkerryDatePicker } from "@/components/ui/SkerryDatePicker";
import { useGameById } from "@/hooks/features/games/useGameFacade";
import { useUpdateGame } from "@/hooks/queries/useGames";
import { snackbar } from "@/providers/snackBar";
import { PlayStatus } from "@/types/collection";
import type { ClearRecord } from "@/types/types";

interface ClearHistoryDialogProps {
	open: boolean;
	onClose: () => void;
	gameId: number;
	gameName?: string;
}

const getTodayString = () => {
	const now = new Date();
	const y = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, "0");
	const d = String(now.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
};

export function ClearHistoryDialog({
	open,
	onClose,
	gameId,
	gameName,
}: ClearHistoryDialogProps) {
	const { selectedGame } = useGameById(gameId);
	const updateGameMutation = useUpdateGame();

	const clearRecords = useMemo<ClearRecord[]>(() => {
		const raw = selectedGame?.custom_data?.clear_records;
		if (Array.isArray(raw)) {
			return [...raw].sort((a, b) => {
				if (a.round !== b.round) return a.round - b.round;
				return a.date.localeCompare(b.date);
			});
		}
		return [];
	}, [selectedGame?.custom_data?.clear_records]);

	const nextRoundNumber = useMemo(() => {
		if (clearRecords.length === 0) return 1;
		const maxRound = Math.max(...clearRecords.map((r) => r.round || 1));
		return maxRound + 1;
	}, [clearRecords]);

	const [newDate, setNewDate] = useState(getTodayString);
	const [newRound, setNewRound] = useState(nextRoundNumber);
	const [newNote, setNewNote] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);

	// Sync newRound when nextRoundNumber changes
	React.useEffect(() => {
		setNewRound(nextRoundNumber);
	}, [nextRoundNumber]);

	const handleAddRecord = async () => {
		if (!newDate) {
			snackbar.error("请选择通关日期");
			return;
		}

		setIsSubmitting(true);
		try {
			const recordId = `clear-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
			const record: ClearRecord = {
				id: recordId,
				round: Number(newRound) || 1,
				date: newDate.trim(),
				note: newNote.trim() || undefined,
			};

			const nextRecords = [...clearRecords, record].sort((a, b) => {
				if (a.round !== b.round) return a.round - b.round;
				return a.date.localeCompare(b.date);
			});

			const nextCustomData = {
				...selectedGame?.custom_data,
				clear_records: nextRecords,
			};

			await updateGameMutation.mutateAsync({
				gameId,
				updates: {
					custom_data: nextCustomData,
					...(selectedGame?.clear !== PlayStatus.PLAYED ? { clear: PlayStatus.PLAYED } : {}),
				},
			});

			snackbar.success(`已记录第 ${record.round} 周目通关 (${record.date})`);
			setNewNote("");
			setNewDate(getTodayString());
		} catch (err: any) {
			snackbar.error(err?.message || "保存通关记录失败");
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleDeleteRecord = async (recordId: string) => {
		setIsSubmitting(true);
		try {
			const nextRecords = clearRecords.filter((r) => r.id !== recordId);
			const nextCustomData = {
				...selectedGame?.custom_data,
				clear_records: nextRecords,
			};

			await updateGameMutation.mutateAsync({
				gameId,
				updates: { custom_data: nextCustomData },
			});

			snackbar.info("已删除该条通关记录");
		} catch (err: any) {
			snackbar.error(err?.message || "删除失败");
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<Dialog
			open={open}
			onClose={onClose}
			maxWidth="sm"
			fullWidth
			PaperProps={{
				sx: {
					borderRadius: 3,
					p: 1,
					backgroundImage: "none",
				},
			}}
		>
			<DialogTitle
				sx={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					pb: 1,
				}}
			>
				<Box sx={{ display: "flex", alignItems: "center", gap: 1.25 }}>
					<Box
						sx={{
							width: 34,
							height: 34,
							borderRadius: 2,
							display: "grid",
							placeItems: "center",
							background: "rgba(217, 119, 6, 0.15)",
							color: "#d97706",
						}}
					>
						<EmojiEventsRoundedIcon sx={{ fontSize: 20 }} />
					</Box>
					<Box>
						<Typography variant="subtitle1" fontWeight={800}>
							通关历程归档
						</Typography>
						<Typography variant="caption" color="text.secondary" noWrap>
							{gameName || "当前作品"} · 共记录 {clearRecords.length} 次通关
						</Typography>
					</Box>
				</Box>
				<IconButton size="small" onClick={onClose}>
					<CloseRoundedIcon sx={{ fontSize: 18 }} />
				</IconButton>
			</DialogTitle>

			<DialogContent dividers sx={{ py: 2 }}>
				<Stack spacing={2.5}>
					{/* 已有记录列表 */}
					<Box>
						<Typography
							variant="caption"
							fontWeight={750}
							color="text.secondary"
							sx={{ mb: 1, display: "block" }}
						>
							历史通关记录
						</Typography>

						{clearRecords.length === 0 ? (
							<Paper
								variant="outlined"
								sx={{
									p: 2.5,
									textAlign: "center",
									borderRadius: 2,
									borderStyle: "dashed",
									bgcolor: "action.hover",
								}}
							>
								<Typography variant="body2" color="text.secondary">
									暂未手动标记准确通关日期
								</Typography>
								<Typography variant="caption" color="text.disabled" sx={{ mt: 0.5, display: "block" }}>
									在下方选择日期可记录初次通关或追加周目
								</Typography>
							</Paper>
						) : (
							<Stack spacing={1}>
								{clearRecords.map((rec) => (
									<Paper
										key={rec.id}
										variant="outlined"
										sx={{
											p: 1.5,
											display: "flex",
											alignItems: "center",
											justifyContent: "space-between",
											borderRadius: 2,
											gap: 1.5,
											bgcolor: "background.paper",
											transition: "border-color 0.2s ease",
											"&:hover": {
												borderColor: "primary.main",
											},
										}}
									>
										<Box sx={{ display: "flex", alignItems: "center", gap: 1.25, minWidth: 0, flex: 1 }}>
											<Box
												sx={{
													px: 1.2,
													py: 0.4,
													borderRadius: 1.5,
													fontSize: "0.8rem",
													fontWeight: 800,
													bgcolor:
														rec.round === 1
															? "rgba(217, 119, 6, 0.14)"
															: "rgba(37, 99, 235, 0.14)",
													color: rec.round === 1 ? "#d97706" : "#2563eb",
													flexShrink: 0,
												}}
											>
												{rec.round === 1 ? "初次通关" : `第 ${rec.round} 周目`}
											</Box>
											<Box sx={{ minWidth: 0, flex: 1 }}>
												<Typography variant="body2" fontWeight={750} sx={{ fontVariantNumeric: "tabular-nums" }}>
													{rec.date}
												</Typography>
												{rec.note && (
													<Typography variant="caption" color="text.secondary" noWrap sx={{ display: "block" }}>
														{rec.note}
													</Typography>
												)}
											</Box>
										</Box>
										<Tooltip title="删除该条记录">
											<IconButton
												size="small"
												color="error"
												onClick={() => handleDeleteRecord(rec.id)}
												disabled={isSubmitting}
											>
												<DeleteOutlineRoundedIcon sx={{ fontSize: 18 }} />
											</IconButton>
										</Tooltip>
									</Paper>
								))}
							</Stack>
						)}
					</Box>

					{/* 添加新记录区域 */}
					<Paper
						variant="outlined"
						sx={{
							p: 2,
							borderRadius: 2.5,
							bgcolor: "action.hover",
							display: "flex",
							flexDirection: "column",
							gap: 1.75,
						}}
					>
						<Typography variant="subtitle2" fontWeight={800} sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
							<FlagRoundedIcon sx={{ fontSize: 18, color: "primary.main" }} />
							{clearRecords.length === 0 ? "记录首次通关" : "追加周目通关"}
						</Typography>

						<Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "110px 1fr" }, gap: 1.5, alignItems: "start" }}>
							<TextField
								label="周目"
								size="small"
								type="number"
								inputProps={{ min: 1, max: 99 }}
								value={newRound}
								onChange={(e) => setNewRound(Math.max(1, Number(e.target.value) || 1))}
								disabled={isSubmitting}
								sx={{
									"& .MuiOutlinedInput-root": {
										borderRadius: 1.75,
										fontWeight: 700,
									},
								}}
							/>
							<SkerryDatePicker
								label="通关日期"
								value={newDate}
								onChange={(d) => setNewDate(d)}
								disabled={isSubmitting}
							/>
						</Box>

						<TextField
							label="备注（可选）"
							size="small"
							placeholder="例如：全结局达成 / 二周目真结局 / 白金"
							value={newNote}
							onChange={(e) => setNewNote(e.target.value)}
							disabled={isSubmitting}
							sx={{
								"& .MuiOutlinedInput-root": {
									borderRadius: 1.75,
								},
							}}
						/>

						<Button
							variant="contained"
							color="primary"
							startIcon={<AddRoundedIcon />}
							onClick={handleAddRecord}
							disabled={isSubmitting || !newDate}
							sx={{
								alignSelf: "flex-end",
								borderRadius: 2,
								px: 2.5,
								py: 0.8,
								fontWeight: 750,
							}}
						>
							{clearRecords.length === 0 ? "标记首次通关" : `追加第 ${newRound} 周目`}
						</Button>
					</Paper>
				</Stack>
			</DialogContent>

			<DialogActions sx={{ px: 2, py: 1.25 }}>
				<Button onClick={onClose} sx={{ borderRadius: 2, fontWeight: 700 }}>
					完成
				</Button>
			</DialogActions>
		</Dialog>
	);
}
