import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { memo, useMemo, useRef } from "react";
import { Virtuoso } from "react-virtuoso";
import { RevealImage } from "@/components/motion/RevealImage";
import { formatPlayTime } from "@/utils/dateTime";
import type { ActivityFilter, ActivityGroup, ActivityItem } from "./homeData";
import { ActivityGlyph, SectionHeading } from "./HomeSharedComponents";

export interface HomeActivityTimelineProps {
	groups: ActivityGroup[];
	filter: ActivityFilter;
	onFilter: (filter: ActivityFilter) => void;
	onEndReached?: () => void;
	hasMore?: boolean;
	isFetchingMore?: boolean;
	isLoading?: boolean;
}

type TimelineRowItem =
	| {
			kind: "date-header";
			id: string;
			dateLabel: string;
	  }
	| {
			kind: "activity";
			id: string;
			item: ActivityItem;
	  };

function formatDateHeader(dateStr: string): string {
	const parts = dateStr.split("-");
	if (parts.length === 3) {
		const [y, m, d] = parts.map((n) => parseInt(n, 10));
		const now = new Date();
		const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
		const targetDate = new Date(y, m - 1, d).getTime();
		const diffDays = Math.round((todayStart - targetDate) / (1000 * 60 * 60 * 24));
		if (diffDays === 0) return "今天";
		if (diffDays === 1) return "昨天";
		if (diffDays === 2) return "前天";

		const currentYear = now.getFullYear();
		if (y === currentYear) {
			return `${m}月${d}日`;
		}
		return `${y}年${m}月${d}日`;
	}
	return dateStr;
}

export const HomeActivityTimeline = memo(function HomeActivityTimeline({
	groups,
	filter,
	onFilter,
	onEndReached,
	hasMore,
	isFetchingMore,
	isLoading = false,
}: HomeActivityTimelineProps) {
	const flatItems = useMemo<TimelineRowItem[]>(() => {
		const list: TimelineRowItem[] = [];
		for (const group of groups) {
			if (!group.items.length) continue;
			list.push({
				kind: "date-header",
				id: `date-${group.date}`,
				dateLabel: formatDateHeader(group.date),
			});
			for (const item of group.items) {
				list.push({
					kind: "activity",
					id: `item-${item.id}`,
					item,
				});
			}
		}
		return list;
	}, [groups]);

	const lastEndReachedAtRef = useRef(0);

	const handleEndReached = () => {
		if (!onEndReached || !hasMore || isFetchingMore) return;
		const now = performance.now();
		if (now - lastEndReachedAtRef.current < 450) return;
		lastEndReachedAtRef.current = now;
		onEndReached();
	};

	const renderTimelineRow = (_index: number, row: TimelineRowItem) => {
		if (row.kind === "date-header") {
			return (
				<Box className="atlas-timeline-date-header" key={row.id}>
					<Typography className="atlas-timeline-date-text">
						{row.dateLabel}
					</Typography>
				</Box>
			);
		}

		const { item } = row;
		return (
			<Box className="atlas-timeline-row" data-flip-key={item.id} key={row.id}>
				<Box className={"atlas-timeline-dot is-" + item.type}>
					<ActivityGlyph type={item.type} />
				</Box>
				<Box className="atlas-timeline-thumb">
					<RevealImage
						src={item.imageUrl}
						alt=""
						loading="lazy"
						revealMotion={false}
					/>
				</Box>
				<Box sx={{ minWidth: 0, flex: 1 }}>
					<Typography className="atlas-timeline-title" noWrap>
						{item.gameTitle}
					</Typography>
					<Typography variant="caption">
						{item.type === "play"
							? "游玩 " + formatPlayTime(item.duration ?? 0)
							: "加入游戏库"}
					</Typography>
				</Box>
			</Box>
		);
	};

	return (
		<section className="atlas-section atlas-timeline">
			<Box className="atlas-section-bar">
				<SectionHeading title="最近轨迹" icon={<ActivityGlyph type="all" />} />
				<Stack direction="row" spacing={0.5}>
					{(["all", "play", "add"] as ActivityFilter[]).map((value) => {
						return (
							<Chip
								key={value}
								size="small"
								icon={<ActivityGlyph type={value} />}
								label={
									value === "all" ? "全部" : value === "play" ? "游玩" : "添加"
								}
								variant={filter === value ? "filled" : "outlined"}
								color={filter === value ? "primary" : "default"}
								className={"atlas-timeline-filter-chip is-" + value}
								onClick={() => onFilter(value)}
							/>
						);
					})}
				</Stack>
			</Box>
			{flatItems.length === 0 ? (
				isLoading ? (
					<Box sx={{ p: 2, display: "flex", flexDirection: "column", gap: 1.5 }}>
						<Skeleton variant="rounded" height={44} sx={{ borderRadius: "10px", opacity: 0.35 }} />
						<Skeleton variant="rounded" height={44} sx={{ borderRadius: "10px", opacity: 0.2 }} />
					</Box>
				) : (
					<Box className="atlas-empty">
						<Typography>还没有轨迹。</Typography>
						<Typography variant="caption">
							每次启动都会在这里留下一个时间点。
						</Typography>
					</Box>
				)
			) : (
				<Virtuoso
					className="atlas-timeline-list atlas-virtual-list"
					data={flatItems}
					computeItemKey={(_, row) => row.id}
					increaseViewportBy={{ top: 180, bottom: 360 }}
					endReached={handleEndReached}
					itemContent={renderTimelineRow}
					components={{
						Footer: () =>
							isFetchingMore ? (
								<Typography
									className="atlas-timeline-loading"
									variant="caption"
								>
									正在加载更多轨迹...
								</Typography>
							) : null,
					}}
					style={{ height: "100%" }}
				/>
			)}
		</section>
	);
});
