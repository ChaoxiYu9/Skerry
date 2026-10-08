/**
 * @file RightMenu 组件
 * @description 游戏卡片右键菜单组件，支持启动游戏、进入详情、删除、打开文件夹等操作，集成国际化和删除确认弹窗。
 * @module src/components/RightMenu/index
 * @author Skerry contributors (based on ReinaManager)
 * @copyright AGPL-3.0
 *
 * 主要导出：
 * - RightMenu：游戏卡片右键菜单组件
 * - CollectionRightMenu：分组/分类右键菜单组件
 *
 * 依赖：
 * - @mui/icons-material
 * - @/store
 * - @/utils
 * - @/components/AlertBox
 * - react-i18next
 * - @tauri-apps/api/core
 */

import ArticleIcon from "@mui/icons-material/Article";
import DeleteIcon from "@mui/icons-material/Delete";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import PlayCircleOutlineIcon from "@mui/icons-material/PlayCircleOutline";
import PlaylistAddIcon from "@mui/icons-material/PlaylistAdd";
import PlaylistRemoveIcon from "@mui/icons-material/PlaylistRemove";
import RemoveCircleOutlineIcon from "@mui/icons-material/RemoveCircleOutline";
import SyncIcon from "@mui/icons-material/Sync";
import {
	Divider,
	ListItemIcon,
	ListItemText,
	MenuItem,
	MenuList,
} from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertConfirmBox } from "@/components/AlertBox";
import { snackbar } from "@/providers/snackBar";
import { LinkWithScrollSave } from "@/components/LinkWithScrollSave";
import { useGameById } from "@/hooks/features/games/useGameFacade";
import { useGameStatusActions } from "@/hooks/features/games/useGameStatusActions";
import { useDeleteGame } from "@/hooks/queries/useGames";
import { useRemoveGamesFromCategory } from "@/hooks/queries/useCollections";
import { handleOpenFolder } from "@/services/fs/fileDialog";
import { useStore } from "@/store/appStore";
import { useGamePlayStore } from "@/store/gamePlayStore";
import type { GameData } from "@/types";
import type { PlayStatus } from "@/types/collection";
import { BaseRightMenu } from "./BaseRightMenu";
import { PlayStatusSubmenu } from "./PlayStatusSubmenu";

/**
 * RightMenu 组件属性类型
 */
interface RightMenuProps {
	id: number;
	anchorPosition: { top: number; left: number };
	onClose: () => void;
	onLaunchGame: (game: GameData) => void | Promise<void>;
	collectionContext?: boolean;
	categoryId?: number;
}

/**
 * 游戏卡片右键菜单组件
 * 支持启动、详情、删除、打开文件夹等操作
 *
 * @param {RightMenuProps} props 组件属性
 * @returns {JSX.Element | null} 右键菜单
 */
