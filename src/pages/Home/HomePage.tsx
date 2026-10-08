import { HomeQuoteBar } from "./HomeQuoteBar";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import ArrowForwardRoundedIcon from "@mui/icons-material/ArrowForwardRounded";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import ShuffleRoundedIcon from "@mui/icons-material/ShuffleRounded";
import StopRoundedIcon from "@mui/icons-material/StopRounded";
import {
	Box,
	Button,
	IconButton,
	MenuItem,
	Skeleton,
	Select,
	Stack,
	Tooltip,
	ToggleButton,
	ToggleButtonGroup,
	Typography,
} from "@mui/material";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { RevealImage } from "@/components/motion/RevealImage";
import gsap from "gsap";
import { useGameLaunchFlow } from "@/hooks/features/games/useGameLaunchFlow";
import { useGameIndex } from "@/hooks/features/games/useGameListFacade";
import {
	statsKeys,
	useAllGameLastPlayedMap,
	useGameStats,
	usePlayTimeSummary,
} from "@/hooks/queries/useStats";
import { snackbar } from "@/providers/snackBar";
import { navigateSkerry } from "@/providers/navigationBridge";
import { statsService } from "@/services/invoke";
import { useStore } from "@/store/appStore";
import { useGamePlayStore } from "@/store/gamePlayStore";
import type { GameData } from "@/types";
import { getUserErrorMessage } from "@/utils/errors";
import {
	applyNsfwFilter,
	getGameDisplayName,
} from "@/utils/game";
import { formatPlayTime, formatRelativeTime } from "@/utils/dateTime";
import {
	ACTIVITY_PAGE_SIZE,
	type ActivityFilter,
	type ActivityGroup,
	buildActivities,
	buildMonthlyPlayGrid,
	EMPTY_LAST_PLAYED,
	getFocusGame,
	getVisibleGameCover,
	getWeekPlayTime,
	HOME_LAST_FOCUS_GAME_KEY,
	loadHomeFocusGameSnapshot,
	pickRandomGame,
	RANDOM_GAME_SESSION_KEY,
	saveHomeFocusGameSnapshot,
} from "./homeData";
import { RunningGameTimer } from "./RunningGameTimer";
import { HomePlanList } from "./HomePlanList";
import { HomeActivityTimeline } from "./HomeActivityTimeline";
import {
	formatCompactPlayTime,
	GameImage,
	SectionHeading,
} from "./HomeSharedComponents";

function GameCoverImage({
	game,
	replaceNsfwCover,
	className,
	onLoad,
}: {
	game: GameData;
	replaceNsfwCover: boolean;
	className?: string;
	onLoad?: React.ReactEventHandler<HTMLImageElement>;
}) {
	return (
		<RevealImage
			src={getVisibleGameCover(game, replaceNsfwCover)}
			alt=""
			className={className}
			onLoad={onLoad}
		/>
	);
}

const monthSelectMenuProps = {
	PaperProps: {
		className: "atlas-month-select-paper",
		sx: {
			p: "5px",
			borderRadius: "12px",
			boxShadow: "0 8px 24px rgba(0, 0, 0, 0.16)",
			"& .MuiList-root": {
				p: 0,
				display: "flex",
				flexDirection: "column",
				gap: "4px",
			},
			"& .MuiMenuItem-root": {
				m: "0 !important",
				minHeight: "32px !important",
				borderRadius: "8px !important",
				justifyContent: "center",
				textAlign: "center",
				px: 1.25,
				py: 0.5,
				fontSize: "12px",
				fontWeight: 700,
			},
		},
	},
};

function RandomGameArtwork({
	game,
	replaceNsfwCover,
	onOpen,
}: {
	game: GameData;
	replaceNsfwCover: boolean;
	onOpen: () => void;
}) {
	return (
		<Box
			className="atlas-random-art"
			onClick={onOpen}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					onOpen();
				}
			}}
			role="button"
			tabIndex={0}
		>
			<GameCoverImage
				key={game.id}
				game={game}
				replaceNsfwCover={replaceNsfwCover}
			/>
		</Box>
	);
}

