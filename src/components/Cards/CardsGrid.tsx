import { memo, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import {
	getScrollPosition,
	setScrollPosition,
} from "@/hooks/common/useScrollRestore";
import type { GameData } from "@/types";
import { CardItem } from "./CardItem";
import { useCardsController } from "./useCardsController";

interface CardsGridProps {
	gameIds: number[];
	displayById: Map<number, GameData>;
	categoryId?: number;
	enableBatchMode?: boolean;
	enableSortFieldOverlay?: boolean;
	accessory?: ReactNode;
	scrollRestoreKey?: string;
}

/**
 * CardsGrid - 普通卡片布局。
 *
 * 接收 ID 数组和展示索引，渲染时按 ID 取 GameData。
 */
export const CardsGrid = memo(
	({
		gameIds,
		displayById,
		categoryId,
		enableBatchMode = false,
		enableSortFieldOverlay = false,
		accessory,
		scrollRestoreKey,
	}: CardsGridProps) => {
		const scrollRef = useRef<HTMLDivElement | null>(null);
		const scrollFrameRef = useRef<number | null>(null);
		const scrollIdleTimerRef = useRef<number | null>(null);
		const pendingScrollTopRef = useRef(0);
		const { controls, getCardProps } = useCardsController({
			gameIds,
			categoryId,
			enableBatchMode,
			enableSortFieldOverlay,
			accessory,
			scrollRestoreKey,
		});

		useLayoutEffect(() => {
			if (!scrollRestoreKey) return;
			const container = scrollRef.current;
			if (!container) return;

			let frameId = window.requestAnimationFrame(() => {
				const target = getScrollPosition(scrollRestoreKey);
				const maxScroll = Math.max(
					0,
					container.scrollHeight - container.clientHeight,
				);
				container.scrollTop = Math.min(target, maxScroll);
				pendingScrollTopRef.current = container.scrollTop;
			});

			return () => {
				window.cancelAnimationFrame(frameId);
			};
		}, [gameIds.length, scrollRestoreKey]);

		const handleScroll = useCallback(() => {
			const container = scrollRef.current;
			if (!container) return;
			container.classList.add("is-scrolling");
			if (scrollIdleTimerRef.current !== null) {
				window.clearTimeout(scrollIdleTimerRef.current);
			}
			scrollIdleTimerRef.current = window.setTimeout(() => {
				scrollIdleTimerRef.current = null;
				container.classList.remove("is-scrolling");
			}, 180);

			if (!scrollRestoreKey) return;
			pendingScrollTopRef.current = container.scrollTop;
			if (scrollFrameRef.current !== null) return;
			scrollFrameRef.current = window.requestAnimationFrame(() => {
				scrollFrameRef.current = null;
				setScrollPosition(scrollRestoreKey, pendingScrollTopRef.current);
			});
		}, [scrollRestoreKey]);

		useEffect(() => {
			const container = scrollRef.current;
			if (!container) return;
			container.addEventListener("scroll", handleScroll, { passive: true });
			return () => {
				container.removeEventListener("scroll", handleScroll);
				if (scrollIdleTimerRef.current !== null) {
					window.clearTimeout(scrollIdleTimerRef.current);
					scrollIdleTimerRef.current = null;
				}
				container.classList.remove("is-scrolling");
				if (scrollFrameRef.current !== null) {
					window.cancelAnimationFrame(scrollFrameRef.current);
					scrollFrameRef.current = null;
				}
				if (scrollRestoreKey) {
					setScrollPosition(scrollRestoreKey, container.scrollTop);
				}
			};
		}, [handleScroll, scrollRestoreKey]);

		return (
			<>
				{controls}
				<div
					ref={scrollRef}
					className="cards-scroll-region static-cards-scroll-region flex-1 min-h-0"
					data-scroll-restore-key={scrollRestoreKey}
				>
					<div
						className="sortable-cards-grid grid grid-cols-[repeat(auto-fill,minmax(176px,1fr))] gap-x-5 gap-y-7 pb-5"
					>
						{gameIds.map((gameId, index) => {
							const game = displayById.get(gameId);
							if (!game) return null;
							const props = getCardProps(game);
							return (
									<CardItem
										key={gameId}
										{...props}
										imageLoading={index < 18 ? "eager" : "lazy"}
										disableImageReveal={index >= 18}
									/>
							);
						})}
					</div>
				</div>
			</>
		);
	},
);

CardsGrid.displayName = "CardsGrid";
