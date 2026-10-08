import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import CloseIcon from "@mui/icons-material/Close";
import RadioButtonUncheckedIcon from "@mui/icons-material/RadioButtonUnchecked";
import SearchIcon from "@mui/icons-material/Search";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useGameIndex } from "@/hooks/features/games/useGameListFacade";
import {
	useCategoryGameIds,
	useUpdateCategoryGames,
} from "@/hooks/queries/useCollections";
import { snackbar } from "@/providers/snackBar";
import { getGameCover, getGameDisplayName } from "@/utils/game";
import {
	createSearchIndex,
	searchWithIndex,
} from "@/utils/game/enhancedSearch";

interface ManageGamesDialogProps {
	open: boolean;
	onClose: () => void;
	categoryId: number;
	categoryName?: string;
}

export const ManageGamesDialog: React.FC<ManageGamesDialogProps> = ({
	open,
	onClose,
	categoryId,
	categoryName,
}) => {
	const { t } = useTranslation();
	const { index } = useGameIndex();
	const displayAllGames = index.displayList;
	const categoryGameIdsQuery = useCategoryGameIds(categoryId);
	const updateCategoryGamesMutation = useUpdateCategoryGames();

	const categoryGameIds = useMemo(() => {
		return categoryGameIdsQuery.data || [];
	}, [categoryGameIdsQuery.data]);

	const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
	const [searchInput, setSearchInput] = useState("");
	const [isSaving, setIsSaving] = useState(false);

	// 打开时同步当前分类的游戏
	useEffect(() => {
		if (open) {
			setSelectedIds(new Set(categoryGameIds));
			setSearchInput("");
		}
	}, [open, categoryGameIds]);

	// 创建搜索索引
	const searchIndex = useMemo(
		() => createSearchIndex(displayAllGames),
		[displayAllGames],
	);

	// 过滤游戏列表
	const filteredGames = useMemo(() => {
		const trimmed = searchInput.trim();
		if (!trimmed) return displayAllGames;
		const searchResults = searchWithIndex(searchIndex, trimmed, {
			limit: 500,
		});
		return searchResults.map((r) => r.item);
	}, [displayAllGames, searchIndex, searchInput]);

	// 切换勾选
	const toggleGame = useCallback((gameId: number) => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (next.has(gameId)) {
				next.delete(gameId);
			} else {
				next.add(gameId);
			}
			return next;
		});
	}, []);

	// 全选当前搜索结果
	const handleSelectAllVisible = useCallback(() => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			for (const g of filteredGames) {
				next.add(g.id);
			}
			return next;
		});
	}, [filteredGames]);

	// 清空所选
	const handleClearAll = useCallback(() => {
		setSelectedIds(new Set());
	}, []);

	// 保存更改
	const handleSave = async () => {
		if (categoryId <= 0) return;
		try {
			setIsSaving(true);
			await updateCategoryGamesMutation.mutateAsync({
				categoryId,
				gameIds: Array.from(selectedIds),
			});
			snackbar.success(t("pages.Collection.updateSuccess", "收藏夹游戏已更新"));
			onClose();
		} catch (error) {
			console.error("更新收藏夹游戏失败:", error);
			snackbar.error(t("components.Collection.errors.updateCategoryGamesFailed", "更新分类游戏失败，请重试"));
		} finally {
			setIsSaving(false);
		}
	};

	return (
		<Dialog
			open={open}
			onClose={onClose}
			maxWidth="lg"
			fullWidth
			PaperProps={{
				sx: {
					borderRadius: "18px",
					bgcolor: "background.paper",
					backgroundImage: "none",
					boxShadow: "0 24px 60px rgba(0,0,0,0.22)",
					overflow: "hidden",
				},
			}}
		>
			<DialogTitle
				sx={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					pb: 1.5,
					pt: 2.5,
					px: 3,
					borderBottom: "1px solid",
					borderColor: "divider",
				}}
			>
				<Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
					<Typography variant="h6" fontWeight="bold">
						{categoryName
							? `为「${categoryName}」挑选游戏`
							: "挑选游戏加入收藏夹"}
					</Typography>
					<Box
						sx={{
							px: 1.5,
							py: 0.3,
							borderRadius: "12px",
							bgcolor: "primary.main",
							color: "#fff",
							fontSize: "12px",
							fontWeight: "bold",
						}}
					>
						已勾选 {selectedIds.size} 部
					</Box>
				</Box>
				<IconButton onClick={onClose} size="small">
					<CloseIcon fontSize="small" />
				</IconButton>
			</DialogTitle>

			{/* 搜索与工具快捷栏 */}
			<Box
				sx={{
					px: 3,
					py: 1.5,
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					gap: 2,
					borderBottom: "1px solid",
					borderColor: "divider",
					bgcolor: "action.hover",
				}}
			>
				<TextField
					size="small"
					placeholder="搜索游戏名称、会社、拼音..."
					value={searchInput}
					onChange={(e) => setSearchInput(e.target.value)}
					InputProps={{
						startAdornment: (
							<SearchIcon sx={{ mr: 1, color: "text.secondary", fontSize: 20 }} />
						),
					}}
					sx={{ width: 340, "& .MuiOutlinedInput-root": { borderRadius: "10px" } }}
				/>

				<Box sx={{ display: "flex", gap: 1 }}>
					<Button
						size="small"
						variant="outlined"
						onClick={handleSelectAllVisible}
						sx={{ borderRadius: "8px", textTransform: "none" }}
					>
						全选当前搜索结果 ({filteredGames.length})
					</Button>
					<Button
						size="small"
						color="inherit"
						onClick={handleClearAll}
						disabled={selectedIds.size === 0}
						sx={{ borderRadius: "8px", textTransform: "none" }}
					>
						清空已选
					</Button>
				</Box>
			</Box>

			{/* 封面网格流主体 */}
			<DialogContent
				sx={{
					p: 3,
					minHeight: 460,
					maxHeight: "60vh",
					overflowY: "auto",
					scrollbarWidth: "none",
					"&::-webkit-scrollbar": {
						display: "none",
						width: 0,
						height: 0,
					},
				}}
			>
				{filteredGames.length === 0 ? (
					<Box
						sx={{
							display: "flex",
							flexDirection: "column",
							alignItems: "center",
							justifyContent: "center",
							py: 10,
							color: "text.secondary",
						}}
					>
						<Typography variant="body1">未找到匹配的游戏作品</Typography>
					</Box>
				) : (
					<Box
						sx={{
							display: "grid",
							gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
							gap: 2,
						}}
					>
						{filteredGames.map((game) => {
							const isChecked = selectedIds.has(game.id);
							const cover = getGameCover(game);
							const title = getGameDisplayName(game);

							return (
								<Box
									key={game.id}
									onClick={() => toggleGame(game.id)}
									sx={{
										cursor: "pointer",
										borderRadius: "10px",
										p: 0.8,
										transition: "all 0.18s ease-in-out",
										border: "2px solid",
										borderColor: isChecked ? "primary.main" : "transparent",
										bgcolor: isChecked ? "action.selected" : "background.paper",
										boxShadow: isChecked
											? "0 4px 14px rgba(217,119,6,0.18)"
											: "0 2px 6px rgba(0,0,0,0.04)",
										position: "relative",
										"&:hover": {
											transform: "translateY(-2px)",
											boxShadow: "0 6px 18px rgba(0,0,0,0.1)",
										},
									}}
								>
									{/* 封面图片容器 */}
									<Box
										sx={{
											width: "100%",
											aspectRatio: "2/3",
											borderRadius: "6px",
											overflow: "hidden",
											position: "relative",
											bgcolor: "action.hover",
										}}
									>
										<img
											src={cover}
											alt={title}
											loading="lazy"
											style={{
												width: "100%",
												height: "100%",
												objectFit: "cover",
											}}
										/>
										{/* 右上角选中标记 */}
										<Box
											sx={{
												position: "absolute",
												top: 6,
												right: 6,
												bgcolor: isChecked ? "rgba(255,255,255,0.92)" : "rgba(0,0,0,0.45)",
												borderRadius: "50%",
												display: "flex",
												alignItems: "center",
												justifyContent: "center",
												width: 24,
												height: 24,
												backdropFilter: "blur(4px)",
											}}
										>
											{isChecked ? (
												<CheckCircleIcon sx={{ fontSize: 24, color: "primary.main" }} />
											) : (
												<RadioButtonUncheckedIcon sx={{ fontSize: 20, color: "#fff" }} />
											)}
										</Box>
									</Box>

									{/* 游戏标题与会社 */}
									<Typography
										variant="caption"
										fontWeight="bold"
										noWrap
										sx={{
											display: "block",
											mt: 1,
											color: isChecked ? "primary.main" : "text.primary",
											fontSize: "12px",
										}}
										title={title}
									>
										{title}
									</Typography>
									<Typography
										variant="caption"
										noWrap
										sx={{
											display: "block",
											color: "text.secondary",
											fontSize: "11px",
										}}
									>
										{game.developer || "-"}
									</Typography>
								</Box>
							);
						})}
					</Box>
				)}
			</DialogContent>

			{/* 底部操作条 */}
			<DialogActions
				sx={{
					px: 3,
					py: 2,
					borderTop: "1px solid",
					borderColor: "divider",
					display: "flex",
					justifyContent: "space-between",
				}}
			>
				<Typography variant="body2" color="text.secondary">
					点击封面卡片即可即时勾选或取消
				</Typography>
				<Box sx={{ display: "flex", gap: 1.5 }}>
					<Button onClick={onClose} disabled={isSaving} sx={{ borderRadius: "10px", px: 2.5 }}>
						取消
					</Button>
					<Button
						variant="contained"
						onClick={handleSave}
						disabled={isSaving}
						sx={{
							borderRadius: "10px",
							px: 3,
							fontWeight: "bold",
						}}
					>
						{isSaving ? "保存中..." : `保存添加 (${selectedIds.size})`}
					</Button>
				</Box>
			</DialogActions>
		</Dialog>
	);
};
