import AccessTimeRoundedIcon from "@mui/icons-material/AccessTimeRounded";
import CalendarMonthRoundedIcon from "@mui/icons-material/CalendarMonthRounded";
import AddCircleOutlineRoundedIcon from "@mui/icons-material/AddCircleOutlineRounded";
import EmojiEventsRoundedIcon from "@mui/icons-material/EmojiEventsRounded";
import LocalFireDepartmentRoundedIcon from "@mui/icons-material/LocalFireDepartmentRounded";
import TrendingUpRoundedIcon from "@mui/icons-material/TrendingUpRounded";
import TimerRoundedIcon from "@mui/icons-material/TimerRounded";
import SportsEsportsRoundedIcon from "@mui/icons-material/SportsEsportsRounded";
import {
	Alert,
	Box,
	CircularProgress,
	FormControl,
	MenuItem,
	Paper,
	Select,
	Tooltip,
	Typography,
} from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { type CSSProperties, useMemo, useState, useEffect, useRef, useLayoutEffect } from "react";
import gsap from "gsap";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import { useGameIndex } from "@/hooks/features/games/useGameListFacade";
import { statsKeys } from "@/hooks/queries/useStats";
import { getAllGameStatistics } from "@/services/game/gameStats";
import { formatPlayTime } from "@/utils/dateTime";
import { getGameDisplayName } from "@/utils/game/gameDisplay";
import { getVisibleGameCover } from "../Home/homeData";
import { buildAnnualReport, getReportYears } from "./reportData";
import { useScrollRestore, saveScrollPosition } from "@/hooks/common/useScrollRestore";

const MONTHS = [
	"1月",
	"2月",
	"3月",
	"4月",
	"5月",
	"6月",
	"7月",
	"8月",
	"9月",
	"10月",
	"11月",
	"12月",
];
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function formatPlayTimeShort(minutes: number): string {
	if (!minutes) return "0h";
	const hours = Math.floor(minutes / 60);
	const mins = minutes % 60;
	if (hours >= 100) {
		const floatHours = Math.floor((minutes / 60) * 10) / 10;
		return `${floatHours}h`;
	}
	if (hours === 0) {
		return `${mins}m`;
	}
	if (mins > 0) {
		return `${hours}h ${mins}m`;
	}
	return `${hours}h`;
}

function getSplinePath(pts: { x: number; y: number }[]): string {
	if (pts.length < 2) return "";
	let path = `M ${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
	const n = pts.length;
	for (let i = 0; i < n - 1; i++) {
		const p0 = i > 0 ? pts[i - 1] : pts[i];
		const p1 = pts[i];
		const p2 = pts[i + 1];
		const p3 = i + 2 < n ? pts[i + 2] : pts[i + 1];

		const cp1x = p1.x + (p2.x - p0.x) / 6.0;
		const cp1y = p1.y + (p2.y - p0.y) / 6.0;
		const cp2x = p2.x - (p3.x - p1.x) / 6.0;
		const cp2y = p2.y - (p3.y - p1.y) / 6.0;

		path += ` C ${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
	}
	return path;
}

interface MonthlyWaveChartProps {
	data: number[];
	labels: string[];
	active?: boolean;
	year?: number;
}

