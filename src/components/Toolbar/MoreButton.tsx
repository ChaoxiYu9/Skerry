import AdminPanelSettingsRoundedIcon from "@mui/icons-material/AdminPanelSettingsRounded";
import ArticleRoundedIcon from "@mui/icons-material/ArticleRounded";
import CloseIcon from "@mui/icons-material/Close";
import DeleteIcon from "@mui/icons-material/Delete";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import MenuIcon from "@mui/icons-material/Menu";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import OpenInFullIcon from "@mui/icons-material/OpenInFull";
import RestartAltRoundedIcon from "@mui/icons-material/RestartAltRounded";
import SaveRoundedIcon from "@mui/icons-material/SaveRounded";
import TurnRightIcon from "@mui/icons-material/TurnRight";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Checkbox from "@mui/material/Checkbox";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import { memo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { AlertConfirmBox } from "@/components/AlertBox";
import { PathSettingsModal } from "@/components/PathSettingsModal";
import { PlayStatusSubmenu } from "@/components/RightMenu/PlayStatusSubmenu";
import { useGameLaunchFlow } from "@/hooks/features/games/useGameLaunchFlow";
import { useGameStatusActions } from "@/hooks/features/games/useGameStatusActions";
import { useDeleteGame, useUpdateGame } from "@/hooks/queries/useGames";
import { useAllSettings } from "@/hooks/queries/useSettings";
import { useProxyImageUrlResolver } from "@/hooks/common/useProxyImageUrlResolver";
import { getRuntimeSourceAdapter, REGISTERED_SOURCE_KEYS } from "@/metadata";
import { normalizeEditableSourceId } from "@/metadata/sourceIds";
import { getSourceIdFromDisplay } from "@/metadata/sourceRecord";
import { snackbar } from "@/providers/snackBar";
import { open as openurl } from "@tauri-apps/plugin-shell";
import { handleOpenFolder } from "@/services/fs/fileDialog";
import { fileService } from "@/services/invoke";
import { useStore } from "@/store/appStore";
import type { GameData, SourceType } from "@/types";
import type { PlayStatus } from "@/types/collection";
import { getUserErrorMessage } from "@/utils/errors";

export const SourceLinkIcon = memo(function SourceLinkIcon({
	source,
}: {
	source: SourceType;
}) {
	const [failedUrl, setFailedUrl] = useState<string>();
	const resolveImageUrl = useProxyImageUrlResolver();
	const adapter = getRuntimeSourceAdapter(source);
	const imageUrl = resolveImageUrl(adapter.iconUrl);

	if (failedUrl === imageUrl) {
		return <CloseIcon fontSize="small" sx={{ color: "error.main" }} />;
	}

	return (
		<Box
			component="img"
			src={imageUrl}
			alt={`${adapter.label} favicon`}
			onError={() => setFailedUrl(imageUrl)}
			sx={{
				width: 16,
				height: 16,
				margin: "2px",
				borderRadius: "4px",
				objectFit: "contain",
			}}
		/>
	);
});

export const useModal = () => {
	const [isopen, setisopen] = useState(false);
	const previousFocus = useRef<HTMLElement | null>(null);

	const handleOpen = () => {
		previousFocus.current = document.activeElement as HTMLElement;
		setisopen(true);
	};

	const handleClose = () => {
		setisopen(false);
		if (previousFocus.current) {
			previousFocus.current.focus();
		}
	};
	return { isopen, handleOpen, handleClose };
};

export const OpenFolder = memo(function OpenFolder({
	selectedGame,
}: {
	selectedGame: GameData;
}) {
	const { t } = useTranslation();
	const isDisabled = selectedGame.localpath == null;

	return (
		<Button
			startIcon={<FolderOpenIcon />}
			color="primary"
			variant="text"
			disabled={isDisabled}
			onClick={() => handleOpenFolder(selectedGame)}
		>
			{t("components.Toolbar.openGameFolder", "打开游戏目录")}
		</Button>
	);
});

export const OpenReadmeText = memo(function OpenReadmeText({
	selectedGame,
}: {
	selectedGame: GameData;
}) {
	const { t } = useTranslation();
	const [opening, setOpening] = useState(false);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [options, setOptions] = useState<Array<{ path: string; name: string }>>(
		[],
	);
	const isDisabled = !selectedGame.localpath || opening;

	const openTextPath = async (path: string) => {
		setOpening(true);
		try {
			await fileService.openGameReadmeTextPath(selectedGame.id, path);
			setPickerOpen(false);
		} catch (error) {
			snackbar.error(
				t("components.Toolbar.openReadmeFailed", "打开游戏说明失败") +
					": " +
					getUserErrorMessage(error, t),
			);
		} finally {
			setOpening(false);
		}
	};

	const handleOpen = async () => {
		if (isDisabled) return;
		setOpening(true);
		try {
			const files = await fileService.listGameReadmeTexts(selectedGame.id);
			if (files.length === 0) {
				snackbar.warning(
					t("components.Toolbar.noReadmeText", "游戏目录中没有找到 TXT 文本"),
				);
				return;
			}
			if (files.length === 1) {
				await fileService.openGameReadmeTextPath(
					selectedGame.id,
					files[0].path,
				);
				return;
			}
			setOptions(files);
			setPickerOpen(true);
		} catch (error) {
			snackbar.error(
				t("components.Toolbar.openReadmeFailed", "打开游戏说明失败") +
					": " +
					getUserErrorMessage(error, t),
			);
		} finally {
			setOpening(false);
		}
	};

	return (
		<>
			<Button
				startIcon={
					opening ? (
						<CircularProgress color="inherit" size={16} />
					) : (
						<ArticleRoundedIcon />
					)
				}
				color="primary"
				variant="text"
				disabled={isDisabled}
				onClick={() => void handleOpen()}
			>
				{opening
					? t("components.Toolbar.openingReadme", "打开中...")
					: t("components.Toolbar.openReadme", "打开游戏说明文本")}
			</Button>
			<Dialog
				open={pickerOpen}
				onClose={() => !opening && setPickerOpen(false)}
				fullWidth
				maxWidth="sm"
			>
				<DialogTitle>
					{t("components.Toolbar.selectReadmeText", "选择说明文本")}
				</DialogTitle>
				<DialogContent dividers>
					<List disablePadding>
						{options.map((file) => (
							<ListItemButton
								key={file.path}
								disabled={opening}
								onClick={() => void openTextPath(file.path)}
							>
								<ListItemText
									primary={file.name}
									secondary={file.path}
									secondaryTypographyProps={{ noWrap: true, title: file.path }}
								/>
							</ListItemButton>
						))}
					</List>
				</DialogContent>
				<DialogActions>
					<Button disabled={opening} onClick={() => setPickerOpen(false)}>
						{t("common.cancel", "取消")}
					</Button>
				</DialogActions>
			</Dialog>
		</>
	);
});

export const OpenSaveDirectory = memo(function OpenSaveDirectory({
	selectedGame,
}: {
	selectedGame: GameData;
}) {
	const { t } = useTranslation();
	const [isOpening, setIsOpening] = useState(false);
	const savePath = selectedGame.savepath?.trim() ?? "";

	const handleOpen = async () => {
		if (!savePath || isOpening) return;
		setIsOpening(true);
		try {
			await fileService.openGameSaveDirectory(selectedGame.id);
		} catch (error) {
			snackbar.error(
				t("components.Toolbar.openSaveDirectoryFailed", "打开存档目录失败") +
					": " +
					getUserErrorMessage(error, t),
			);
		} finally {
			setIsOpening(false);
		}
	};

	return (
		<Button
			startIcon={
				isOpening ? (
					<CircularProgress color="inherit" size={16} />
				) : (
					<SaveRoundedIcon />
				)
			}
			color="primary"
			variant="text"
			disabled={isOpening || !savePath}
			onClick={() => void handleOpen()}
			title={
				savePath ||
				t("components.Toolbar.saveDirectoryNotFound", "请先手动指定存档目录")
			}
		>
			{t("components.Toolbar.openSaveDirectory", "打开存档目录")}
		</Button>
	);
});

export const DeleteModal = memo(function DeleteModal({ id }: { id: number }) {
	const { t } = useTranslation();
	const setSelectedGameId = useStore((state) => state.setSelectedGameId);
	const [openAlert, setOpenAlert] = useState(false);
	const [isDeleting, setIsDeleting] = useState(false);
	const deleteGameMutation = useDeleteGame();
	const navigate = useNavigate();

	const handleDeleteGame = async () => {
		try {
			setIsDeleting(true);
			await deleteGameMutation.mutateAsync(id);
			setSelectedGameId(null);
			navigate(-1);
		} catch (error) {
			console.error("删除游戏失败:", error);
		} finally {
			setIsDeleting(false);
			setOpenAlert(false);
		}
	};

	return (
		<>
			<Button
				startIcon={<DeleteIcon />}
				color="error"
				variant="text"
				disabled={isDeleting}
				onClick={() => setOpenAlert(true)}
			>
				{isDeleting
					? t("components.Toolbar.deleting", "删除中...")
					: t("components.Toolbar.deleteGame", "删除游戏")}
			</Button>
			<AlertConfirmBox
				open={openAlert}
				setOpen={setOpenAlert}
				onConfirm={handleDeleteGame}
				isLoading={isDeleting}
			/>
		</>
	);
});

export interface MoreButtonProps {
	selectedGame: GameData;
	variant?: "default" | "hamburger" | "icon";
	className?: string;
	onlySourceLinks?: boolean;
}

export const MoreButton = memo(function MoreButton({
	selectedGame,
	variant = "default",
	className,
	onlySourceLinks = false,
}: MoreButtonProps) {
	const updateGameMutation = useUpdateGame();
	const { t } = useTranslation();
	const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
	const open = Boolean(anchorEl);
	const [pathSettingsModalOpen, setPathSettingsModalOpen] = useState(false);
	const { data: settings } = useAllSettings();
	const hasLePath = Boolean(settings?.le_path);
	const hasMagpiePath = Boolean(settings?.magpie_path);
	const adminLaunchEnabled = selectedGame.custom_data?.run_as_admin === true;
	const canUseAdminLaunch =
		selectedGame.launch_type !== "steam" &&
		Boolean(selectedGame.localpath && selectedGame.executable);

	const { updatePlayStatus } = useGameStatusActions();
	const { syncLocalPath } = useGameLaunchFlow();
	const gameId = selectedGame.id;

	const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
		setAnchorEl(event.currentTarget);
	};

	const handleClose = () => {
		setAnchorEl(null);
	};

	const handleToggleAdminLaunch = async () => {
		if (!canUseAdminLaunch) {
			handleClose();
			await syncLocalPath(selectedGame);
			return;
		}

		const nextEnabled = !adminLaunchEnabled;
		try {
			await updateGameMutation.mutateAsync({
				gameId,
				updates: {
					custom_data: {
						...(selectedGame.custom_data ?? {}),
						run_as_admin: nextEnabled,
					},
				},
			});
		} catch (error) {
			snackbar.error(
				t(
					"components.Toolbar.adminLaunchSaveFailed",
					"保存管理员模式失败",
				) +
					": " +
					getUserErrorMessage(error, t),
			);
		}
	};

	const handleResetExecutable = async () => {
		handleClose();
		try {
			await updateGameMutation.mutateAsync({
				gameId,
				updates: {
					launch_type: "local",
					localpath: null,
					executable: null,
					steam_launch_id: null,
				},
			});
		} catch (error) {
			snackbar.error(
				`${t("components.Toolbar.executableResetFailed", "重置启动文件失败")}: ${getUserErrorMessage(error, t)}`,
			);
		}
	};

	const sourceLinks = REGISTERED_SOURCE_KEYS.flatMap((source) => {
		const adapter = getRuntimeSourceAdapter(source);
		const sourceId =
			source === "vndb"
				? normalizeEditableSourceId(
						"vndb",
						getSourceIdFromDisplay(selectedGame, source),
					)
				: getSourceIdFromDisplay(selectedGame, source);
		return sourceId
			? [
					{
						source,
						label: adapter.label,
						url: adapter.getExternalUrl(sourceId),
					},
				]
			: [];
	});

	const handlePlayStatusChange = (newStatus: PlayStatus) => {
		updatePlayStatus({ gameId, newStatus });
	};

	const handleToggleLeLaunch = async () => {
		const nextEnabled = selectedGame.le_launch !== 1;

		if (nextEnabled && !hasLePath) {
			handleClose();
			setPathSettingsModalOpen(true);
			return;
		}

		try {
			await updateGameMutation.mutateAsync({
				gameId,
				updates: { le_launch: nextEnabled ? 1 : 0 },
			});
		} catch (error) {
			console.error("更新LE转区启动状态失败:", error);
		}
	};

	const handleToggleMagpie = async () => {
		const nextEnabled = selectedGame.magpie !== 1;

		if (nextEnabled && !hasMagpiePath) {
			handleClose();
			setPathSettingsModalOpen(true);
			return;
		}

		try {
			await updateGameMutation.mutateAsync({
				gameId,
				updates: { magpie: nextEnabled ? 1 : 0 },
			});
		} catch (error) {
			console.error("更新Magpie放大状态失败:", error);
		}
	};

	return (
		<>
			{variant === "hamburger" ? (
				<IconButton
					className={className ?? "detail-more-button"}
					onClick={handleClick}
					title={t("components.Toolbar.more", "更多启动选项与数据源")}
				>
					<MenuIcon sx={{ fontSize: 18 }} />
				</IconButton>
			) : (
				<Button
					startIcon={<MoreVertIcon />}
					color="inherit"
					variant="text"
					onClick={handleClick}
				>
					{t("components.Toolbar.more", "更多")}
				</Button>
			)}
			<Menu
				id="more-menu"
				anchorEl={anchorEl}
				open={open}
				onClose={handleClose}
				transitionDuration={0}
				slotProps={{
					paper: {
						className:
							"skerry-context-menu-paper skerry-detail-more-menu-paper",
						elevation: 8,
						sx: { minWidth: 250, maxWidth: 280, width: 260 },
					},
				}}
				MenuListProps={{
					dense: true,
					className: "skerry-detail-more-menu-list",
				}}
			>
				{sourceLinks.map((link) => (
					<MenuItem
						key={link.source}
						onClick={() => {
							void openurl(link.url);
							handleClose();
						}}
					>
						<ListItemIcon>
							<SourceLinkIcon source={link.source} />
						</ListItemIcon>
						<ListItemText>
							{t("components.Toolbar.sourceLink", "打开{{source}}网页", {
								source: link.label,
							})}
						</ListItemText>
					</MenuItem>
				))}
				{!onlySourceLinks && sourceLinks.length > 0 ? (
					<Divider flexItem sx={{ my: 0.5 }} />
				) : null}
				{!onlySourceLinks && (
					<>
						<MenuItem
							onClick={handleToggleMagpie}
							title={!hasMagpiePath ? "点击设置Magpie软件路径" : undefined}
						>
							<ListItemIcon>
								<OpenInFullIcon fontSize="small" />
							</ListItemIcon>
							<ListItemText>
								{t("components.Toolbar.magpieZoom", "Magpie放大")}
							</ListItemText>
							<Checkbox
								checked={selectedGame.magpie === 1}
								size="small"
								sx={{ p: 0.5 }}
							/>
						</MenuItem>
						<MenuItem
							onClick={handleToggleLeLaunch}
							title={!hasLePath ? "点击设置LE转区软件路径" : undefined}
						>
							<ListItemIcon>
								<TurnRightIcon fontSize="small" />
							</ListItemIcon>
							<ListItemText>
								{t("components.Toolbar.leLaunch", "LE转区启动")}
							</ListItemText>
							<Checkbox
								checked={selectedGame.le_launch === 1}
								size="small"
								sx={{ p: 0.5 }}
							/>
						</MenuItem>
						<MenuItem
							onClick={() => void handleToggleAdminLaunch()}
							selected={adminLaunchEnabled}
							title={
								selectedGame.launch_type === "steam"
									? "Steam 游戏不支持管理员模式启动"
									: !canUseAdminLaunch
										? "点击同步本地启动路径"
										: undefined
							}
						>
							<ListItemIcon>
								<AdminPanelSettingsRoundedIcon fontSize="small" />
							</ListItemIcon>
							<ListItemText
								primary={t(
									"components.Toolbar.adminLaunchToggle",
									"管理员模式启动",
								)}
							/>
							<Checkbox
								checked={adminLaunchEnabled}
								size="small"
								sx={{ p: 0.5 }}
							/>
						</MenuItem>
						<MenuItem onClick={() => void handleResetExecutable()}>
							<ListItemIcon>
								<RestartAltRoundedIcon fontSize="small" />
							</ListItemIcon>
							<ListItemText>
								{t("components.Toolbar.resetExecutable", "重置游戏 EXE")}
							</ListItemText>
						</MenuItem>
						<Divider flexItem sx={{ my: 0.5 }} />

						<PlayStatusSubmenu
							currentStatus={selectedGame.clear}
							onStatusChange={handlePlayStatusChange}
							iconSize="small"
							expandDirection="left"
						/>
					</>
				)}
			</Menu>

			<PathSettingsModal
				open={pathSettingsModalOpen}
				onClose={() => setPathSettingsModalOpen(false)}
				inSettingsPage={false}
			/>
		</>
	);
});