export const Home: React.FC = () => {
	const { t } = useTranslation();
	const { index, isLoading: gamesLoading } = useGameIndex();
	const { launchGame } = useGameLaunchFlow();
	const store = useStore(
		useShallow((state) => ({
			nsfwFilter: state.nsfwFilter,
			nsfwCoverReplace: state.nsfwCoverReplace,
			openAddModal: state.openAddModal,
			nextUpGameIds: state.nextUpGameIds,
			nextUpVirtualGames: state.nextUpVirtualGames,
			addNextUpVirtualGame: state.addNextUpVirtualGame,
			removeNextUpGame: state.removeNextUpGame,
		})),
	);
	const { runningGameIds, gameRealTimeStates, stopGame } = useGamePlayStore(
		useShallow((state) => ({
			runningGameIds: state.runningGameIds,
			gameRealTimeStates: state.gameRealTimeStates,
			stopGame: state.stopGame,
		})),
	);
	const {
		totalPlayTime,
		weekPlayTime,
		monthPlayTime,
		todayPlayTime,
		dailyPlayTime,
		isLoading: statsLoading,
	} = usePlayTimeSummary();
	const currentDate = useMemo(() => new Date(), []);
	const [selectedYear, setSelectedYear] = useState(currentDate.getFullYear());
	const [selectedMonth, setSelectedMonth] = useState(
		currentDate.getMonth() + 1,
	);
	const monthlyPlayGrid = useMemo(
		() =>
			buildMonthlyPlayGrid(
				dailyPlayTime,
				new Date(selectedYear, selectedMonth - 1, 1),
			),
		[dailyPlayTime, selectedMonth, selectedYear],
	);
	const availableYears = useMemo(() => {
		const years = new Set<number>([currentDate.getFullYear()]);
		for (const date of Object.keys(dailyPlayTime)) {
			const year = Number(date.slice(0, 4));
			if (Number.isInteger(year)) years.add(year);
		}
		const minYear = Math.min(...years);
		return Array.from(
			{ length: currentDate.getFullYear() - minYear + 1 },
			(_, index) => minYear + index,
		).reverse();
	}, [currentDate, dailyPlayTime]);
	const visibleGames = useMemo(
		() => applyNsfwFilter(index.displayList, store.nsfwFilter),
		[index.displayList, store.nsfwFilter],
	);
	const gameIds = useMemo(
		() => visibleGames.map((game) => game.id),
		[visibleGames],
	);
	const lastPlayedQuery = useAllGameLastPlayedMap({
		enabled: visibleGames.length > 0,
	});
	const lastPlayedMap = lastPlayedQuery.data ?? EMPTY_LAST_PLAYED;
	useEffect(() => {
		const hero = document.querySelector(".atlas-current");
		if (hero) {
			gsap.fromTo(
				hero,
				{ autoAlpha: 0.88, y: 5 },
				{
					autoAlpha: 1,
					y: 0,
					duration: 0.26,
					ease: "power2.out",
					clearProps: "transform,opacity,visibility",
				},
			);
		}
	}, []);

	const [cachedFocusId, setCachedFocusId] = useState<number | null>(() => {
		if (typeof window === "undefined") return null;
		try {
			const stored = Number.parseInt(
				window.localStorage.getItem(HOME_LAST_FOCUS_GAME_KEY) ?? "",
				10,
			);
			return Number.isFinite(stored) ? stored : null;
		} catch {
			return null;
		}
	});
	const [cachedFocusGame, setCachedFocusGame] = useState<GameData | null>(() => {
		return loadHomeFocusGameSnapshot();
	});
	const focusGame = useMemo(
		() =>
			getFocusGame(
				visibleGames,
				lastPlayedMap,
				runningGameIds,
				cachedFocusId,
				cachedFocusGame,
			),
		[cachedFocusGame, cachedFocusId, lastPlayedMap, runningGameIds, visibleGames],
	);
	useEffect(() => {
		if (focusGame?.id) {
			setCachedFocusId(focusGame.id);
			setCachedFocusGame(focusGame);
			saveHomeFocusGameSnapshot(focusGame);
			try {
				window.localStorage.setItem(
					HOME_LAST_FOCUS_GAME_KEY,
					String(focusGame.id),
				);
			} catch {}
		}
	}, [focusGame]);
	const focusStats = useGameStats(focusGame?.id ?? null);
	const activitiesQuery = useInfiniteQuery({
		queryKey: [...statsKeys.all, "atlasTrace", gameIds],
		queryFn: ({ pageParam }) =>
			statsService.getRecentSessionsForAll(
				gameIds,
				ACTIVITY_PAGE_SIZE,
				pageParam,
			),
		initialPageParam: 0,
		getNextPageParam: (last, pages) =>
			last.length < ACTIVITY_PAGE_SIZE
				? undefined
				: pages.length * ACTIVITY_PAGE_SIZE,
		enabled: gameIds.length > 0,
	});
	const activities = useMemo(
		() =>
			buildActivities(
				visibleGames,
				activitiesQuery.data?.pages.flat() ?? [],
				store.nsfwCoverReplace,
			),
		[activitiesQuery.data, store.nsfwCoverReplace, visibleGames],
	);
	const previousPlayed = useMemo(() => {
		const previousGame = visibleGames
			.filter((game) => game.id !== focusGame?.id && lastPlayedMap.has(game.id))
			.toSorted(
				(a, b) =>
					(lastPlayedMap.get(b.id) ?? 0) - (lastPlayedMap.get(a.id) ?? 0),
			)[0];
		if (!previousGame) return null;
		const time = lastPlayedMap.get(previousGame.id);
		return time ? { game: previousGame, time } : null;
	}, [focusGame?.id, lastPlayedMap, visibleGames]);
	const previousPlayedGame = previousPlayed?.game ?? null;
	const previousPlayedTime = previousPlayed?.time ?? null;
	const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
	const groups = useMemo(() => {
		const filtered =
			activityFilter === "all"
				? activities
				: activities.filter((item) => item.type === activityFilter);
		const result: ActivityGroup[] = [];
		for (const item of filtered) {
			const previous = result.at(-1);
			if (previous?.date === item.date) previous.items.push(item);
			else result.push({ date: item.date, items: [item] });
		}
		return result;
	}, [activities, activityFilter]);
	const [randomId, setRandomId] = useState<number | null>(() => {
		if (typeof window === "undefined") return null;
		const stored = Number.parseInt(
			window.sessionStorage.getItem(RANDOM_GAME_SESSION_KEY) ?? "",
			10,
		);
		return Number.isFinite(stored) ? stored : null;
	});
	const randomGame = useMemo(
		() => visibleGames.find((game) => game.id === randomId) ?? null,
		[randomId, visibleGames],
	);
	useEffect(() => {
		if (visibleGames.length === 0 || randomGame) return;
		const game = pickRandomGame(visibleGames);
		if (!game) return;
		setRandomId(game.id);
		window.sessionStorage.setItem(RANDOM_GAME_SESSION_KEY, String(game.id));
	}, [randomGame, visibleGames]);
	const nextGames = useMemo(() => {
		const map = new Map(visibleGames.map((game) => [game.id, game]));
		return store.nextUpGameIds.flatMap((id) =>
			map.has(id) ? [map.get(id)!] : [],
		);
	}, [store.nextUpGameIds, visibleGames]);
	const [period, setPeriod] = useState<"week" | "month">("week");
	const [stopping, setStopping] = useState(false);
	const focusRealTimeState = focusGame
		? gameRealTimeStates[focusGame.id]
		: undefined;
	const shuffle = useCallback(() => {
		const game = pickRandomGame(visibleGames, randomId ?? undefined);
		if (!game) return;
		setRandomId(game.id);
		window.sessionStorage.setItem(RANDOM_GAME_SESSION_KEY, String(game.id));
	}, [randomId, visibleGames]);
	const stop = useCallback(async () => {
		if (!focusGame) return;
		setStopping(true);
		try {
			const result = await stopGame(focusGame.id);
			if (!result.success) snackbar.error(result.message);
		} catch (error) {
			snackbar.error(getUserErrorMessage(error, t));
		} finally {
			setStopping(false);
		}
	}, [focusGame, stopGame, t]);
	const plannedCount = nextGames.length + store.nextUpVirtualGames.length;
	const periodPlayTime = period === "week" ? weekPlayTime : monthPlayTime;

	return (
		<Box className="atlas-page">
			<HomeQuoteBar onNavigateToLibrary={() => navigateSkerry("/libraries")} />
			<Box className="atlas-body">
				<section className={`atlas-current${focusGame ? "" : " atlas-current-empty"}`}>
					<Box className="atlas-current-copy">
						{focusGame ? (
							<>
								<Typography className="atlas-current-kicker">
									{runningGameIds.has(focusGame.id) ? "正在记录" : "最近游玩"}
								</Typography>
								<Typography className="atlas-current-name">
									{getGameDisplayName(focusGame)}
								</Typography>
								<Typography className="atlas-current-meta">
									{focusStats.data
										? `本周 ${formatPlayTime(getWeekPlayTime(focusStats.data.daily_stats))} · 总计 ${formatPlayTime(focusStats.data.totalMinutes ?? 0)}`
										: "准备好开始下一段记录"}
								</Typography>
								<Stack direction="row" spacing={1} sx={{ mt: 3 }}>
									{runningGameIds.has(focusGame.id) ? (
										<Button
											className="skerry-launch-action-button skerry-launch-running atlas-launch-main-button atlas-launch-recording-button atlas-hero-launch-btn"
											variant="contained"
											color="error"
											startIcon={<StopRoundedIcon />}
											onClick={() => void stop()}
											disabled={stopping}
											aria-label="停止记录"
											title="停止记录"
										>
											{focusRealTimeState ? (
												<span className="atlas-launch-recording-timer">
													<RunningGameTimer {...focusRealTimeState} compact />
												</span>
											) : null}
										</Button>
									) : (
										<Button
											className="skerry-launch-action-button skerry-launch-start atlas-launch-main-button atlas-hero-launch-btn"
											variant="contained"
											startIcon={<PlayArrowRoundedIcon />}
											onClick={() => void launchGame(focusGame)}
										>
											开始游戏
										</Button>
									)}
									<IconButton
										className="atlas-detail-icon-button"
										aria-label="查看详情"
										onClick={() => navigateSkerry("/libraries/" + focusGame.id)}
									>
										<InfoOutlinedIcon fontSize="small" />
									</IconButton>
								</Stack>
							</>
						) : gamesLoading ? (
							<Box className="atlas-current-loading-shimmer" sx={{ pt: 1 }}>
								<Typography className="atlas-current-kicker" sx={{ opacity: 0.6 }}>
									SKERRY
								</Typography>
								<Typography className="atlas-current-name" sx={{ opacity: 0.7, my: 0.5 }}>
									正在载入游玩空间...
								</Typography>
								<Typography className="atlas-current-meta" sx={{ opacity: 0.5 }}>
									即将呈现最近的冒险记录
								</Typography>
							</Box>
						) : (
							<>
								<Typography className="atlas-current-name">
									还没有主线。
								</Typography>
								<Typography className="atlas-current-meta">
									把第一款游戏加入库，建立你的游玩地图。
								</Typography>
								<Button
									variant="contained"
									startIcon={<AddRoundedIcon />}
									onClick={() => store.openAddModal("")}
									sx={{ mt: 3 }}
								>
									加入第一款游戏
								</Button>
							</>
						)}
					</Box>
					<Box className="atlas-current-art">
						{focusGame ? (
							<GameImage
								game={focusGame}
								replaceNsfwCover={store.nsfwCoverReplace}
								preferBanner
								focusBanner
								loading="eager"
							/>
						) : gamesLoading ? (
							<Box className="atlas-art-loading-shimmer" sx={{ width: "100%", height: "100%", background: "radial-gradient(circle at 75% 35%, rgba(47, 125, 246, 0.16), transparent 60%), #071321" }} />
						) : (
							<Box className="atlas-art-placeholder">
								<Typography>SKERRY</Typography>
							</Box>
						)}
						<Box className="atlas-art-caption">
							<span>{runningGameIds.size ? "LIVE" : "IDLE"}</span>
						</Box>
					</Box>
					{previousPlayedGame ? (
						<Box
							className="atlas-previous-game"
							onClick={() =>
								navigateSkerry("/libraries/" + previousPlayedGame.id)
							}
							role="button"
							tabIndex={0}
							onKeyDown={(event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									navigateSkerry("/libraries/" + previousPlayedGame.id);
								}
							}}
						>
							<Box className="atlas-previous-divider" />
							<Box className="atlas-previous-inner">
								<Box className="atlas-previous-media">
									<GameImage
										game={previousPlayedGame}
										replaceNsfwCover={store.nsfwCoverReplace}
										preferBanner
									/>
								</Box>
								<Box sx={{ minWidth: 0, flex: 1 }}>
									<Typography className="atlas-previous-name" noWrap>
										{getGameDisplayName(previousPlayedGame)}
									</Typography>
									<Typography className="atlas-previous-time" noWrap>
										{previousPlayedTime
											? formatRelativeTime(previousPlayedTime)
											: ""}
									</Typography>
								</Box>
							</Box>
						</Box>
					) : null}
				</section>
				<aside className="atlas-inspector">
					<Box className="atlas-side-card atlas-month-grid-card">
						<Box className="atlas-month-grid-header">
							<Box>
								<Typography className="atlas-code">MONTH GRID</Typography>
								<Typography className="atlas-month-grid-title">
									本月点亮
								</Typography>
							</Box>
							<Box className="atlas-month-picker">
								<Select
									size="small"
									value={selectedYear}
									onChange={(event) =>
										setSelectedYear(Number(event.target.value))
									}
									className="atlas-month-year-select"
									MenuProps={monthSelectMenuProps}
								>
									{availableYears.map((year) => (
										<MenuItem key={year} value={year}>
											{year}
										</MenuItem>
									))}
								</Select>
								<Select
									size="small"
									value={selectedMonth}
									onChange={(event) =>
										setSelectedMonth(Number(event.target.value))
									}
									className="atlas-month-month-select"
									MenuProps={monthSelectMenuProps}
								>
									{Array.from({ length: 12 }, (_, index) => index + 1).map(
										(month) => (
											<MenuItem
												key={month}
												value={month}
												disabled={
													selectedYear === currentDate.getFullYear() &&
													month > currentDate.getMonth() + 1
												}
											>
												{month} 月
											</MenuItem>
										),
									)}
								</Select>
							</Box>
						</Box>
						<Box className="atlas-month-grid">
							{monthlyPlayGrid.map((cell) => (
								<Tooltip
									key={cell.date}
									title={`${cell.date} · ${formatCompactPlayTime(cell.minutes)}`}
									placement="top"
									arrow
									enterDelay={0}
								>
									<Box
										className={`atlas-month-cell is-${cell.level}`}
										aria-label={`${cell.date} · ${formatCompactPlayTime(cell.minutes)}`}
									/>
								</Tooltip>
							))}
						</Box>
					</Box>
					<Box className="atlas-side-card atlas-combined-info">
						<Box className="atlas-inspector-block">
							<Typography className="atlas-code">LIBRARY SIGNAL</Typography>
							<Typography className="atlas-big-number">
								{gamesLoading ? <Skeleton width={90} /> : visibleGames.length}
							</Typography>
							<Typography variant="caption">款游戏已在库中</Typography>
						</Box>
						<Box className="atlas-inspector-grid">
							<Box>
								<Typography
									className="atlas-inspector-stat-label"
									variant="caption"
								>
									总时长
								</Typography>
								<Typography className="atlas-inspector-stat-value">
									{statsLoading ? "…" : formatCompactPlayTime(totalPlayTime)}
								</Typography>
							</Box>
							<Box>
								<Typography
									className="atlas-inspector-stat-label"
									variant="caption"
								>
									今日
								</Typography>
								<Typography className="atlas-inspector-stat-value">
									{statsLoading ? "…" : formatCompactPlayTime(todayPlayTime)}
								</Typography>
							</Box>
							<Box>
								<Typography
									className="atlas-inspector-stat-label"
									variant="caption"
								>
									计划
								</Typography>
								<Typography className="atlas-inspector-stat-value">
									{plannedCount}
								</Typography>
							</Box>
						</Box>
						<Box className="atlas-period-card">
							<Box>
								<Typography className="atlas-period-kicker">
									PLAY TIME
								</Typography>
								<Typography className="atlas-period-value">
									{statsLoading ? "…" : formatCompactPlayTime(periodPlayTime)}
								</Typography>
							</Box>
							<ToggleButtonGroup
								className="atlas-period"
								exclusive
								size="small"
								value={period}
								aria-label="游玩时长周期"
								onChange={(_, value: "week" | "month" | null) => {
									if (value) setPeriod(value);
								}}
							>
								<ToggleButton value="week" aria-label="本周">
									周
								</ToggleButton>
								<ToggleButton value="month" aria-label="本月">
									月
								</ToggleButton>
							</ToggleButtonGroup>
						</Box>
					</Box>
					<Box className="atlas-side-card atlas-random">
						<Box className="atlas-section-bar">
							<SectionHeading code="RANDOMIZER" title="随机游戏" />
							<IconButton aria-label="换一个" onClick={shuffle}>
								<ShuffleRoundedIcon />
							</IconButton>
						</Box>
						{randomGame ? (
							<>
								<Box className="atlas-random-media">
									<RandomGameArtwork key={randomGame.id} game={randomGame}
										replaceNsfwCover={store.nsfwCoverReplace}
										onOpen={() => navigateSkerry("/libraries/" + randomGame.id)}
									/>
								</Box>
								<Box className="atlas-random-actions">
									<Typography className="atlas-random-name" key={randomGame.id}>
										{getGameDisplayName(randomGame)}
									</Typography>
									<Button
										className="atlas-random-launch"
										variant="contained"
										size="small"
										endIcon={<ArrowForwardRoundedIcon />}
										onClick={() => void launchGame(randomGame)}
									>
										启动
									</Button>
								</Box>
							</>
						) : (
							<Typography variant="caption">
								库里还没有可随机的游戏。
							</Typography>
						)}
					</Box>
				</aside>
			</Box>
			<Box className="atlas-lower">
				<HomePlanList
					games={nextGames}
					virtualGames={store.nextUpVirtualGames}
					onImport={store.addNextUpVirtualGame}
					onRemove={store.removeNextUpGame}
					gamesLoading={gamesLoading}
				/>
				<HomeActivityTimeline
					groups={groups}
					filter={activityFilter}
					onFilter={setActivityFilter}
					onEndReached={() => {
						if (activitiesQuery.hasNextPage)
							void activitiesQuery.fetchNextPage();
					}}
					hasMore={activitiesQuery.hasNextPage}
					isFetchingMore={activitiesQuery.isFetchingNextPage}
					isLoading={activitiesQuery.isLoading}
				/>
			</Box>
		</Box>
	);
};
