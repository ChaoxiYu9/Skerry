import CheckIcon from "@mui/icons-material/Check";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { forwardRef, memo, useCallback, useEffect, useRef } from "react";
import { warmupGameDetailCaches } from "@/providers/gameDetailWarmup";
import { preloadDetailPage } from "@/providers/routePreloads";
import { wasRecentlyResumed } from "@/providers/webviewKeepAlive";
import { useStore } from "@/store/appStore";
import { getGameCover, getGameNsfwStatus } from "@/utils/game";

/*
const PLAY_STATUS_CARD_MAP: Record<
	number,
	{ label: string; ribbonClass: string }
> = {
	[PlayStatus.WISH]: { label: '想玩', ribbonClass: 'skerry-card-ribbon-wish' },
	[PlayStatus.PLAYING]: { label: '在玩', ribbonClass: 'skerry-card-ribbon-playing' },
	[PlayStatus.PLAYED]: { label: '通关', ribbonClass: 'skerry-card-ribbon-played' },
	[PlayStatus.ON_HOLD]: { label: '搁置', ribbonClass: 'skerry-card-ribbon-hold' },
	[PlayStatus.DROPPED]: { label: '弃坑', ribbonClass: 'skerry-card-ribbon-dropped' },
};
*/
import type { CardItemProps } from "./types";
import { useCardInteraction } from "./useCardInteraction";

const noop = () => {};

/**
 * CardItem - 游戏卡片组件
 *
 * 由父级传入展示数据，避免卡片内部读取 React Query 缓存。
 */
