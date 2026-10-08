import AddRoundedIcon from "@mui/icons-material/AddRounded";
import ArrowDownwardRoundedIcon from "@mui/icons-material/ArrowDownwardRounded";
import ArrowUpwardRoundedIcon from "@mui/icons-material/ArrowUpwardRounded";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import DeleteRoundedIcon from "@mui/icons-material/DeleteRounded";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import MenuItem from "@mui/material/MenuItem";
import MenuList from "@mui/material/MenuList";
import Skeleton from "@mui/material/Skeleton";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Virtuoso } from "react-virtuoso";
import { AlertConfirmBox } from "@/components/AlertBox";
import { BaseRightMenu } from "@/components/RightMenu/BaseRightMenu";
import { useGameLaunchFlow } from "@/hooks/features/games/useGameLaunchFlow";
import { useSingleGameAddActions } from "@/hooks/features/games/useGameMetadataFacade";
import { useDeleteGame, useUpdateGame } from "@/hooks/queries/useGames";
import { navigateSkerry } from "@/providers/navigationBridge";
import { preloadNextUpDetailPage } from "@/providers/routePreloads";
import { snackbar } from "@/providers/snackBar";
import type { NextUpVirtualGame } from "@/store/appStore";
import type { GameData } from "@/types";
import { getUserErrorMessage } from "@/utils/errors";
import { getGameDisplayName } from "@/utils/game";
import {
	copyNextUpAssetsToLibrary,
	deleteNextUpAssets,
} from "./nextUpAssets";
import { NextUpImportDialog } from "./NextUpImportDialog";
import {
	buildNextUpMetadataDraft,
	selectNextUpRuntimeOptions,
} from "./nextUpLibraryImport";
import {
	GameImage,
	type HomeGame,
	isVirtualPlanGame,
	SectionHeading,
} from "./HomeSharedComponents";

export interface HomePlanListProps {
	games: GameData[];
	virtualGames: NextUpVirtualGame[];
	onImport: (game: Omit<NextUpVirtualGame, "id">) => void;
	onRemove: (id: number) => void;
	gamesLoading?: boolean;
}

