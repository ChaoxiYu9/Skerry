import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	DragOverlay,
	type DragStartEvent,
	MeasuringFrequency,
	MeasuringStrategy,
} from "@dnd-kit/core";
import {
	rectSortingStrategy,
	SortableContext,
	useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { CSSProperties, ReactNode } from "react";
import {
	memo,
	useCallback,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import type { ListRange } from "react-virtuoso";
import { useFlipMotion } from "@/components/motion/useFlipMotion";
import { useLibraryScrollDiagnostics } from "@/hooks/common/useLibraryScrollDiagnostics";
import {
	getScrollPosition,
	setScrollPosition,
} from "@/hooks/common/useScrollRestore";
import { warmCardCovers } from "@/services/game/cardImageCache";
import { useStore } from "@/store/appStore";
import type { GameData } from "@/types";
import { getGameCardCover, getGameNsfwStatus } from "@/utils/game";
import { CardItem } from "./CardItem";
import { CardsViewport } from "./CardsViewport";
import type { SortableCardItemProps } from "./types";
import { useCardsController } from "./useCardsController";
import { useDragSort } from "./useDragSort";

function getMotionSignature(ids: readonly number[]): string {
	return ids.join(",");
}

interface SortableCardsGridProps {
	gameIds: number[];
	displayById: Map<number, GameData>;
	/** Category context for card actions; order persistence is provided by the page. */
	categoryId?: number;
	onReorder?: (gameIds: number[]) => Promise<void> | void;
	enableBatchMode?: boolean;
	enableSortFieldOverlay?: boolean;
	collectionContext?: boolean;
	accessory?: ReactNode;
	scrollRestoreKey?: string;
	dragSortEnabled?: boolean;
	pageScroll?: boolean;
	clearBatchModeOnRouteChange?: boolean;
}

const SortableCardItem = memo((props: SortableCardItemProps) => {
	const { game, disabledSortable, imageLoading, ...restProps } = props;

	const { attributes, listeners, setNodeRef, transform, isDragging } =
		useSortable({ id: game.id, disabled: disabledSortable });

	const style = useMemo(
		() =>
			({
				"--sortable-card-transform": CSS.Transform.toString(transform),
				"--sortable-card-z-index": isDragging ? 1000 : "auto",
				opacity: isDragging ? 0 : 1,
			}) as CSSProperties,
		[transform, isDragging],
	);

	return (
		<CardItem
			ref={setNodeRef}
			style={style}
			game={game}
			imageLoading={imageLoading}
			{...restProps}
			dragHandleProps={
				disabledSortable ? undefined : { ...attributes, ...listeners }
			}
		/>
	);
});

SortableCardItem.displayName = "SortableCardItem";

/**
 * SortableCardsGrid - 拖拽卡片布局。
 *
 * 接收 ID 数组和展示索引，渲染时按 ID 取 GameData。
 */
export const SortableCardsGrid = memo(
	({
		gameIds,
		displayById,
		categoryId,
		onReorder,
		enableBatchMode = false,
		enableSortFieldOverlay = false,
		collectionContext = false,
		accessory,
		scrollRestoreKey,
		dragSortEnabled = true,
		pageScroll = false,
		clearBatchModeOnRouteChange = false,
	}: SortableCardsGridProps) => {
		const scrollRef = useRef<HTMLDivElement | null>(null);
		const [scrollContainer, setScrollContainer] = useState<HTMLElement | null>(
			null,
		);
		const [viewportReady, setViewportReady] = useState(false);
		const [thumbnailWidth, setThumbnailWidth] = useState(256);
		const restoringScrollRef = useRef(Boolean(scrollRestoreKey));
		useLibraryScrollDiagnostics(scrollRef, pageScroll);
		const scrollFrameRef = useRef<number | null>(null);
		const scrollIdleTimerRef = useRef<number | null>(null);
		const pendingScrollTopRef = useRef(0);
		const [dragOverlaySize, setDragOverlaySize] = useState<{
			width: number;
			height: number;
		} | null>(null);
		const {
			ids,
			activeId,
			sensors,
			handleDragStart,
			handleDragCancel,
			handleDragEnd,
		} = useDragSort({
			gameIds,
			onReorder,
			enabled: dragSortEnabled,
		});
		const { controls, getCardProps, showBatchControls } = useCardsController({
			gameIds: ids,
			categoryId,
			enableBatchMode,
			enableSortFieldOverlay,
			collectionContext,
			accessory,
			scrollRestoreKey,
			pageScroll,
			clearBatchModeOnRouteChange,
		});
		const idsSignature = getMotionSignature(ids);
		const flipRef = useFlipMotion<HTMLDivElement>(idsSignature, {
			disabled: activeId !== null || ids.length > 160,
			visibleOnly: true,
			viewportMargin: 320,
			maxElements: 48,
			maxAnimatedElements: 20,
			duration: 0.3,
		});
		const isDragSortEnabled = dragSortEnabled && !showBatchControls;
		const isDragging = activeId !== null;
		const getScrollContainer = useCallback(
			() =>
				pageScroll
					? (scrollRef.current?.closest<HTMLElement>(".skerry-main") ??
						scrollRef.current)
					: scrollRef.current,
			[pageScroll],
		);
		useLayoutEffect(() => {
			setScrollContainer(getScrollContainer());
			const region = scrollRef.current;
			if (!region) return;
			const updateSize = () => {
				// These match the grid's 176px minimum, 20px gap and card padding.
				const columns = Math.max(
					1,
					Math.floor((region.clientWidth + 20) / 196),
				);
				const coverWidth =
					(region.clientWidth - (columns - 1) * 20) / columns - 16;
				const pixels = coverWidth * window.devicePixelRatio;
				setThumbnailWidth(
					[256, 384, 512, 768].find((width) => width >= pixels) ?? 768,
				);
			};
			updateSize();
			const observer = new ResizeObserver(updateSize);
			observer.observe(region);
			window.addEventListener("resize", updateSize);
			return () => {
				observer.disconnect();
				window.removeEventListener("resize", updateSize);
			};
		}, [getScrollContainer]);

		// biome-ignore lint/correctness/useExhaustiveDependencies: a changed controller invalidates cached interaction, batch and sorting props.
		const cardPropsCache = useMemo(
			() => new Map<number, SortableCardItemProps>(),
			[getCardProps],
		);
		const renderCard = useCallback(
			(_index: number, gameId: number) => {
				const game = displayById.get(gameId);
				if (!game) return null;
				let props = cardPropsCache.get(gameId);
				if (!props || props.game !== game) {
					props = getCardProps(game);
					cardPropsCache.set(gameId, props);
					if (cardPropsCache.size > 256) {
						const oldest = cardPropsCache.keys().next().value;
						if (oldest !== undefined) cardPropsCache.delete(oldest);
					}
				}
				return isDragSortEnabled ? (
					<SortableCardItem
						{...props}
						imageLoading="eager"
						thumbnailWidth={thumbnailWidth}
					/>
				) : (
					<CardItem
						{...props}
						imageLoading="eager"
						thumbnailWidth={thumbnailWidth}
						disableImageReveal
					/>
				);
			},
			[
				cardPropsCache,
				displayById,
				getCardProps,
				isDragSortEnabled,
				thumbnailWidth,
			],
		);

		const warmRange = useCallback(
			({ startIndex, endIndex }: ListRange) => {
				const replaceNsfw = useStore.getState().nsfwCoverReplace;
				const sources: string[] = [];
				// Retain the rendered range plus neighbouring rows, never the whole library.
				for (
					let index = Math.max(0, startIndex - 16);
					index <= Math.min(ids.length - 1, endIndex + 16);
					index++
				) {
					const game = displayById.get(ids[index]);
					if (!game) continue;
					sources.push(
						replaceNsfw && getGameNsfwStatus(game)
							? "/images/NR18.png"
							: getGameCardCover(game, thumbnailWidth),
					);
				}
				warmCardCovers(sources);
			},
			[displayById, ids, thumbnailWidth],
		);
		const captureDragOverlaySize = useCallback((activeGameId: number) => {
			const card = scrollRef.current?.querySelector<HTMLElement>(
				`[data-game-card-id="${activeGameId}"]`,
			);
			const rect = card?.getBoundingClientRect();
			if (!rect || rect.width <= 0 || rect.height <= 0) {
				setDragOverlaySize(null);
				return;
			}

			setDragOverlaySize({ width: rect.width, height: rect.height });
		}, []);
		const handleGridDragStart = useCallback(
			(event: DragStartEvent) => {
				captureDragOverlaySize(event.active.id as number);
				handleDragStart(event);
			},
			[captureDragOverlaySize, handleDragStart],
		);
		const handleGridDragCancel = useCallback(() => {
			setDragOverlaySize(null);
			handleDragCancel();
		}, [handleDragCancel]);
		const handleGridDragEnd = useCallback(
			(event: DragEndEvent) => {
				setDragOverlaySize(null);
				handleDragEnd(event);
			},
			[handleDragEnd],
		);

		useLayoutEffect(() => {
			if (!scrollRestoreKey) return;
			restoringScrollRef.current = true;
			const container = getScrollContainer();
			if (!container) return;
			if (idsSignature.length === 0) {
				container.scrollTop = 0;
				restoringScrollRef.current = false;
				return;
			}
			if (!viewportReady) return;

			let frameId = 0;
			let cancelled = false;
			let attempts = 0;
			const restore = () => {
				if (cancelled) return;
				const target = getScrollPosition(scrollRestoreKey);
				const maxScroll = Math.max(
					0,
					container.scrollHeight - container.clientHeight,
				);
				const desiredScrollTop = Math.min(target, maxScroll);
				container.scrollTop = desiredScrollTop;
				pendingScrollTopRef.current = container.scrollTop;

				attempts++;
				if (
					attempts < 8 &&
					(attempts < 2 || Math.abs(container.scrollTop - target) > 1)
				) {
					frameId = window.requestAnimationFrame(restore);
				} else {
					restoringScrollRef.current = false;
				}
			};

			frameId = window.requestAnimationFrame(restore);
			return () => {
				cancelled = true;
				window.cancelAnimationFrame(frameId);
			};
		}, [getScrollContainer, idsSignature, scrollRestoreKey, viewportReady]);

		const handleScroll = useCallback(() => {
			const container = getScrollContainer();
			if (!container) return;
			const scrollingTarget = pageScroll ? container : scrollRef.current;
			const scrollingClass = pageScroll ? "is-page-scrolling" : "is-scrolling";
			scrollingTarget?.classList.add(scrollingClass);
			if (scrollIdleTimerRef.current !== null) {
				window.clearTimeout(scrollIdleTimerRef.current);
			}
			scrollIdleTimerRef.current = window.setTimeout(() => {
				scrollIdleTimerRef.current = null;
				scrollingTarget?.classList.remove(scrollingClass);
			}, 140);

			if (!scrollRestoreKey || restoringScrollRef.current) return;
			pendingScrollTopRef.current = container.scrollTop;
			if (scrollFrameRef.current !== null) return;
			scrollFrameRef.current = window.requestAnimationFrame(() => {
				scrollFrameRef.current = null;
				setScrollPosition(scrollRestoreKey, pendingScrollTopRef.current);
			});
		}, [getScrollContainer, pageScroll, scrollRestoreKey]);

		useLayoutEffect(() => {
			const container = getScrollContainer();
			if (!container) return;
			container.addEventListener("scroll", handleScroll, { passive: true });
			return () => {
				container.removeEventListener("scroll", handleScroll);
				container.classList.remove("is-page-scrolling");
				scrollRef.current?.classList.remove("is-scrolling");
			};
		}, [getScrollContainer, handleScroll]);

		useLayoutEffect(() => {
			return () => {
				if (scrollIdleTimerRef.current !== null) {
					window.clearTimeout(scrollIdleTimerRef.current);
					scrollIdleTimerRef.current = null;
				}
				scrollRef.current?.classList.remove("is-scrolling");
				if (scrollFrameRef.current !== null) {
					window.cancelAnimationFrame(scrollFrameRef.current);
					scrollFrameRef.current = null;
				}
				if (scrollRestoreKey) {
					setScrollPosition(
						scrollRestoreKey,
						getScrollContainer()?.scrollTop ?? pendingScrollTopRef.current,
					);
				}
			};
		}, [getScrollContainer, scrollRestoreKey]);

		return (
			<DndContext
				sensors={sensors}
				collisionDetection={closestCenter}
				measuring={{
					droppable: {
						strategy: MeasuringStrategy.WhileDragging,
						frequency: MeasuringFrequency.Optimized,
					},
				}}
				onDragStart={isDragSortEnabled ? handleGridDragStart : undefined}
				onDragCancel={handleGridDragCancel}
				onDragEnd={isDragSortEnabled ? handleGridDragEnd : undefined}
			>
				<SortableContext items={ids} strategy={rectSortingStrategy}>
					{controls}
					<div
						ref={scrollRef}
						className={
							"cards-scroll-region flex-1 min-h-0" +
							(isDragging ? " is-dragging" : "")
						}
						data-scroll-restore-key={scrollRestoreKey}
					>
						{scrollContainer && (
							<CardsViewport
								gameIds={ids}
								scrollContainer={scrollContainer}
								gridRef={flipRef}
								renderCard={renderCard}
								onRangeChanged={warmRange}
								onReady={setViewportReady}
							/>
						)}
					</div>
				</SortableContext>
				{createPortal(
					<DragOverlay adjustScale={false}>
						{activeId &&
							(() => {
								const activeGame = displayById.get(activeId);
								if (!activeGame) return null;
								return (
									<div
										style={
											dragOverlaySize
												? {
														width: dragOverlaySize.width,
														height: dragOverlaySize.height,
													}
												: undefined
										}
									>
										<CardItem
											{...getCardProps(activeGame)}
											batch={undefined}
											removeAction={undefined}
											dragHandleProps={undefined}
											imageLoading="eager"
											thumbnailWidth={thumbnailWidth}
											isOverlay
											disableWarmup
											disableTooltips
											disableImageReveal
										/>
									</div>
								);
							})()}
					</DragOverlay>,
					document.body,
				)}
			</DndContext>
		);
	},
);

SortableCardsGrid.displayName = "SortableCardsGrid";
