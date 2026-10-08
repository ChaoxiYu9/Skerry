import CheckIcon from "@mui/icons-material/Check";
import Box from "@mui/material/Box";
import { isCardsGridScrolling } from "./VirtualCardsGrid";
import Typography from "@mui/material/Typography";
import { forwardRef, memo, useCallback, useEffect, useRef } from "react";
import { warmupGameDetailCaches } from "@/providers/gameDetailWarmup";
import { preloadDetailPage } from "@/providers/routePreloads";
import { wasRecentlyResumed } from "@/providers/webviewKeepAlive";
import { useStore } from "@/store/appStore";
import { PlayStatus } from "@/types/collection";
import { getGameCover, getGameNsfwStatus } from "@/utils/game";

const PLAY_STATUS_CARD_MAP: Record<
	number,
	{ label: string; dotClass: string }
> = {
	[PlayStatus.WISH]: { label: "想玩", dotClass: "play-status-icon-wish" },
	[PlayStatus.PLAYING]: { label: "在玩", dotClass: "play-status-icon-playing" },
	[PlayStatus.PLAYED]: { label: "通关", dotClass: "play-status-icon-played" },
	[PlayStatus.ON_HOLD]: { label: "搁置", dotClass: "play-status-icon-hold" },
	[PlayStatus.DROPPED]: { label: "弃坑", dotClass: "play-status-icon-dropped" },
};
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

			const statusConfig =
				typeof game.clear === "number" ? PLAY_STATUS_CARD_MAP[game.clear] : null;
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
					if (disableWarmup || wasRecentlyResumed(1800) || isCardsGridScrolling()) return;
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
					
					className={
						[
							"skerry-game-card group relative min-w-0 max-w-full",
							isOverlay ? "is-drag-overlay" : "",
							dragHandleProps ? "cursor-grab active:cursor-grabbing" : "",
							isActive ? "is-active" : "",
							batch?.selected ? "is-selected" : "",
						]
							.filter(Boolean)
							.join(" ")
					}
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
							className="absolute top-1.5 left-1.5 z-2 h-5 w-5 flex items-center justify-center shadow-md"
							sx={{
								bgcolor: "primary.main",
								color: "primary.contrastText",
							}}
						>
							<CheckIcon className="text-18px" />
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
						sx={{
							outline: "none !important",
							"&:focus, &:focus-visible": {
								outline: "none !important",
								boxShadow: "none !important",
							},
							"&:focus-visible .game-card-cover": {
								borderColor: "primary.main",
								boxShadow: (theme) => `0 0 0 1.5px ${theme.palette.primary.main}`,
							},
						}}
					>
						<Box data-flip-key={game.id}>
							<Box
								className={`game-card-cover relative aspect-[2/3] overflow-hidden border border-solid bg-[var(--mui-palette-action-hover)] ${isOverlay ? "" : ""}`}
								sx={{
									borderColor: isActive ? "primary.main" : "divider",
									borderRadius: 1,
									boxShadow: 0,
								}}
							>
								<Box
									component="img"
									src={coverImage}
									alt={displayName}
									draggable={false}
									loading={imageLoading}
									decoding="async"
									onDragStart={(event) => event.preventDefault()}
									onLoad={(event) => {
										(event.currentTarget as HTMLElement).style.opacity = "1";
									}}
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
								{statusConfig && (
									<Box
										title={statusConfig.label}
										className="pointer-events-none absolute top-1.5 right-1.5 z-2 flex items-center justify-center rounded-full shadow-sm"
										sx={{
											width: 16,
											height: 16,
											bgcolor: "rgba(15, 23, 42, 0.88)",
											border: "1px solid rgba(255, 255, 255, 0.2)",
										}}
									>
										<Box
											component="span"
											className={statusConfig.dotClass}
											sx={{
												width: 7,
												height: 7,
												borderRadius: "50%",
												bgcolor: "currentColor",
												flexShrink: 0,
											}}
										/>
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
