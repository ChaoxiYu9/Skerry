import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import {
	saveScrollPosition,
	setScrollPosition,
} from "@/hooks/common/useScrollRestore";
import { useGameLaunchFlow } from "@/hooks/features/games/useGameLaunchFlow";
import { useRemoveGamesFromCategory } from "@/hooks/queries/useCollections";
import { useAllGameLastPlayedMap } from "@/hooks/queries/useStats";
import { navigateSkerry } from "@/providers/navigationBridge";
import { useStore } from "@/store/appStore";
import type { GameData } from "@/types";
import { getGameDisplayName } from "@/utils/game";
import { CardsBatchBar } from "./CardsBatchBar";
import { getCardSortFieldOverlay } from "./cardSortFieldOverlay";
import { RightMenuHost } from "./RightMenuHost";
import type { RightMenuHostHandle, SortableCardItemProps } from "./types";

interface UseCardsControllerOptions {
	gameIds: number[];
	categoryId?: number;
	enableBatchMode?: boolean;
	enableSortFieldOverlay?: boolean;
	collectionContext?: boolean;
	accessory?: ReactNode;
	scrollRestoreKey?: string;
	pageScroll?: boolean;
}

export function useCardsController({
	gameIds,
	categoryId,
	enableBatchMode = false,
	enableSortFieldOverlay = false,
	collectionContext = false,
	accessory,
	scrollRestoreKey,
	pageScroll = false,
}: UseCardsControllerOptions) {
	const { i18n, t } = useTranslation();
	const isCollectionCategory = typeof categoryId === "number" && categoryId > 0;
	const canUseBatchMode = enableBatchMode || isCollectionCategory;
	const rightMenuRef = useRef<RightMenuHostHandle>(null);

	const {
		setSelectedGameId,
		cardClickMode,
		sortOption,
		showCardSortFieldOverlay,
	} = useStore(
		useShallow((s) => ({
			setSelectedGameId: s.setSelectedGameId,
			cardClickMode: s.cardClickMode,
			sortOption: s.sortOption,
			showCardSortFieldOverlay: s.showCardSortFieldOverlay,
		})),
	);
	const { launchGame } = useGameLaunchFlow();
	const shouldShowCardSortFieldOverlay =
		enableSortFieldOverlay && showCardSortFieldOverlay;
	const shouldLoadLastPlayed =
		shouldShowCardSortFieldOverlay && sortOption === "lastplayed";
	const lastPlayedQuery = useAllGameLastPlayedMap({
		enabled: shouldLoadLastPlayed,
	});
	const [batchMode, setBatchMode] = useState(false);
	const [selectedBatchGameIds, setSelectedBatchGameIds] = useState<number[]>(
		[],
	);
	const selectedBatchGameIdSet = useMemo(
		() => new Set(selectedBatchGameIds),
		[selectedBatchGameIds],
	);
	const showBatchControls = canUseBatchMode && batchMode;
	const removeGamesFromCategoryMutation = useRemoveGamesFromCategory();

	const saveCurrentScrollPosition = useCallback(() => {
		if (scrollRestoreKey) {
			const mainContainer = pageScroll
				? document.querySelector<HTMLElement>(".skerry-main")
				: null;
			if (mainContainer) {
				setScrollPosition(scrollRestoreKey, mainContainer.scrollTop);
				return;
			}
			const container = document.querySelector<HTMLElement>(
				'[data-scroll-restore-key=\"' + scrollRestoreKey + '\"]',
			);
			if (container) {
				setScrollPosition(scrollRestoreKey, container.scrollTop);
				return;
			}
		}

		saveScrollPosition(window.location.pathname);
	}, [pageScroll, scrollRestoreKey]);

	const toggleBatchGame = useCallback((gameId: number) => {
		setSelectedBatchGameIds((prev) =>
			prev.includes(gameId)
				? prev.filter((id) => id !== gameId)
				: [...prev, gameId],
		);
	}, []);

	const handleCardClick = useCallback(
		(cardId: number) => {
			if (showBatchControls) {
				toggleBatchGame(cardId);
				return;
			}

			if (cardClickMode === "navigate") {
				setSelectedGameId(cardId);
				saveCurrentScrollPosition();
				navigateSkerry(`/libraries/${cardId}`);
			} else {
				setSelectedGameId(cardId);
			}
		},
		[
			cardClickMode,
			saveCurrentScrollPosition,
			setSelectedGameId,
			showBatchControls,
			toggleBatchGame,
		],
	);

	const handleCardDoubleClick = useCallback(
		(game: GameData) => {
			if (showBatchControls) return;

			setSelectedGameId(game.id);
			void launchGame(game);
		},
		[launchGame, setSelectedGameId, showBatchControls],
	);

	const handleContextMenu = useCallback(
		(event: React.MouseEvent, cardId: number) => {
			event.preventDefault();
			event.stopPropagation();

			if (showBatchControls) {
				return;
			}

			rightMenuRef.current?.open(cardId, event.clientX, event.clientY);
			setSelectedGameId(cardId);
		},
		[setSelectedGameId, showBatchControls],
	);

	const handleRemoveFromCategory = useCallback(
		async (targetGameIds: number[]) => {
			if (!isCollectionCategory || !categoryId) return;

			const targetGameIdSet = new Set(targetGameIds);
			await removeGamesFromCategoryMutation.mutateAsync({
				categoryId,
				gameIds: targetGameIds,
			});

			setSelectedBatchGameIds((prev) =>
				prev.filter((selectedId) => !targetGameIdSet.has(selectedId)),
			);
		},
		[categoryId, isCollectionCategory, removeGamesFromCategoryMutation],
	);

	const getCardProps = useCallback(
		(game: GameData): SortableCardItemProps => {
			const gameId = game.id;
			return {
				game,
				displayName: getGameDisplayName(game),
				sortFieldOverlay: shouldShowCardSortFieldOverlay
					? getCardSortFieldOverlay({
							game,
							sortOption,
							lastPlayed: lastPlayedQuery.data?.get(gameId),
							language: i18n.language,
							t,
						})
					: undefined,
				batch: showBatchControls
					? { selected: selectedBatchGameIdSet.has(gameId) }
					: undefined,
				interaction: {
					useDelayedClick: !showBatchControls && cardClickMode === "navigate",
					onContextMenu: (e: React.MouseEvent) => handleContextMenu(e, gameId),
					onClick: () => handleCardClick(gameId),
					onDoubleClick: () => handleCardDoubleClick(game),
				},
			};
		},
		[
			cardClickMode,
			handleContextMenu,
			handleCardClick,
			handleCardDoubleClick,
			isCollectionCategory,
			i18n.language,
			lastPlayedQuery.data,
			shouldShowCardSortFieldOverlay,
			selectedBatchGameIdSet,
			showBatchControls,
			sortOption,
			t,
		],
	);

	const controls = (
		<>
			{canUseBatchMode && (
				<CardsBatchBar
					batchMode={batchMode}
					selectedBatchGameIds={selectedBatchGameIds}
					gameIds={gameIds}
					categoryId={categoryId}
					onBatchModeChange={setBatchMode}
					onSelectionChange={setSelectedBatchGameIds}
					onSelectionClear={() => setSelectedBatchGameIds([])}
					onDeleteSuccess={() => setSelectedGameId(null)}
					onRemoveFromCategory={handleRemoveFromCategory}
					collectionContext={collectionContext}
					accessory={accessory}
				/>
			)}
			<RightMenuHost
				ref={rightMenuRef}
				onLaunchGame={launchGame}
				collectionContext={collectionContext}
				categoryId={categoryId}
			/>
		</>
	);

	return {
		controls,
		getCardProps,
		showBatchControls,
	};
}
