import BookmarkAddIcon from "@mui/icons-material/BookmarkAdd";
import EditIcon from "@mui/icons-material/Edit";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { SortableCardsGrid } from "@/components/Cards";
import {
	mergeVisibleGameOrder,
	reconcileGameOrder,
} from "@/components/Cards/gameOrder";
import { ManageGamesDialog } from "@/components/Collection";
import { GameListControls } from "@/components/GameListControls";
import { GameListStateView } from "@/components/GameListStateView";
import { useGameListFacade } from "@/hooks/features/games/useGameListFacade";
import { useUpdateCategoryGames } from "@/hooks/queries/useCollections";
import { useStore } from "@/store/appStore";

interface DeveloperGamesViewProps {
	sourceGameIds: number[];
	scrollRestoreKey: string;
}

function DeveloperGamesView({
	sourceGameIds,
	scrollRestoreKey,
}: DeveloperGamesViewProps) {
	const { t } = useTranslation();
	const gameList = useGameListFacade({
		scopeGameIds: sourceGameIds,
		applyNsfwFilter: false,
	});
	const savedOrder = useStore(
		(state) => state.scopedGameOrders[scrollRestoreKey],
	);
	const setScopedGameOrder = useStore((state) => state.setScopedGameOrder);
	const fullOrder = useMemo(
		() =>
			reconcileGameOrder(
				savedOrder && savedOrder.length > 0 ? savedOrder : sourceGameIds,
				sourceGameIds,
			),
		[savedOrder, sourceGameIds],
	);
	const visibleGameIds = useMemo(() => {
		const visibleGameIdSet = new Set(gameList.gameIds);
		return fullOrder.filter((gameId) => visibleGameIdSet.has(gameId));
	}, [fullOrder, gameList.gameIds]);
	const handleReorder = useCallback(
		(nextVisibleGameIds: number[]) => {
			setScopedGameOrder(
				scrollRestoreKey,
				mergeVisibleGameOrder(fullOrder, nextVisibleGameIds),
			);
		},
		[fullOrder, scrollRestoreKey, setScopedGameOrder],
	);
	const emptyMessage =
		sourceGameIds.length === 0
			? t("pages.Collection.noGamesInCategory", "当前分类下暂无游戏")
			: t("pages.Collection.noMatchingGames", "没有找到符合条件的游戏");

	return (
		<GameListStateView
			loading={gameList.isLoading}
			error={gameList.isError ? gameList.error : null}
			empty={gameList.gameIds.length === 0}
			emptyMessage={emptyMessage}
			keepChildrenWhenEmpty
		>
			<SortableCardsGrid
				gameIds={visibleGameIds}
				displayById={gameList.displayById}
				onReorder={handleReorder}
				accessory={<GameListControls />}
				enableBatchMode
				enableSortFieldOverlay
				collectionContext
				scrollRestoreKey={scrollRestoreKey}
				dragSortEnabled={true}
			/>
		</GameListStateView>
	);
}

interface CollectionGamesViewProps {
	realCategoryId: number | null;
	categoryName?: string;
	gameIds: number[];
	loading: boolean;
	error: unknown;
	scrollRestoreKey: string;
}

export function CollectionGamesView({
	realCategoryId,
	categoryName = "",
	gameIds,
	loading,
	error,
	scrollRestoreKey,
}: CollectionGamesViewProps) {
	const { t } = useTranslation();
	const [manageDialogOpen, setManageDialogOpen] = useState(false);
	const scopedGameList = useGameListFacade({
		scopeGameIds: gameIds,
		applyNsfwFilter: false,
	});
	const { mutateAsync: updateCategoryGames } = useUpdateCategoryGames();
	const handleCategoryReorder = useCallback(
		async (nextGameIds: number[]) => {
			if (realCategoryId === null) return;
			await updateCategoryGames({
				categoryId: realCategoryId,
				gameIds: nextGameIds,
			});
		},
		[realCategoryId, updateCategoryGames],
	);

	if (realCategoryId === null) {
		return (
			<DeveloperGamesView
				sourceGameIds={gameIds}
				scrollRestoreKey={scrollRestoreKey}
			/>
		);
	}

	const emptyGuide = (
		<Box
			className="collection-empty-prompt-card"
			sx={{
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				justifyContent: "center",
				py: 5,
				px: 4,
				borderRadius: "20px",
				border: "1px dashed",
				borderColor: "divider",
				bgcolor: "background.paper",
				boxShadow: "0 10px 30px rgba(0,0,0,0.04)",
				textAlign: "center",
				maxWidth: 420,
				mx: "auto",
			}}
		>
			<Box
				sx={{
					width: 52,
					height: 52,
					borderRadius: "16px",
					bgcolor: "action.hover",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					mb: 2,
					color: "primary.main",
				}}
			>
				<BookmarkAddIcon sx={{ fontSize: 26 }} />
			</Box>
			<Typography
				variant="h6"
				fontWeight="bold"
				sx={{ mb: 0.8, fontSize: "16px" }}
			>
				{t("pages.Collection.noGamesInCategory", "当前分类下暂无游戏")}
			</Typography>
			<Typography
				variant="body2"
				color="text.secondary"
				sx={{ mb: 0, fontSize: "13px", lineHeight: 1.6 }}
			>
				{t(
					"pages.Collection.emptyCategoryHint",
					"点击右上角的“管理游戏”，从游戏库选择作品加入此分类。",
				)}
			</Typography>
		</Box>
	);

	const manageGamesAction = (
		<Button
			className="library-action-button library-action-primary skerry-button-level-a skerry-button-level-a-gradient collection-manage-games-button"
			variant="contained"
			startIcon={<EditIcon />}
			onClick={() => setManageDialogOpen(true)}
		>
			{t("components.Toolbar.Collection.Category.manageGames", "管理游戏")}
		</Button>
	);

	return (
		<>
			<GameListStateView
				loading={loading || scopedGameList.isLoading}
				error={error ?? (scopedGameList.isError ? scopedGameList.error : null)}
				empty={scopedGameList.gameIds.length === 0}
				customEmptyView={emptyGuide}
				keepChildrenWhenEmpty
			>
				<SortableCardsGrid
					gameIds={scopedGameList.gameIds}
					displayById={scopedGameList.displayById}
					categoryId={realCategoryId ?? undefined}
					onReorder={handleCategoryReorder}
					accessory={<GameListControls manageGamesAction={manageGamesAction} />}
					enableBatchMode
					enableSortFieldOverlay
					collectionContext
					scrollRestoreKey={scrollRestoreKey}
					dragSortEnabled={true}
				/>
			</GameListStateView>
			<ManageGamesDialog
				open={manageDialogOpen}
				onClose={() => setManageDialogOpen(false)}
				categoryId={realCategoryId}
				categoryName={categoryName}
			/>
		</>
	);
}
