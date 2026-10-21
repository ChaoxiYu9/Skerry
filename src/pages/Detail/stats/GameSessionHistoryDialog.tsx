import {
	Box,
	Button,
	Dialog,
	DialogActions,
	DialogContent,
	DialogTitle,
	IconButton,
	Typography,
} from "@mui/material";
import AccessTimeIcon from "@mui/icons-material/AccessTime";
import AddIcon from "@mui/icons-material/Add";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import { useTranslation } from "react-i18next";
import type { GameSession } from "@/types";
import { GameSessionTimeline } from "./GameSessionTimeline";

interface GameSessionHistoryDialogProps {
	open: boolean;
	onClose: () => void;
	sessions: GameSession[];
	isLoading: boolean;
	isFetching: boolean;
	canLoadMore: boolean;
	deletePending: boolean;
	onLoadMore: () => void;
	onDelete: (session: GameSession) => void;
	onOpenCreate: () => void;
	totalPlayTime?: string;
}

export function GameSessionHistoryDialog({
	open,
	onClose,
	sessions,
	isLoading,
	isFetching,
	canLoadMore,
	deletePending,
	onLoadMore,
	onDelete,
	onOpenCreate,
	totalPlayTime,
}: GameSessionHistoryDialogProps) {
	const { t } = useTranslation();

	return (
		<Dialog
			open={open}
			onClose={onClose}
			maxWidth="sm"
			fullWidth
			PaperProps={{
				sx: {
					borderRadius: 3,
					overflow: "hidden",
					backgroundImage: "none",
				},
			}}
		>
			<DialogTitle
				sx={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					background: "transparent !important",
					px: 3,
					pt: 2.5,
					pb: 2,
					borderBottom: "1px solid",
					borderColor: "divider",
				}}
			>
				<Box sx={{ display: "flex", alignItems: "center", gap: 1.25 }}>
					<Box
						sx={{
							width: 36,
							height: 36,
							borderRadius: 2,
							display: "grid",
							placeItems: "center",
							background: "rgba(249, 115, 22, 0.15)",
							color: "#f97316",
						}}
					>
						<AccessTimeIcon sx={{ fontSize: 20 }} />
					</Box>
										<Box>
						<Typography variant="subtitle1" fontWeight={800}>
							{t("pages.Detail.sessionHistoryTitle", "游玩记录明细")}
						</Typography>
						<Typography variant="caption" color="text.secondary">
							{totalPlayTime
								? (t("pages.Detail.totalPlayTime", "累计总时长") + ": " + totalPlayTime)
								: t("pages.Detail.sessionHistorySubtitle", "管理本游戏的所有游玩会话与手动补录")}
						</Typography>
					</Box>
				</Box>
				<Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
					<Button
						size="small"
						variant="outlined"
						startIcon={<AddIcon />}
						onClick={onOpenCreate}
						sx={{
							borderRadius: 2,
							textTransform: "none",
							fontWeight: 600,
						}}
					>
						{t("pages.Detail.addGameSession", "添加记录")}
					</Button>
					<IconButton onClick={onClose} size="small">
						<CloseRoundedIcon fontSize="small" />
					</IconButton>
				</Box>
			</DialogTitle>

			<DialogContent sx={{ minHeight: 320, maxHeight: 480, p: 3, pt: 2 }}>
				<GameSessionTimeline
					sessions={sessions}
					isLoading={isLoading}
					isFetching={isFetching}
					canLoadMore={canLoadMore}
					deletePending={deletePending}
					onLoadMore={onLoadMore}
					onDelete={onDelete}
				/>
			</DialogContent>

			<DialogActions sx={{ px: 3, py: 1.5, borderTop: "1px solid", borderColor: "divider" }}>
				<Button onClick={onClose} variant="text" sx={{ borderRadius: 2 }}>
					{t("common.close", "关闭")}
				</Button>
			</DialogActions>
		</Dialog>
	);
}
