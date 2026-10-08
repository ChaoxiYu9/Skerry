import {
	memo,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { VirtuosoGrid } from "react-virtuoso";
import { useVirtuosoGridRestore } from "@/hooks/common/useScrollRestore";
import type { GameData } from "@/types";
import { CardItem } from "./CardItem";
import { useCardsController } from "./useCardsController";

let isGridScrollingActive = false;
export function isCardsGridScrolling(): boolean {
	return isGridScrollingActive;
}

const CARD_GRID_MIN_COLUMN_WIDTH = 176;
const CARD_GRID_COLUMN_GAP = 20;
const CARD_GRID_ROW_HEIGHT_ESTIMATE = 340;
const VIRTUAL_CARDS_GRID_CLASS =
	"grid gap-x-5 gap-y-7 pb-0 [grid-template-columns:repeat(var(--virtual-cards-grid-columns),minmax(0,var(--virtual-cards-grid-column-width)))]";

function getGridWidth(scrollRegion?: HTMLElement | null): number {
	if (scrollRegion) {
		const style = window.getComputedStyle(scrollRegion);
		const inlinePadding =
			Number.parseFloat(style.paddingLeft || "0") +
			Number.parseFloat(style.paddingRight || "0");
		return Math.max(0, scrollRegion.clientWidth - inlinePadding);
	}
	const stage = document.querySelector<HTMLElement>(".library-card-stage");
	return stage?.clientWidth ?? window.innerWidth;
}

function getColumnCount(scrollRegion?: HTMLElement | null): number {
	const width = getGridWidth(scrollRegion);
	return Math.max(
		1,
		Math.floor(
			(width + CARD_GRID_COLUMN_GAP) /
				(CARD_GRID_MIN_COLUMN_WIDTH + CARD_GRID_COLUMN_GAP),
		),
	);
}

function getColumnWidth(
	columns: number,
	scrollRegion?: HTMLElement | null,
): number {
	const width = getGridWidth(scrollRegion);
	const availableWidth = width - CARD_GRID_COLUMN_GAP * Math.max(0, columns - 1);
	return Math.max(CARD_GRID_MIN_COLUMN_WIDTH, Math.floor(availableWidth / columns));
}

interface VirtualCardsGridProps {
	gameIds: number[];
	displayById: Map<number, GameData>;
	categoryId?: number;
	scrollRestoreKey?: string | null;
	enableBatchMode?: boolean;
	enableSortFieldOverlay?: boolean;
	accessory?: ReactNode;
	pageScroll?: boolean;
}

/**
 * VirtualCardsGrid - 虚拟化游戏卡片网格
 *
 * 滚动恢复：
 * - 保存：scroll 事件中缓存 main.scrollTop - wrapper 相对偏移（列表内坐标），
 *         unmount 时写入通用滚动缓存（ref 值，避免 react-router 重置 DOM 的时序问题）
 * - 恢复：优先使用 VirtuosoGrid 状态快照，缺失时 fallback 到近似 item index
 */
export const VirtualCardsGrid = memo(
	({
		gameIds,
		displayById,
		categoryId,
		scrollRestoreKey = "libraries",
		enableBatchMode = false,
		enableSortFieldOverlay = false,
		accessory,
		pageScroll = false,
	}: VirtualCardsGridProps) => {
		const [scrollRegion, setScrollRegion] = useState<HTMLDivElement | null>(
			null,
		);
		const scrollIdleTimerRef = useRef<number | null>(null);
		const { controls, getCardProps } = useCardsController({
			gameIds,
			categoryId,
			enableBatchMode,
			enableSortFieldOverlay,
			accessory,
			scrollRestoreKey: scrollRestoreKey ?? undefined,
		});
		const [columns, setColumns] = useState(() => getColumnCount());
		const scrollContainer = useMemo(
			() =>
				pageScroll
					? (scrollRegion?.closest<HTMLElement>(".skerry-main") ??
						scrollRegion)
					: scrollRegion,
			[pageScroll, scrollRegion],
		);

		const {
			restoreProps,
			scrollParent,
			stateChanged,
		} = useVirtuosoGridRestore({
			columns,
			itemCount: gameIds.length,
			rowHeight: CARD_GRID_ROW_HEIGHT_ESTIMATE,
			scrollKey: scrollRestoreKey,
			containerSelector: ".virtual-cards-scroll-region",
			scrollParentElement: scrollContainer,
			wrapperElement: scrollRegion,
			preferScrollParentElement: true,
		});

		const setScrollRegionRef = useCallback(
			(node: HTMLDivElement | null) => {
				setScrollRegion(node);
			},
			[],
		);

		const handleScrollActivity = useCallback(() => {
			if (!scrollContainer) return;
			if (!scrollRegion) return;
			if (!isGridScrollingActive) {
				isGridScrollingActive = true;
				scrollContainer.classList.add("is-page-scrolling");
				scrollRegion.classList.add("is-scrolling");
			}
			if (scrollIdleTimerRef.current !== null) {
				window.clearTimeout(scrollIdleTimerRef.current);
			}
			scrollIdleTimerRef.current = window.setTimeout(() => {
				isGridScrollingActive = false;
				scrollIdleTimerRef.current = null;
				scrollContainer.classList.remove("is-page-scrolling");
				scrollRegion.classList.remove("is-scrolling");
			}, 140);
		}, [scrollContainer, scrollRegion]);

		useEffect(() => {
			return () => {
				isGridScrollingActive = false;
				if (scrollIdleTimerRef.current !== null) {
					window.clearTimeout(scrollIdleTimerRef.current);
					scrollIdleTimerRef.current = null;
				}
				scrollRegion?.classList.remove("is-scrolling");
				scrollContainer?.classList.remove("is-page-scrolling");
			};
		}, [scrollContainer, scrollRegion]);

		useEffect(() => {
			if (!scrollContainer) return;
			scrollContainer.addEventListener("scroll", handleScrollActivity, {
				passive: true,
			});
			return () => {
				scrollContainer.removeEventListener("scroll", handleScrollActivity);
			};
		}, [handleScrollActivity, scrollContainer]);

		useEffect(() => {
			if (!scrollRegion) return;
			const updateColumns = () => {
				if (document.documentElement.classList.contains("skerry-window-resizing")) {
					return;
				}
				const nextColumns = getColumnCount(scrollRegion);
				setColumns((current) =>
					current === nextColumns ? current : nextColumns,
				);
			};
			const updateAfterResize = () => updateColumns();
			updateColumns();
			const observer = new ResizeObserver(updateColumns);
			observer.observe(scrollRegion);
			window.addEventListener("skerry:window-resize-end", updateAfterResize);
			return () => {
				observer.disconnect();
				window.removeEventListener("skerry:window-resize-end", updateAfterResize);
			};
		}, [scrollRegion]);

		return (
			<>


				{controls}
				<div
					ref={setScrollRegionRef}
					className="cards-scroll-region virtual-cards-scroll-region flex-1 min-h-0"
					data-scroll-restore-key={scrollRestoreKey ?? undefined}
					onScroll={handleScrollActivity}
				>
					{scrollParent && (
						<VirtuosoGrid
							key={scrollRestoreKey ?? "no-scroll-restore"}
							customScrollParent={scrollParent}
							data={gameIds}
							computeItemKey={(index, gameId) =>
								gameId === undefined
									? `missing-game-${index}`
									: `game-${gameId}`
							}
							listClassName={VIRTUAL_CARDS_GRID_CLASS}
							itemClassName="min-w-0"
							increaseViewportBy={{ top: 160, bottom: 260 }}
							stateChanged={stateChanged}
							{...restoreProps}
							style={
								{
									"--virtual-cards-grid-columns": columns,
									"--virtual-cards-grid-column-width":
										getColumnWidth(columns, scrollRegion) + "px",
								} as React.CSSProperties
							}
							itemContent={(index, gameId) => {
								if (gameId === undefined) return null;
								const game = displayById.get(gameId);
								if (!game) return null;
								const props = getCardProps(game);
								return (
									<CardItem
										{...props}
										imageLoading={index < columns ? "eager" : "lazy"}
										disableImageReveal={index >= columns * 2}
									/>
								);
							}}
						/>
					)}
				</div>
			</>
		);
	},
);

VirtualCardsGrid.displayName = "VirtualCardsGrid";