export const CardItem = memo(
	forwardRef<HTMLDivElement, CardItemProps>(
		(
			{
				game,
				displayName,
				imageLoading = "lazy",
				onFocus,
				onPointerEnter,
				sortFieldOverlay,
				interaction,
				batch,
				dragHandleProps,
				isOverlay,
				disableWarmup = false,
				disableTooltips = false,
				disableImageReveal = true,
				...props
			},
			ref,
		) => {
			const rootRef = useRef<HTMLDivElement | null>(null);
			const warmupTimerRef = useRef<number | null>(null);
			const warmupIdleRef = useRef<number | null>(null);
			const nsfwCoverReplace = useStore((s) => s.nsfwCoverReplace);
			const isActive = useStore((s) => s.selectedGameId === game.id);

			const getLaunchTarget = useCallback(() => {
				const root = rootRef.current;
				return (
					root?.querySelector<HTMLElement>(
						".detail-launch-source, .game-card-cover",
					) ?? root
				);
			}, []);

			const handleInteractionClick = useCallback(() => {
				warmupGameDetailCaches(game);
				if (interaction?.onClick) {
					interaction.onClick(getLaunchTarget());
					return;
				}
				noop();
			}, [getLaunchTarget, interaction]);

			const { handlers } = useCardInteraction({
				onClick: handleInteractionClick,
				onDoubleClick: interaction?.onDoubleClick ?? noop,
				useDelayedClick: interaction?.useDelayedClick ?? false,
			});

			// statusConfig temporarily disabled
			const isNsfw = getGameNsfwStatus(game);
			const coverImage =
				nsfwCoverReplace && isNsfw ? "/images/NR18.png" : getGameCover(game);
			const cancelWarmup = useCallback(() => {
				if (warmupTimerRef.current !== null) {
					window.clearTimeout(warmupTimerRef.current);
					warmupTimerRef.current = null;
				}
				if (warmupIdleRef.current !== null) {
					if (window.cancelIdleCallback) {
						window.cancelIdleCallback(warmupIdleRef.current);
					} else {
						window.clearTimeout(warmupIdleRef.current);
					}
					warmupIdleRef.current = null;
				}
			}, []);

			const warmupDetail = useCallback(
				(delay = 120) => {
					if (disableWarmup || wasRecentlyResumed(1800)) return;
					if (
						rootRef.current?.closest(
							".cards-scroll-region.is-dragging, .cards-scroll-region.is-scrolling, .skerry-main.library-page-scroll.is-page-scrolling",
						)
					) {
						return;
					}
					preloadDetailPage();
					cancelWarmup();

					const runWarmup = () => {
						warmupTimerRef.current = null;
						const warmup = () => {
							warmupIdleRef.current = null;
							warmupGameDetailCaches(game);
						};

						if (window.requestIdleCallback) {
							warmupIdleRef.current = window.requestIdleCallback(warmup, {
								timeout: 900,
							});
							return;
						}

						warmupIdleRef.current = window.setTimeout(warmup, 120);
					};

					if (delay <= 0) {
						runWarmup();
						return;
					}

					warmupTimerRef.current = window.setTimeout(runWarmup, delay);
				},
				[cancelWarmup, disableWarmup, game],
			);

			useEffect(() => cancelWarmup, [cancelWarmup, game]);

			const setRootRef = useCallback(
				(node: HTMLDivElement | null) => {
					rootRef.current = node;
					if (typeof ref === "function") {
						ref(node);
					} else if (ref) {
						ref.current = node;
					}
				},
				[ref],
			);

			const titleNode = (
				<Typography
					variant="subtitle2"
					sx={{
						color: isActive ? "primary.main" : "text.primary",
					}}
					className="line-clamp-2 min-h-[38px] break-words text-[0.9rem] font-650 leading-[1.18rem]"
				>
					{displayName}
				</Typography>
			);

			return (
				<Box
					ref={setRootRef}
					data-game-card-id={game.id}
					className={[
						"skerry-game-card group min-w-0 max-w-full",
						isOverlay ? "is-drag-overlay" : "",
						dragHandleProps ? "cursor-grab active:cursor-grabbing" : "",
						isActive ? "is-active" : "",
						batch?.selected ? "is-selected" : "",
					]
						.filter(Boolean)
						.join(" ")}
					onContextMenu={interaction?.onContextMenu}
					onDragStart={(event) => event.preventDefault()}
					onFocus={(event) => {
						warmupDetail(0);
						onFocus?.(event);
					}}
					onPointerEnter={(event) => {
						warmupDetail();
						onPointerEnter?.(event);
					}}
					{...dragHandleProps}
					{...props}
				>
					{batch?.selected && (
						<Box
							className="pointer-events-none absolute top-3 right-3 z-10 flex items-center justify-center rounded-full shadow-lg"
							sx={{
								width: 22,
								height: 22,
								bgcolor: "primary.main",
								color: "#ffffff",
								border: "2px solid rgba(255, 255, 255, 0.9)",
							}}
						>
							<CheckIcon sx={{ fontSize: 15, strokeWidth: 2.5 }} />
						</Box>
					)}
					<Box
						role="button"
						tabIndex={0}
						onClick={handlers.onClick}
						onDoubleClick={handlers.onDoubleClick}
						onKeyDown={(event) => {
							if (event.key === "Enter" || event.key === " ") {
								event.preventDefault();
								handlers.onClick();
							}
						}}
						className="game-card-action-root !block !overflow-visible !rounded-none !bg-transparent cursor-pointer select-none outline-none"
					>
						<Box data-flip-key={game.id}>
							<Box
								className="game-card-cover aspect-[2/3] bg-[var(--mui-palette-action-hover)]"
							>
								<Box
									component="img"
									src={coverImage}
									alt={displayName}
									draggable={false}
									loading="eager"
									decoding="auto"
									onDragStart={(event) => event.preventDefault()}
									onError={(event) => {
										const image = event.currentTarget;
										if (!image.src.endsWith("/images/default.png")) {
											image.src = "/images/default.png";
										}
									}}
									className="game-card-image h-full w-full object-cover"
								/>
								{sortFieldOverlay && (
									<Box className="pointer-events-none absolute inset-x-0 bottom-0 px-2.5 pt-6 pb-1.5 text-white [background:linear-gradient(to_bottom,transparent_0%,rgba(15,23,32,0.3)_50%,rgba(15,23,32,0.85)_100%)]">
										<Typography
											variant="caption"
											className="block truncate text-left text-13px font-600 drop-shadow"
										>
											{sortFieldOverlay.value}
										</Typography>
									</Box>
								)}
							</Box>
							<Box className="game-card-meta box-border h-[70px] min-w-0 px-1 pt-2.5 text-left">
								{titleNode}
								{game.developer && (
									<Typography
										variant="caption"
										color="text.secondary"
										className="mt-1 block truncate text-xs"
									>
										{game.developer}
									</Typography>
								)}
							</Box>
						</Box>
					</Box>
				</Box>
			);
		},
	),
);

CardItem.displayName = "CardItem";