export const HomePlanList = memo(function HomePlanList({
	games,
	virtualGames,
	onImport,
	onRemove,
	gamesLoading = false,
}: HomePlanListProps) {
	const { t } = useTranslation();
	const { syncLocalPath } = useGameLaunchFlow();
	const { addGameFromMetadata, isAddingGame } = useSingleGameAddActions();
	const updateGameMutation = useUpdateGame();
	const deleteGameMutation = useDeleteGame();
	const [syncingId, setSyncingId] = useState<number | null>(null);
	const [importOpen, setImportOpen] = useState(false);
	const [menuPosition, setMenuPosition] = useState<{
		top: number;
		left: number;
	} | null>(null);
	const [menuGame, setMenuGame] = useState<HomeGame | null>(null);
	const [deleteAlertOpen, setDeleteAlertOpen] = useState(false);
	const [isDeleting, setIsDeleting] = useState(false);
	const [planSortOrder, setPlanSortOrder] = useState<"asc" | "desc">("asc");

	const items = useMemo<HomeGame[]>(() => {
		const getPlanName = (game: HomeGame) =>
			isVirtualPlanGame(game)
				? game.nameCn || game.name
				: getGameDisplayName(game);
		const direction = planSortOrder === "asc" ? 1 : -1;
		return [...games, ...virtualGames].sort(
			(left, right) =>
				getPlanName(left).localeCompare(getPlanName(right), "zh-Hans-CN", {
					numeric: true,
					sensitivity: "base",
				}) * direction,
		);
	}, [games, planSortOrder, virtualGames]);

	const openPlanDetail = (game: HomeGame) => {
		const detailPath = isVirtualPlanGame(game)
			? `/next-up/${Math.abs(game.id)}`
			: `/libraries/${game.id}`;
		if (isVirtualPlanGame(game)) preloadNextUpDetailPage();
		navigateSkerry(detailPath);
	};

	const handleCompletePlan = async (game: HomeGame) => {
		if (syncingId !== null) return;
		setSyncingId(game.id);
		try {
			if (isVirtualPlanGame(game)) {
				const runtimeOptions = await selectNextUpRuntimeOptions();
				if (!runtimeOptions) return;
				const inserted = await addGameFromMetadata(
					buildNextUpMetadataDraft(game),
					runtimeOptions,
				);
				const assets = await copyNextUpAssetsToLibrary(game, inserted.id);
				if (assets.image || assets.banner || game.date) {
					await updateGameMutation.mutateAsync({
						gameId: inserted.id,
						updates: {
							date: game.date,
							custom_data: {
								...inserted.custom_data,
								image: assets.image,
								banner: assets.banner,
							},
						},
					});
				}
				await deleteNextUpAssets(game);
				onRemove(game.id);
				snackbar.success(
					t("home.nextUp.importedToLibrary", "已加入游戏库并移出计划"),
				);
				return;
			}

			const synced = await syncLocalPath(game);
			if (synced) {
				onRemove(game.id);
				snackbar.success(
					t("home.nextUp.syncedToLibrary", "路径已同步并移出计划"),
				);
			}
		} catch (error) {
			snackbar.error(getUserErrorMessage(error, t));
		} finally {
			setSyncingId(null);
		}
	};

	const closePlanMenu = () => {
		setMenuPosition(null);
	};

	const openPlanMenu = (event: React.MouseEvent, game: HomeGame) => {
		event.preventDefault();
		event.stopPropagation();
		setMenuGame(game);
		setMenuPosition({ top: event.clientY, left: event.clientX });
	};

	const handleDeletePlan = async () => {
		if (!menuGame) return;
		setIsDeleting(true);
		setDeleteAlertOpen(false);
		closePlanMenu();
		try {
			if (isVirtualPlanGame(menuGame)) {
				onRemove(menuGame.id);
				return;
			}
			await deleteGameMutation.mutateAsync(menuGame.id);
			onRemove(menuGame.id);
		} catch (error) {
			snackbar.error(getUserErrorMessage(error, t));
		} finally {
			setIsDeleting(false);
			setMenuGame(null);
		}
	};

	const renderPlanRow = (index: number, game: HomeGame) => {
		const displayName = isVirtualPlanGame(game)
			? game.nameCn || game.name
			: getGameDisplayName(game);

		return (
			<Box
				className="atlas-plan-card"
				data-game-card-id={game.id}
				data-flip-key={game.id}
				role="button"
				tabIndex={0}
				aria-label={"打开详情：" + displayName}
				onClick={() => openPlanDetail(game)}
				onContextMenu={(event) => openPlanMenu(event, game)}
				onKeyDown={(event) => {
					if (event.currentTarget !== event.target) return;
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						openPlanDetail(game);
					}
				}}
			>
				<Box className="atlas-plan-cover">
					<GameImage
						game={game}
						replaceNsfwCover={false}
						loading={index > 4 ? "lazy" : "eager"}
						revealMotion={index <= 4}
					/>
				</Box>
				<Box className="atlas-plan-info">
					<Typography className="atlas-plan-name" noWrap>
						{displayName}
					</Typography>
					<IconButton
						className="atlas-plan-complete"
						size="small"
						aria-label="完成计划"
						disabled={syncingId !== null || isAddingGame}
						onClick={(event) => {
							event.stopPropagation();
							void handleCompletePlan(game);
						}}
					>
						<CheckRoundedIcon fontSize="small" />
					</IconButton>
				</Box>
			</Box>
		);
	};

	return (
		<>
			<section className="atlas-section atlas-plan">
				<Box className="atlas-section-bar">
					<Box className="flex items-center gap-1">
						<SectionHeading title="心愿与计划" />
						<Tooltip title={planSortOrder === "asc" ? "升序" : "降序"} arrow>
							<IconButton
								className="atlas-plan-sort-button"
								size="small"
								aria-label={
									planSortOrder === "asc" ? "按名称升序" : "按名称降序"
								}
								onClick={() =>
									setPlanSortOrder((order) =>
										order === "asc" ? "desc" : "asc",
									)
								}
							>
								{planSortOrder === "asc" ? (
									<ArrowUpwardRoundedIcon sx={{ fontSize: 15 }} />
								) : (
									<ArrowDownwardRoundedIcon sx={{ fontSize: 15 }} />
								)}
							</IconButton>
						</Tooltip>
					</Box>
					<IconButton aria-label="添加计划" onClick={() => setImportOpen(true)}>
						<AddRoundedIcon />
					</IconButton>
				</Box>
				{items.length === 0 ? (
					gamesLoading ? (
						<Box sx={{ p: 2, display: "flex", flexDirection: "column", gap: 1.5 }}>
							<Skeleton variant="rounded" height={52} sx={{ borderRadius: "12px", opacity: 0.35 }} />
							<Skeleton variant="rounded" height={52} sx={{ borderRadius: "12px", opacity: 0.2 }} />
						</Box>
					) : (
						<Box className="atlas-empty">
							<Typography>计划轨道是空的。</Typography>
							<Typography variant="caption">
								在游戏库里把下一款游戏放进来。
							</Typography>
						</Box>
					)
				) : (
					<Virtuoso
						className="atlas-plan-list atlas-virtual-list"
						data={items}
						computeItemKey={(_, game) => game.id}
						increaseViewportBy={{ top: 180, bottom: 280 }}
						itemContent={renderPlanRow}
						style={{ height: "100%" }}
					/>
				)}
			</section>
			<NextUpImportDialog
				open={importOpen}
				onClose={() => setImportOpen(false)}
				onImport={onImport}
				title="加入心愿与计划"
			/>
			<BaseRightMenu
				isopen={menuPosition !== null}
				anchorPosition={menuPosition ?? undefined}
				onClose={closePlanMenu}
				ariaLabel="心愿计划右键菜单"
			>
				<MenuList
					dense
					className="skerry-detail-more-menu-list skerry-right-menu-list"
				>
					<MenuItem
						className="skerry-context-menu-danger-item"
						disabled={!menuGame}
						onClick={() => {
							setDeleteAlertOpen(true);
							closePlanMenu();
						}}
					>
						<ListItemIcon className="skerry-context-menu-danger-icon">
							<DeleteRoundedIcon fontSize="small" />
						</ListItemIcon>
						<ListItemText primary="删除" />
					</MenuItem>
				</MenuList>
			</BaseRightMenu>
			<AlertConfirmBox
				open={deleteAlertOpen}
				setOpen={setDeleteAlertOpen}
				onConfirm={() => void handleDeletePlan()}
				isLoading={isDeleting}
			/>
		</>
	);
});