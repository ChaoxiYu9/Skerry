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
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { useFlipMotion } from "@/components/motion/useFlipMotion";
import {
	getScrollPosition,
	setScrollPosition,
} from "@/hooks/common/useScrollRestore";
import type { GameData } from "@/types";
import { CardItem } from "./CardItem";
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
			const container = getScrollContainer();
			if (!container) return;
			if (idsSignature.length === 0) {
				container.scrollTop = 0;
				return;
			}

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
					attempts < 4 &&
					Math.abs(container.scrollTop - desiredScrollTop) > 1
				) {
					frameId = window.requestAnimationFrame(restore);
				}
			};

			frameId = window.requestAnimationFrame(restore);
			return () => {
				cancelled = true;
				window.cancelAnimationFrame(frameId);
			};
		}, [getScrollContainer, idsSignature, scrollRestoreKey]);

		// biome-ignore lint/correctness/useExhaustiveDependencies: game ID changes must restart the layout suppression window.
		useLayoutEffect(() => {
			if (!pageScroll) return;
			const container = getScrollContainer();
			if (!container) return;

			container.classList.add("is-page-scrolling");
			let frameId: number | null = null;
			let idleId: number | null = null;
			let timeoutId: number | null = null;

			const release = () => {
				frameId = window.requestAnimationFrame(() => {
					container.classList.remove("is-page-scrolling");
				});
			};

			if (window.requestIdleCallback) {
				idleId = window.requestIdleCallback(release, { timeout: 1200 });
			} else {
				timeoutId = window.setTimeout(release, 500);
			}

			return () => {
				if (idleId !== null && window.cancelIdleCallback) {
					window.cancelIdleCallback(idleId);
				}
				if (idleId === null && timeoutId !== null) {
					window.clearTimeout(timeoutId);
				}
				if (frameId !== null) {
					window.cancelAnimationFrame(frameId);
				}
				container.classList.remove("is-page-scrolling");
			};
		}, [getScrollContainer, idsSignature, pageScroll]);

		// biome-ignore lint/correctness/useExhaustiveDependencies: warm newly rendered card images after the game list changes.
		useEffect(() => {
			if (!pageScroll || !scrollRef.current) return;
			let cancelled = false;

			const warmImages = () => {
				if (cancelled) return;
				const images = Array.from(
					scrollRef.current?.querySelectorAll<HTMLImageElement>(
						".game-card-image",
					) ?? [],
				).slice(0, 32);

				for (const image of images) {
					if (image.complete && image.naturalWidth > 0) {
						void image.decode?.().catch(() => undefined);
					}
				}
			};

			if (window.requestIdleCallback) {
				const idleId = window.requestIdleCallback(warmImages, {
					timeout: 1200,
				});
				return () => {
					cancelled = true;
					window.cancelIdleCallback(idleId);
				};
			}

			const timeoutId = window.setTimeout(warmImages, 500);
			return () => {
				cancelled = true;
				window.clearTimeout(timeoutId);
			};
		}, [idsSignature, pageScroll]);

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

			if (!scrollRestoreKey) return;
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
						<div
							ref={flipRef}
							className="sortable-cards-grid grid grid-cols-[repeat(auto-fill,minmax(176px,1fr))] gap-x-5 gap-y-7 pb-0"
						>
							{ids.map((gameId, index) => {
								const game = displayById.get(gameId);
								if (!game) return null;
								const props = getCardProps(game);
								if (!isDragSortEnabled) {
									return (
										<CardItem
											key={gameId}
											{...props}
											imageLoading={index < 32 ? "eager" : "lazy"}
											disableImageReveal
										/>
									);
								}
								return (
									<SortableCardItem
										key={gameId}
										{...props}
										disabledSortable={!isDragSortEnabled}
										imageLoading={index < 32 ? "eager" : "lazy"}
									/>
								);
							})}
						</div>
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