function MonthlyWaveChart({ data, labels, active = true, year }: MonthlyWaveChartProps) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
	const [width, setWidth] = useState<number>(() => {
		if (typeof window !== "undefined") {
			return Math.max(520, window.innerWidth - 300);
		}
		return 900;
	});
	const height = 280;

	useLayoutEffect(() => {
		if (containerRef.current) {
			const clientW = containerRef.current.clientWidth;
			if (clientW > 100) {
				setWidth(clientW);
			}
		}
	}, []);

	useEffect(() => {
		if (!containerRef.current) return;
		const el = containerRef.current;
		const ro = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const w = Math.round(entry.contentRect.width);
				if (w > 100) {
					setWidth((prev) => (Math.abs(prev - w) > 2 ? w : prev));
				}
			}
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const padLeft = 38;
	const padRight = 24;
	const padTop = 46;
	const padBottom = 38;
	const chartW = Math.max(100, width - padLeft - padRight);
	const chartH = Math.max(80, height - padTop - padBottom);

	const maxVal = Math.max(1, ...data);
	const niceMax = maxVal <= 10 ? 10 : maxVal <= 30 ? 30 : maxVal <= 60 ? 60 : Math.ceil(maxVal / 20) * 20;

	const points = useMemo(() => {
		return data.map((val, idx) => {
			const x = padLeft + (idx * chartW) / 11;
			const y = padTop + chartH - (val / niceMax) * chartH;
			return { x, y, val };
		});
	}, [data, niceMax, chartW, padLeft, padTop, chartH]);

	const peakIdx = useMemo(() => {
		if (maxVal <= 0) return -1;
		return data.indexOf(maxVal);
	}, [data, maxVal]);

	const strokePath = useMemo(() => getSplinePath(points), [points]);
	const areaPath = useMemo(() => {
		if (points.length < 2) return "";
		const startX = points[0].x.toFixed(1);
		const endX = points[points.length - 1].x.toFixed(1);
		const baseY = (padTop + chartH).toFixed(1);
		const curveIdx = strokePath.indexOf("C");
		const curve = curveIdx >= 0 ? strokePath.substring(curveIdx) : "";
		return `M ${startX},${baseY} L ${startX},${points[0].y.toFixed(1)} ${curve} L ${endX},${baseY} Z`;
	}, [strokePath, points, padTop, chartH]);

	const strokeRef = useRef<SVGPathElement | null>(null);
	const areaRef = useRef<SVGPathElement | null>(null);
	const dotsRef = useRef<(SVGCircleElement | null)[]>([]);
	const badgeRef = useRef<SVGGElement | null>(null);

	useLayoutEffect(() => {
		if (!active || width <= 100) return;
		const strokeEl = strokeRef.current;
		const areaEl = areaRef.current;
		const badgeEl = badgeRef.current;

		if (strokeEl) {
			const len = strokeEl.getTotalLength ? strokeEl.getTotalLength() : 800;
			gsap.killTweensOf(strokeEl);
			gsap.fromTo(
				strokeEl,
				{ strokeDasharray: len, strokeDashoffset: len },
				{ strokeDashoffset: 0, duration: 0.95, ease: "power2.out" }
			);
		}

		if (areaEl) {
			gsap.killTweensOf(areaEl);
			gsap.fromTo(
				areaEl,
				{ opacity: 0, scaleY: 0, transformOrigin: `center ${padTop + chartH}px` },
				{ opacity: 1, scaleY: 1, duration: 0.85, ease: "power2.out", delay: 0.05 }
			);
		}

		const validDots = dotsRef.current.filter(Boolean);
		if (validDots.length > 0) {
			gsap.killTweensOf(validDots);
			gsap.set(validDots, { clearProps: "transform" });
			gsap.fromTo(
				validDots,
				{ scale: 0, opacity: 0, transformOrigin: "0px 0px" },
				{ scale: 1, opacity: 1, duration: 0.45, stagger: 0.03, ease: "back.out(2)", delay: 0.25 }
			);
		}

		if (badgeEl) {
			gsap.killTweensOf(badgeEl);
			gsap.set(badgeEl, { clearProps: "transform" });
			gsap.fromTo(
				badgeEl,
				{ scale: 0, opacity: 0, y: 8, transformOrigin: "0px 0px" },
				{ scale: 1, opacity: 1, y: 0, duration: 0.55, ease: "back.out(2)", delay: 0.6 }
			);
		}
	}, [active, year, data, width, padTop, chartH]);

	const gridLevels = [
		Math.round(niceMax * 0.33),
		Math.round(niceMax * 0.66),
		niceMax,
	];

	return (
		<Box ref={containerRef} className="annual-wave-chart-container">
			<svg
				width={width}
				height={height}
				className="annual-wave-svg"
				onMouseMove={(e) => {
					const rect = e.currentTarget.getBoundingClientRect();
					const mouseX = e.clientX - rect.left;
					const step = chartW / 11;
					const idx = Math.max(0, Math.min(11, Math.round((mouseX - padLeft) / step)));
					setHoveredIdx(idx);
				}}
				onMouseLeave={() => setHoveredIdx(null)}
			>
				<defs>
					<linearGradient id="annualWaveGradDark" x1="0" y1="0" x2="0" y2="1">
						<stop offset="0%" stopColor="#00e5ff" stopOpacity="0.32" />
						<stop offset="50%" stopColor="#38bdf8" stopOpacity="0.14" />
						<stop offset="100%" stopColor="#00e5ff" stopOpacity="0.01" />
					</linearGradient>
					<linearGradient id="annualWaveGradLight" x1="0" y1="0" x2="0" y2="1">
						<stop offset="0%" stopColor="#e06c3a" stopOpacity="0.25" />
						<stop offset="50%" stopColor="#f59e0b" stopOpacity="0.10" />
						<stop offset="100%" stopColor="#e06c3a" stopOpacity="0.01" />
					</linearGradient>
					<filter id="annualWaveGlow" x="-20%" y="-20%" width="140%" height="140%">
						<feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="#00e5ff" floodOpacity="0.35" />
					</filter>
				</defs>

				{gridLevels.map((lvl) => {
					const gy = padTop + chartH - (lvl / niceMax) * chartH;
					return (
						<g key={lvl} className="annual-wave-grid-group">
							<line
								x1={padLeft}
								y1={gy}
								x2={padLeft + chartW}
								y2={gy}
								className="annual-wave-grid-line"
							/>
							<text x={padLeft - 8} y={gy + 4} textAnchor="end" className="annual-wave-grid-text">
								{lvl}
							</text>
						</g>
					);
				})}

				{areaPath && (
					<path ref={areaRef} d={areaPath} className="annual-wave-area-path" />
				)}

				{strokePath && (
					<path ref={strokeRef} d={strokePath} className="annual-wave-stroke-path" />
				)}

				{points.map((pt, i) => {
					const isPeak = i === peakIdx && pt.val > 0;
					const isHovered = i === hoveredIdx;
					return (
						<g
							key={i}
							transform={`translate(${pt.x}, ${pt.y})`}
							className={`annual-wave-dot-wrapper ${isPeak ? "is-peak" : ""} ${isHovered ? "is-hovered" : ""}`}
							onMouseEnter={() => setHoveredIdx(i)}
						>
							{/* 峰值月份专属常驻个性化外环与辉光脉冲（无需常驻文字，一眼即识峰值） */}
							{isPeak && (
								<>
									<circle
										cx={0}
										cy={0}
										r={11}
										className="annual-wave-peak-beacon"
									/>
									<circle
										cx={0}
										cy={0}
										r={7.5}
										className="annual-wave-peak-ring"
									/>
								</>
							)}
							{isHovered && (
								<circle
									cx={0}
									cy={0}
									r={isPeak ? 12 : 9}
									className="annual-wave-dot-halo"
								/>
							)}
							<circle
								ref={(el) => {
									dotsRef.current[i] = el;
								}}
								cx={0}
								cy={0}
								r={isHovered ? (isPeak ? 6.5 : 5.5) : (isPeak ? 5 : 3.5)}
								className={`annual-wave-dot ${isPeak ? "is-peak" : ""} ${isHovered ? "is-hovered" : ""}`}
							/>
							{isPeak && (
								<circle
									cx={0}
									cy={0}
									r={1.8}
									className="annual-wave-peak-core"
								/>
							)}
							<circle
								cx={0}
								cy={0}
								r={24}
								fill="transparent"
								style={{ cursor: "pointer" }}
							/>
						</g>
					);
				})}

				{/* 悬停浮现气泡：全卡片X轴划过即可就近感应；舒展从容、带呼吸气室与定向指示指针 */}
				{hoveredIdx !== null && points[hoveredIdx] && (
					(() => {
						const pt = points[hoveredIdx];
						const isPeakHovered = hoveredIdx === peakIdx && pt.val > 0;
						const numText = `${pt.val}h`;
						const pillW = isPeakHovered
							? Math.max(86, numText.length * 8.5 + 46)
							: Math.max(68, numText.length * 8.5 + 32);
						const pillH = 26;
						const pillX = -pillW / 2;
						const isNearTop = pt.y < 42;
						const pillY = isNearTop ? 14 : -pillH - 10;
						const arrowY = isNearTop ? 14 : -10;
						const arrowTipY = isNearTop ? 9 : -5.5;

						return (
							<g
								transform={`translate(${pt.x}, ${pt.y})`}
								className={`annual-wave-tooltip-group ${isPeakHovered ? "is-peak" : ""}`}
							>
								<rect
									x={pillX}
									y={pillY}
									width={pillW}
									height={pillH}
									rx={pillH / 2}
									className={`annual-wave-tooltip-pill ${isPeakHovered ? "is-peak" : ""}`}
								/>
								<polygon
									points={`-4.5,${arrowY} 0,${arrowTipY} 4.5,${arrowY}`}
									className={`annual-wave-tooltip-arrow ${isPeakHovered ? "is-peak" : ""}`}
								/>
								<text
									x="0"
									y={pillY + pillH / 2}
									textAnchor="middle"
									dominantBaseline="central"
									className={`annual-wave-tooltip-text ${isPeakHovered ? "is-peak" : ""}`}
								>
									<tspan className="annual-wave-tooltip-num">{numText}</tspan>
									{isPeakHovered && (
										<tspan className="annual-wave-tooltip-star" dx="6">
											★
										</tspan>
									)}
								</text>
							</g>
						);
					})()
				)}
				{points.map((pt, i) => (
					<text
						key={i}
						x={pt.x}
						y={padTop + chartH + 20}
						textAnchor="middle"
						className={`annual-wave-month-label ${i === peakIdx && pt.val > 0 ? "is-peak" : ""} ${i === hoveredIdx ? "is-hovered" : ""}`}
					>
						{labels[i]}
					</text>
				))}
			</svg>
		</Box>
	);
}