const RightMenu: React.FC<RightMenuProps> = ({
	anchorPosition,
	onClose,
	id,
	onLaunchGame,
	collectionContext = false,
	categoryId,
}) => {
	const setSelectedGameId = useStore((state) => state.setSelectedGameId);
	const nextUpGameIds = useStore((state) => state.nextUpGameIds);
	const addNextUpGame = useStore((state) => state.addNextUpGame);
	const removeNextUpGame = useStore((state) => state.removeNextUpGame);
	const deleteGameMutation = useDeleteGame();
	const removeGamesFromCategoryMutation = useRemoveGamesFromCategory();
	const { selectedGame } = useGameById(id);
	const isGameRunning = useGamePlayStore((s) => s.isGameRunning);
	const [openAlert, setOpenAlert] = useState(false);
	const [isDeleting, setIsDeleting] = useState(false);
	const [isRemoving, setIsRemoving] = useState(false);
	const { t } = useTranslation();
	const hasLocalPath = Boolean(selectedGame?.localpath);
	const isInNextUp = nextUpGameIds.includes(id);

	// 使用 Feature Facade 更新游戏状态
	const { updatePlayStatus } = useGameStatusActions();

	const isThisGameCanRun = Boolean(selectedGame) && !isGameRunning(id);
	const canRemoveFromCategory = collectionContext && Boolean(categoryId);

	/**
	 * 删除游戏操作，带删除确认弹窗
	 */
	const handleDeleteGame = async () => {
		try {
			setIsDeleting(true);
			onClose();
			await deleteGameMutation.mutateAsync(id);
			setSelectedGameId(null);
		} catch (error) {
			console.error("删除游戏失败:", error);
		} finally {
			onClose();
			setIsDeleting(false);
			setOpenAlert(false);
		}
	};

	const handleRemoveFromCategory = async () => {
		if (!categoryId) return;
		try {
			setIsRemoving(true);
			onClose();
			await removeGamesFromCategoryMutation.mutateAsync({
				categoryId,
				gameIds: [id],
			});
			snackbar.success(
				t("components.Cards.removeFromCategorySuccess", "已从收藏夹移除"),
			);
		} catch (error) {
			console.error("移出分类失败:", error);
			snackbar.error(
				t("components.Cards.removeFromCategoryFailed", "移除出收藏夹失败"),
			);
		} finally {
			setIsRemoving(false);
		}
	};

	/**
	 * 更新游戏状态
	 */
		const handlePlayStatusChange = (newStatus: PlayStatus) => {
			updatePlayStatus(
				{ gameId: id, newStatus },
				{
					invalidateScope: "all",
				},
			);
			onClose();
		};

	return (
		<BaseRightMenu
			isopen
			anchorPosition={anchorPosition}
			onClose={onClose}
			ariaLabel={t("components.RightMenu.label", "右键菜单")}
		>
			{/* 删除确认弹窗 */}
			<AlertConfirmBox
				open={openAlert}
				setOpen={setOpenAlert}
				onConfirm={handleDeleteGame}
				isLoading={isDeleting}
			/>

			<MenuList
				dense
				className="skerry-detail-more-menu-list skerry-right-menu-list"
			>
				{/* 启动游戏 */}
				<MenuItem
					disabled={!isThisGameCanRun}
					onClick={() => {
						if (selectedGame) {
							void onLaunchGame(selectedGame);
						}
						onClose();
					}}
				>
					<ListItemIcon>
						{hasLocalPath ? (
							<PlayCircleOutlineIcon fontSize="small" />
						) : (
							<SyncIcon fontSize="small" />
						)}
					</ListItemIcon>
					<ListItemText
						primary={
							hasLocalPath
								? t("components.RightMenu.startGame", "启动游戏")
								: t("components.LaunchModal.syncLocalPath", "同步本地")
						}
					/>
				</MenuItem>

				{/* 进入详情 */}
					<LinkWithScrollSave
						to={`/libraries/${id}`}
						onClick={() => onClose()}
						style={{ textDecoration: "none", color: "inherit" }}
					>
					<MenuItem>
						<ListItemIcon>
							<ArticleIcon fontSize="small" />
						</ListItemIcon>
						<ListItemText
							primary={t("components.RightMenu.enterDetails", "进入详情页")}
						/>
					</MenuItem>
				</LinkWithScrollSave>

				<MenuItem
					disabled={!selectedGame}
					onClick={() => {
						if (isInNextUp) {
							removeNextUpGame(id);
						} else {
							addNextUpGame(id);
						}
						onClose();
					}}
				>
					<ListItemIcon>
						{isInNextUp ? (
							<PlaylistRemoveIcon fontSize="small" />
						) : (
							<PlaylistAddIcon fontSize="small" />
						)}
					</ListItemIcon>
					<ListItemText
						primary={
							isInNextUp
								? t("components.RightMenu.removeNextUp", "移出接下来玩")
								: t("components.RightMenu.addNextUp", "加入接下来玩")
						}
					/>
				</MenuItem>

				{/* 收藏夹只允许移除当前分类，游戏库才允许删除游戏 */}
				{collectionContext ? (canRemoveFromCategory ? (
					<MenuItem
						disabled={isRemoving}
						onClick={() => void handleRemoveFromCategory()}
					>
						<ListItemIcon className="skerry-context-menu-remove-category-icon">
							<RemoveCircleOutlineIcon fontSize="small" />
						</ListItemIcon>
						<ListItemText
							primary={t("components.RightMenu.removeFromCategory", "移除出收藏夹")}
						/>
					</MenuItem>
				) : null) : (
					<MenuItem className="skerry-context-menu-danger-item" onClick={() => setOpenAlert(true)}>
						<ListItemIcon className="skerry-context-menu-danger-icon">
							<DeleteIcon fontSize="small" />
						</ListItemIcon>
						<ListItemText
							primary={t("components.RightMenu.deleteGame", "删除游戏")}
						/>
					</MenuItem>
				)}

				<Divider />

				{/* 打开游戏文件夹 */}
				<MenuItem
					disabled={!hasLocalPath}
					onClick={() => {
						if (hasLocalPath && selectedGame) {
							handleOpenFolder(selectedGame);
						}
						onClose();
					}}
				>
					<ListItemIcon>
						<FolderOpenIcon fontSize="small" />
					</ListItemIcon>
					<ListItemText
						primary={t("components.RightMenu.openGameFolder", "打开游戏目录")}
					/>
				</MenuItem>

				{/* 游戏状态切换 - 二级菜单 */}
				<PlayStatusSubmenu
					currentStatus={selectedGame?.clear}
					onStatusChange={handlePlayStatusChange}
					iconSize="small"
				/>
			</MenuList>
		</BaseRightMenu>
	);
};

export default RightMenu;