interface WeeklyEnergyRailsProps {
	data: number[];
	labels: string[];
	active?: boolean;
	year?: number;
}

function WeeklyEnergyRails({ data, labels, active = true, year }: WeeklyEnergyRailsProps) {
	const maxVal = Math.max(1, ...data);
	const peakIdx = useMemo(() => {
		if (maxVal <= 0) return -1;
		return data.indexOf(maxVal);
	}, [data, maxVal]);

	const railRefs = useRef<(HTMLDivElement | null)[]>([]);
	const valueRefs = useRef<(HTMLSpanElement | null)[]>([]);

	useLayoutEffect(() => {
		if (!active) return;
		railRefs.current.forEach((rail, i) => {
			if (!rail) return;
			const targetRatio = Math.max(0, Math.min(100, (data[i] / maxVal) * 100));
			gsap.killTweensOf(rail);
			gsap.fromTo(
				rail,
				{ width: "0%" },
				{
					width: `${targetRatio}%`,
					duration: 0.85,
					ease: "power2.out",
					delay: 0.08 + i * 0.045,
				}
			);
		});

		const validVals = valueRefs.current.filter(Boolean);
		if (validVals.length > 0) {
			gsap.killTweensOf(validVals);
			gsap.fromTo(
				validVals,
				{ opacity: 0, x: -6 },
				{
					opacity: 1,
					x: 0,
					duration: 0.45,
					stagger: 0.045,
					delay: 0.25,
					ease: "power2.out",
				}
			);
		}
	}, [active, year, data, maxVal]);

	return (
		<Box className="annual-energy-rails-list">
			{labels.map((label, idx) => {
				const val = data[idx] || 0;
				const isPeak = idx === peakIdx && val > 0;
				return (
					<Box key={label} className={`annual-energy-rail-row ${isPeak ? "is-peak" : ""}`}>
						<Typography className="annual-energy-rail-label">
							{label}
						</Typography>
						<Box className="annual-energy-rail-track">
							<Box
								ref={(el) => {
									railRefs.current[idx] = el as HTMLDivElement | null;
								}}
								className={`annual-energy-rail-fill ${isPeak ? "is-peak" : ""}`}
							/>
						</Box>
						<span
							ref={(el) => {
								valueRefs.current[idx] = el;
							}}
							className="annual-energy-rail-val"
						>
							{val}h
						</span>
					</Box>
				);
			})}
		</Box>
	);
}

function AnimatedReportProgress({
	value,
	className,
	active = true,
}: {
	value: number;
	className?: string;
	active?: boolean;
}) {
	const barRef = useRef<HTMLDivElement | null>(null);

	useLayoutEffect(() => {
		const bar = barRef.current;
		if (!bar || !active) return;
		gsap.killTweensOf(bar);
		const targetWidth = Math.max(0, Math.min(100, value));
		gsap.set(bar, { width: "0%" });
		const tween = gsap.to(bar, {
			width: targetWidth + "%",
			duration: 0.85,
			ease: "power2.out",
			delay: 0.08,
		});
		return () => {
			tween.kill();
		};
	}, [value, active]);

	return (
		<Box className={"skerry-report-progress-track " + (className ?? "")}>
			<Box ref={barRef} className="skerry-report-progress-fill" />
		</Box>
	);
}

export function AnnualReport() {
	const { t } = useTranslation();
	const location = useLocation();
	const isReportActive = location.pathname === "/report" || location.pathname.startsWith("/report");
	const currentYear = new Date().getFullYear();
	const [selectedYear, setSelectedYear] = useState(currentYear);
	const [chartRenderKey, setChartRenderKey] = useState(0);

	useEffect(() => {
		if (!isReportActive) {
			setChartRenderKey(0);
			return;
		}
		setChartRenderKey(0);
		const timer = window.setTimeout(() => {
			setChartRenderKey((k) => k + 1);
		}, 60);
		return () => window.clearTimeout(timer);
	}, [isReportActive, selectedYear]);
	const { index, isLoading: gamesLoading } = useGameIndex();
	const statsQuery = useQuery({
		queryKey: [...statsKeys.all, "annualReport"],
		queryFn: async () => {
			const statsMap = await getAllGameStatistics();
			return [...statsMap.values()];
		},
	});
	const stats = statsQuery.data ?? [];
	const years = useMemo(() => getReportYears(stats), [stats]);
	const report = useMemo(
		() => buildAnnualReport(selectedYear, stats, index.displayById),
		[selectedYear, stats, index.displayById],
	);
	const loading = gamesLoading || statsQuery.isLoading;

	useScrollRestore("/report", { isLoading: loading });
	const peakMonthIndex = report.monthlyMinutes.reduce(
		(peak, value, index) => (value > report.monthlyMinutes[peak] ? index : peak),
		0,
	);
	const peakMonthMinutes = report.monthlyMinutes[peakMonthIndex];
	const averageMonthlyMinutes = Math.round(report.totalMinutes / 12);
	const allTimeMinutes = useMemo(
		() => stats.reduce((acc, s) => acc + (s.total_time ?? 0), 0),
		[stats],
	);

	const clearRate = report.clearRatePercent;

	const currentWeekActiveDays = useMemo(() => {
		const now = new Date();
		const dayOfWeek = (now.getDay() + 6) % 7; // 周一为0，周日为6
		const monday = new Date(
			now.getFullYear(),
			now.getMonth(),
			now.getDate() - dayOfWeek,
		);
		const weekDates = new Set<string>();
		for (let i = 0; i < 7; i++) {
			const d = new Date(
				monday.getFullYear(),
				monday.getMonth(),
				monday.getDate() + i,
			);
			const yyyy = d.getFullYear();
			const mm = String(d.getMonth() + 1).padStart(2, "0");
			const dd = String(d.getDate()).padStart(2, "0");
			weekDates.add(`${yyyy}-${mm}-${dd}`);
		}
		const playedDaysInWeek = new Set<string>();
		for (const gameStat of stats) {
			for (const record of gameStat.daily_stats ?? []) {
				if (
					record &&
					typeof record.date === "string" &&
					record.playtime > 0
				) {
					if (weekDates.has(record.date)) {
						playedDaysInWeek.add(record.date);
					}
				}
			}
		}
		return playedDaysInWeek.size;
	}, [stats]);

	const metrics = [
		{
			label: t("pages.AnnualReport.newGames", "新增游戏"),
			value: String(report.newGames),
			icon: <AddCircleOutlineRoundedIcon color="secondary" />,
		},
		{
			label: t("pages.AnnualReport.gamesPlayed", "玩过的游戏"),
			value: String(report.gamesPlayed),
			icon: <SportsEsportsRoundedIcon color="success" />,
		},
		{
			label: t("pages.AnnualReport.completedGames", "通关游戏"),
			value: String(report.completedGames),
			icon: <EmojiEventsRoundedIcon color="warning" />,
		},
		{
			label: t("pages.AnnualReport.activeDays", "活跃天数"),
			value: String(report.activeDays),
			icon: <CalendarMonthRoundedIcon color="info" />,
		},
		{
			label: t("pages.AnnualReport.averageMonthlyPlayTime", "月均游玩"),
			value: formatPlayTime(averageMonthlyMinutes),
			icon: <AccessTimeRoundedIcon color="primary" />,
		},
		{
			label: t("pages.AnnualReport.averageActiveDay", "活跃日均时长"),
			value: formatPlayTime(report.averageActiveDayMinutes),
			icon: <TimerRoundedIcon color="primary" />,
		},
		{
			label: t("pages.AnnualReport.longestStreak", "最长连续游玩"),
			value: t("pages.AnnualReport.daysValue", "{{count}} 天", {
				count: report.longestStreak,
			}),
			icon: <LocalFireDepartmentRoundedIcon color="warning" />,
		},
		{
			label: "峰值月份",
			value: `${MONTHS[peakMonthIndex]} · ${formatPlayTime(peakMonthMinutes)}`,
			icon: <TrendingUpRoundedIcon color="secondary" />,
		},
	];

	const topGameShare =
		report.totalMinutes > 0 && report.topGames.length > 0
			? report.topGames[0].minutes / report.totalMinutes
			: 0;
	const peakDayLabel = report.peakDay
		? new Date(report.peakDay.date + "T00:00:00Z").toLocaleDateString(
				"zh-CN",
				{ month: "short", day: "numeric", timeZone: "UTC" },
			)
		: "-";

	return (
		<Box className="annual-report-stage">
			<Box className="annual-report-header">
				<Box>
					<Typography className="atlas-kicker">SKERRY / SUMMARY IN REVIEW</Typography>
					<Typography variant="h4" fontWeight={800} className="annual-report-title">
						{t("pages.AnnualReport.title", "游戏总结")}
					</Typography>
					<Typography color="text.secondary" variant="body2" className="skerry-page-subtitle">
						{t("pages.AnnualReport.subtitle", "回顾游戏时间与游玩节奏")}
					</Typography>
				</Box>
				<FormControl size="small" sx={{ minWidth: 112 }}>
					<Select
						value={selectedYear}
						onChange={(event) => setSelectedYear(Number(event.target.value))}
						MenuProps={{
							PaperProps: {
								className: "skerry-select-menu-compact-paper skerry-select-menu-w-28",
							},
							MenuListProps: { className: "skerry-select-menu-compact" },
						}}
					>
						<MenuItem value={0}>全部年份</MenuItem>
						{years.map((year) => (
							<MenuItem key={year} value={year}>
								{year}
							</MenuItem>
						))}
					</Select>
				</FormControl>
			</Box>

			{loading ? null : (
				<Box className="annual-report-hero">
					<Box className="annual-report-hero-main">
						<Typography className="annual-hero-kicker">
							ANNUAL SIGNAL
						</Typography>
						<Box sx={{ display: "flex", alignItems: "baseline", gap: 1.5, flexWrap: "wrap" }}>
							<Typography className="annual-hero-value">
								{formatPlayTimeShort(report.totalMinutes)}
							</Typography>
							{selectedYear !== 0 && (
								<Typography
									component="span"
									sx={{
										fontSize: { xs: "1.1rem", sm: "1.35rem" },
										fontWeight: 700,
										color: "text.secondary",
										opacity: 0.9,
										letterSpacing: "-0.01em",
									}}
								>
									/ {formatPlayTimeShort(allTimeMinutes)}
								</Typography>
							)}
						</Box>
						<Typography className="annual-hero-label">
							{selectedYear === 0 ? "全部游戏时长" : "年度游玩 / 全部游戏时长"}
						</Typography>
					</Box>
					<Box className="annual-report-hero-side">
						<Box className="annual-hero-stat-card">
							<Box className="annual-hero-stat-top">
								<Box className="annual-hero-stat-badge annual-hero-badge-week">
									<CalendarMonthRoundedIcon sx={{ fontSize: 15 }} />
								</Box>
								<Typography className="annual-hero-stat-label">单周出勤</Typography>
							</Box>
							<Box className="annual-hero-stat-middle">
								<Typography className="annual-hero-stat-value">
									{currentWeekActiveDays}
									<Typography component="span" className="annual-hero-stat-unit">
										/ 7天
									</Typography>
								</Typography>
							</Box>
							<Box className="annual-hero-week-dots">
								{Array.from({ length: 7 }).map((_, i) => (
									<Box
										key={i}
										className={`annual-hero-week-dot ${i < currentWeekActiveDays ? "is-active" : ""}`}
									/>
								))}
							</Box>
						</Box>

						<Box className="annual-hero-stat-card">
							<Box className="annual-hero-stat-top">
								<Box className="annual-hero-stat-badge annual-hero-badge-clear">
									<EmojiEventsRoundedIcon sx={{ fontSize: 15 }} />
								</Box>
								<Typography className="annual-hero-stat-label">游戏通关率</Typography>
							</Box>
							<Box className="annual-hero-stat-middle">
								<Typography className="annual-hero-stat-value">
									{clearRate}
									<Typography component="span" className="annual-hero-stat-unit">
										%
									</Typography>
								</Typography>
								{report.clearRateDenominator > 0 && (
									<Typography className="annual-hero-stat-sub">
										{report.clearRateNumerator}/{report.clearRateDenominator}部
									</Typography>
								)}
							</Box>
							<AnimatedReportProgress
								value={clearRate}
								className="annual-hero-stat-progress"
								active={isReportActive}
							/>
						</Box>
					</Box>
					{report.topGames[0] ? (
						<Box className="annual-report-featured">
							<Box className="annual-report-featured-cover">
								<img
									src={getVisibleGameCover(report.topGames[0].game, false)}
									alt=""
									loading="lazy"
								/>
							</Box>
							<Box className="annual-report-featured-info">
								<Typography className="annual-report-featured-kicker">
									GAME OF THE YEAR
								</Typography>
								<Typography className="annual-report-featured-name" noWrap>
									{getGameDisplayName(report.topGames[0].game)}
								</Typography>
								<Typography className="annual-report-featured-value">
									{formatPlayTimeShort(report.topGames[0].minutes)} · {Math.round(topGameShare * 100)}%
								</Typography>
								<AnimatedReportProgress
									value={Math.max(4, topGameShare * 100)}
									className="annual-report-featured-progress"
									active={isReportActive}
								/>
							</Box>
						</Box>
					) : (
						<Box className="annual-report-featured annual-report-featured-empty">
							<Box
								className="annual-report-featured-cover"
								sx={{
									display: "grid",
									placeItems: "center",
									bgcolor: "action.hover",
								}}
							>
								<SportsEsportsRoundedIcon
									sx={{ fontSize: 26, color: "text.disabled", opacity: 0.5 }}
								/>
							</Box>
							<Box className="annual-report-featured-info">
								<Typography className="annual-report-featured-kicker">
									GAME OF THE YEAR
								</Typography>
								<Typography
									className="annual-report-featured-name"
									sx={{ color: "text.secondary" }}
									noWrap
								>
									{selectedYear === 0 ? "暂无游戏记录" : "暂无年度游戏"}
								</Typography>
								<Typography className="annual-report-featured-value">
									0h · 0%
								</Typography>
								<AnimatedReportProgress
									value={0}
									className="annual-report-featured-progress"
									active={isReportActive}
								/>
							</Box>
						</Box>
					)}
				</Box>
			)}

			{loading ? (
				<Box className="grid min-h-[360px] place-items-center">
					<CircularProgress />
				</Box>
			) : statsQuery.isError ? (
				<Alert severity="error">
					{t("pages.AnnualReport.loadFailed", "年度数据加载失败")}
				</Alert>
			) : (
				<Box className="annual-report-body">
					<Box className="annual-report-metrics">
						{metrics.map((metric) => (
							<Paper
								key={metric.label}
								variant="outlined"
								className="annual-report-metric"
							>
								<Box className="annual-report-metric-icon">
									{metric.icon}
								</Box>
								<Box className="min-w-0">
									<Typography variant="body2" color="text.secondary" noWrap>
										{metric.label}
									</Typography>
									<Typography variant="h6" fontWeight={700} noWrap>
										{metric.value}
									</Typography>
								</Box>
							</Paper>
						))}
					</Box>

					<Box className="annual-report-rhythm-row">
						<Paper
							variant="outlined"
							className="annual-report-panel annual-report-rhythm"
						>
							<Box className="annual-report-rhythm-header">
								<Typography variant="subtitle1" fontWeight={700}>
									月度节奏
								</Typography>
								<Typography variant="caption" color="text.secondary">
									峰值 {MONTHS[peakMonthIndex]} · {formatPlayTime(peakMonthMinutes)}
								</Typography>
							</Box>
							<Box className="annual-report-rhythm-track">
								{report.monthlyMinutes.map((value, index) => {
									const max = Math.max(...report.monthlyMinutes);
									return (
										<Tooltip
											key={MONTHS[index]}
											title={`${MONTHS[index]} · ${formatPlayTime(value)}`}
											placement="top"
											arrow
										>
											<Box
												className={
													"annual-rhythm-cell" +
													(value > 0 ? " is-active" : "") +
													(index === peakMonthIndex && value > 0 ? " is-peak" : "")
												}
												style={{
													"--cell-value": max ? value / max : 0,
												} as CSSProperties}
											/>
										</Tooltip>
									);
								})}
							</Box>
						</Paper>
						<Paper
							variant="outlined"
							className="annual-report-panel annual-report-facts"
						>
							<Box className="annual-fact-card">
								<Box className="annual-fact-badge annual-fact-badge-calendar">
									<CalendarMonthRoundedIcon sx={{ fontSize: 16 }} />
								</Box>
								<Box className="annual-fact-content">
									<Typography className="annual-fact-label">
										峰值日
									</Typography>
									<Typography className="annual-fact-value">
										{peakDayLabel}
									</Typography>
								</Box>
							</Box>
							<Box className="annual-fact-card">
								<Box className="annual-fact-badge annual-fact-badge-timer">
									<TimerRoundedIcon sx={{ fontSize: 16 }} />
								</Box>
								<Box className="annual-fact-content">
									<Typography className="annual-fact-label">
										单日时长
									</Typography>
									<Typography className="annual-fact-value">
										{report.peakDay ? formatPlayTimeShort(report.peakDay.minutes) : "-"}
									</Typography>
								</Box>
							</Box>
							<Box className="annual-fact-card">
								<Box className="annual-fact-badge annual-fact-badge-rate">
									<TrendingUpRoundedIcon sx={{ fontSize: 16 }} />
								</Box>
								<Box className="annual-fact-content">
									<Typography className="annual-fact-label">
										活跃率
									</Typography>
									<Typography className="annual-fact-value annual-fact-value-highlight">
										{Math.round((report.activeDays / 365) * 100)}%
									</Typography>
								</Box>
							</Box>
						</Paper>
					</Box>

					<Box className="annual-report-charts">
						<Paper variant="outlined" className="annual-report-panel">
							<Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 0.5 }}>
								<Typography variant="subtitle1" fontWeight={700}>
									{t("pages.AnnualReport.monthly", "月度游玩时长")}
								</Typography>
								{report.totalMinutes > 0 && peakMonthMinutes > 0 ? (
									<Typography variant="caption" className="annual-chart-peak-caption">
										峰值 {MONTHS[peakMonthIndex]} · {Math.round(peakMonthMinutes / 6) / 10}h ★
									</Typography>
								) : (
									<Typography variant="caption" color="text.secondary">
										暂无月度数据
									</Typography>
								)}
							</Box>
							<MonthlyWaveChart
								key={`monthly-${selectedYear}-${chartRenderKey}`}
								data={report.monthlyMinutes.map((value) => Math.round(value / 6) / 10)}
								labels={MONTHS}
								active={isReportActive}
								year={selectedYear}
							/>
						</Paper>
						<Paper variant="outlined" className="annual-report-panel">
							<Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 0.5 }}>
								<Typography variant="subtitle1" fontWeight={700}>
									{t("pages.AnnualReport.weekday", "一周游玩分布")}
								</Typography>
								{report.totalMinutes > 0 ? (
									(() => {
										const weekdayHours = report.weekdayMinutes.map((v) => Math.round(v / 6) / 10);
										const maxH = Math.max(...weekdayHours);
										const peakWkIdx = weekdayHours.indexOf(maxH);
										return maxH > 0 ? (
											<Typography variant="caption" className="annual-chart-peak-caption">
												峰值 {WEEKDAYS[peakWkIdx]} · {maxH}h ★
											</Typography>
										) : null;
									})()
								) : (
									<Typography variant="caption" color="text.secondary">
										暂无分布数据
									</Typography>
								)}
							</Box>
							<WeeklyEnergyRails
								key={`weekly-${selectedYear}-${chartRenderKey}`}
								data={report.weekdayMinutes.map((value) => Math.round(value / 6) / 10)}
								labels={WEEKDAYS}
								active={isReportActive}
								year={selectedYear}
							/>
						</Paper>
					</Box>

					{report.totalMinutes === 0 ? (
						<Alert severity="info" sx={{ mt: 1 }}>
							{selectedYear === 0
								? "暂无游玩记录"
								: t("pages.AnnualReport.empty", "这一年还没有游玩记录")}
						</Alert>
					) : (
						<Paper variant="outlined" className="annual-report-panel annual-report-ranking">
							<Box className="annual-report-ranking-header" sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", pb: 1.5, mb: 1 }}>
								<Typography variant="subtitle1" fontWeight={700}>
									{selectedYear === 0
										? "全库游戏排行"
										: t("pages.AnnualReport.topGames", "年度游戏排行")}
								</Typography>
								<Typography variant="caption" color="text.secondary" fontWeight={600}>
									{selectedYear === 0 ? "Top 20 · 全部历程" : `Top 20 · ${selectedYear} 年度`}
								</Typography>
							</Box>
							<Box className="annual-report-ranking-list">
								{report.topGames.slice(0, 20).map((item, index) => {
									const maxMinutes = report.topGames[0]?.minutes || 1;
									const ratio = Math.min(100, Math.max(0, (item.minutes / maxMinutes) * 100));
									const sharePercent = report.totalMinutes > 0
										? Math.round((item.minutes / report.totalMinutes) * 100)
										: 0;
									const rankNum = String(index + 1).padStart(2, "0");

									return (
										<Box
											key={item.game.id}
											component={Link}
											to={`/libraries/${item.game.id}`}
											onClick={() => saveScrollPosition("/report")}
											className={`annual-report-ranking-row ${index < 3 ? `rank-top-${index + 1}` : ""}`}
											style={{ "--fill-ratio": `${ratio}%` } as React.CSSProperties}
										>
											<div className="annual-report-ranking-ambient-fill" />
											<div className="annual-report-ranking-row-content">
												<Typography
													className={`annual-report-rank-number ${index < 3 ? `rank-${index + 1}` : ""}`}
												>
													{rankNum}
												</Typography>
												<div className="annual-report-ranking-cover">
													<img
														src={getVisibleGameCover(item.game, false)}
														alt=""
														loading="lazy"
														className="annual-report-ranking-cover-image"
													/>
												</div>
												<div className="annual-report-ranking-info">
													<Typography className="annual-report-ranking-title" noWrap>
														{getGameDisplayName(item.game) || t("common.unknown", "未知游戏")}
													</Typography>
													<Typography className="annual-report-ranking-meta" noWrap>
														<span>{item.game.developer && item.game.developer !== "——" && item.game.developer !== "-" ? item.game.developer : t("common.unknown", "未知会社")}</span>
														{index === 0 && (
															<span className="annual-report-rank-tag-champion">
																★ {t("pages.AnnualReport.topOne", "年度冠军")}
															</span>
														)}
													</Typography>
												</div>
												<div className="annual-report-ranking-stats">
													<Typography className="annual-report-ranking-time">
														{formatPlayTimeShort(item.minutes)}
													</Typography>
													<Typography className="annual-report-ranking-share">
														{sharePercent > 0 ? `${sharePercent}%` : ""}
													</Typography>
												</div>
											</div>
										</Box>
									);
								})}
							</Box>
						</Paper>
					)}
				</Box>
			)}
		</Box>
	);
}
