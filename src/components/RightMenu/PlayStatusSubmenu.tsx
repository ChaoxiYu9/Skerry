/**
 * @file PlayStatusSubmenu 组件
 * @description 游戏状态二级菜单组件，用于选择游戏状态（想玩、在玩、玩过、搁置、弃坑）
 * @module src/components/RightMenu/PlayStatusSubmenu
 */

import CancelIcon from "@mui/icons-material/Cancel";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import EmojiEventsIcon from "@mui/icons-material/EmojiEvents";
import EmojiEventsOutlinedIcon from "@mui/icons-material/EmojiEventsOutlined";
import PauseCircleIcon from "@mui/icons-material/PauseCircle";
import PlayCircleIcon from "@mui/icons-material/PlayCircle";
import StarBorderIcon from "@mui/icons-material/StarBorder";
import {
	Box,
	ListItemIcon,
	ListItemText,
	MenuItem,
	Paper,
	Portal,
} from "@mui/material";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	ALL_PLAY_STATUSES,
	isPlayedStatus,
	PLAY_STATUS_I18N_KEYS,
	PlayStatus,
} from "@/types/collection";

/**
 * 获取游戏状态对应的图标组件（带颜色）
 * 想玩: 黄色, 在玩: 蓝色, 玩过: 绿色, 搁置: 浅红色, 弃坑: 红色
 */
const getPlayStatusIcon = (status: PlayStatus) => {
	switch (status) {
		case PlayStatus.WISH:
			return <StarBorderIcon fontSize="small" className="play-status-icon-wish" />;
		case PlayStatus.PLAYING:
			return <PlayCircleIcon fontSize="small" className="play-status-icon-playing" />;
		case PlayStatus.PLAYED:
			return <CheckCircleIcon fontSize="small" className="play-status-icon-played" />;
		case PlayStatus.ON_HOLD:
			return <PauseCircleIcon fontSize="small" className="play-status-icon-hold" />;
		case PlayStatus.DROPPED:
			return <CancelIcon fontSize="small" className="play-status-icon-dropped" />;
		default:
			return <StarBorderIcon fontSize="small" className="play-status-icon-wish" />;
	}
};

interface PlayStatusSubmenuProps {
	/** 当前游戏状态 */
	currentStatus: number | undefined;
	/** 状态变更回调 */
	onStatusChange: (newStatus: PlayStatus) => void;
	/** 是否禁用 */
	disabled?: boolean;
	/** 图标大小，Toolbar 使用 small */
	iconSize?: "small" | "medium";
	/** 展开方向，Toolbar 向左展开 */
	expandDirection?: "left" | "right";
}

/**
 * 计算最佳展开方向
 * 根据父菜单位置和视口大小，自动选择：左上、左下、右上、右下
 * 优先考虑传入的 preferredDirection 作为首选方向
 */
const getBestExpandDirection = (
	itemRect: DOMRect,
	submenuWidth: number,
	submenuHeight: number,
	preferredDirection?: "left" | "right",
): "left-up" | "left-down" | "right-up" | "right-down" => {
	const viewportWidth = window.innerWidth;
	const viewportHeight = window.innerHeight;

	// 检查右侧空间
	const rightSpace = viewportWidth - itemRect.right;
	const canExpandRight = rightSpace >= submenuWidth;

	// 检查左侧空间
	const leftSpace = itemRect.left;
	const canExpandLeft = leftSpace >= submenuWidth;

	// 检查上方空间
	const topSpace = itemRect.top;
	const canExpandUp = topSpace >= submenuHeight;

	// 检查下方空间
	const bottomSpace = viewportHeight - itemRect.bottom;
	const canExpandDown = bottomSpace >= submenuHeight;

	// 如果设置了首选方向，优先尝试该方向
	if (preferredDirection === "left" && canExpandLeft) {
		return canExpandDown ? "left-down" : "left-up";
	}
	if (preferredDirection === "right" && canExpandRight) {
		return canExpandDown ? "right-down" : "right-up";
	}

	// 优先保证水平方向
	if (canExpandRight) {
		return canExpandDown ? "right-down" : "right-up";
	}
	if (canExpandLeft) {
		return canExpandDown ? "left-down" : "left-up";
	}

	// 如果水平方向空间不足，尝试垂直方向
	if (canExpandDown) {
		return canExpandRight ? "right-down" : "left-down";
	}
	if (canExpandUp) {
		return canExpandRight ? "right-up" : "left-up";
	}

	// 默认向右下展开
	return "right-down";
};

/**
 * 游戏状态二级菜单组件
 * hover 时展开二级菜单显示所有状态选项
 * 可同时用于 RightMenu 和 Toolbar
 */
export const PlayStatusSubmenu: React.FC<PlayStatusSubmenuProps> = ({
	currentStatus,
	onStatusChange,
	disabled = false,
	iconSize = "medium",
	expandDirection = "right",
}) => {
	const { t } = useTranslation();
	const [submenuOpen, setSubmenuOpen] = useState(false);
	const menuItemRef = useRef<HTMLLIElement>(null);
	const submenuRef = useRef<HTMLDivElement>(null);
	const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const submenuWidth = 224;
	const submenuHeight = 236;
	const [positionInfo, setPositionInfo] = useState<{
		direction: "left-up" | "left-down" | "right-up" | "right-down";
		left: number;
		top: number;
	}>({
		direction: "right-down",
		left: 0,
		top: 0,
	});

	const updatePosition = useCallback(() => {
		const itemRect = menuItemRef.current?.getBoundingClientRect();
		if (!itemRect) return;

		const dir = getBestExpandDirection(
			itemRect,
			submenuWidth,
			submenuHeight,
			expandDirection,
		);

		let left: number;
		let top: number;

		switch (dir) {
			case "right-up":
				left = itemRect.right;
				top = itemRect.bottom - submenuHeight;
				break;
			case "right-down":
				left = itemRect.right;
				top = itemRect.top;
				break;
			case "left-up":
				left = itemRect.left - submenuWidth;
				top = itemRect.bottom - submenuHeight;
				break;
			default:
				left = itemRect.left - submenuWidth;
				top = itemRect.top;
				break;
		}

		if (left < 0) left = 0;
		if (left + submenuWidth > window.innerWidth) {
			left = window.innerWidth - submenuWidth;
		}
		if (top < 0) top = 0;
		if (top + submenuHeight > window.innerHeight) {
			top = window.innerHeight - submenuHeight;
		}

		setPositionInfo({ direction: dir, left, top });
	}, [expandDirection]);

	// 清除关闭定时器
	const clearCloseTimer = () => {
		if (closeTimerRef.current) {
			clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
	};

	// 鼠标进入主菜单项时打开二级菜单
	const handleMouseEnter = () => {
		if (!disabled) {
			clearCloseTimer();
			updatePosition();
			setSubmenuOpen(true);
		}
	};

	// 鼠标离开主菜单项时延迟关闭
	const handleMouseLeave = () => {
		clearCloseTimer();
		closeTimerRef.current = setTimeout(() => {
			setSubmenuOpen(false);
		}, 200);
	};

	// 点击状态选项
	const handleStatusClick = (status: PlayStatus) => {
		onStatusChange(status);
		setSubmenuOpen(false);
	};

	const isPlayed = isPlayedStatus(currentStatus);

	// 当二级菜单打开时，重新计算位置
	useEffect(() => {
		if (!submenuOpen) return;
		updatePosition();
	}, [submenuOpen, updatePosition]);

	// 根据展开方向获取箭头图标
	const getArrowIcon = () => {
		switch (positionInfo.direction) {
			case "left-up":
			case "left-down":
				return <ChevronLeftIcon fontSize="small" sx={{ ml: 1 }} />;
			default:
				return <ChevronRightIcon fontSize="small" sx={{ ml: 1 }} />;
		}
	};

	return (
		<Box
			component="div"
			sx={{ position: "relative" }}
			onMouseEnter={handleMouseEnter}
			onMouseLeave={handleMouseLeave}
		>
			<MenuItem ref={menuItemRef} disabled={disabled}>
				<ListItemIcon>
					{isPlayed ? (
						<EmojiEventsIcon fontSize={iconSize} className="text-yellow-500" />
					) : (
						<EmojiEventsOutlinedIcon fontSize={iconSize} />
					)}
				</ListItemIcon>
				<ListItemText primary={t("common.changePlayStatus", "修改游戏状态")} />
				{getArrowIcon()}
			</MenuItem>

			{/* 二级菜单 - 使用自定义 div + Paper 避免 MUI Menu 的焦点问题 */}
			<Portal>
				<div
					role="menu"
					ref={submenuRef}
					style={{
						position: "fixed",
						top: positionInfo.top,
						left: positionInfo.left,
						display: submenuOpen ? "block" : "none",
						zIndex: 9999,
					}}
				>
					<Paper
						className="skerry-submenu-paper skerry-detail-more-menu-paper"
						elevation={8}
						sx={{
							width: submenuWidth,
							maxWidth: "calc(100vw - 16px)",
							borderRadius: "10px",
						}}
					>
						<Box className="skerry-detail-more-menu-list skerry-submenu-list">
						{ALL_PLAY_STATUSES.map((status) => (
							<MenuItem
								key={status}
								onClick={() => handleStatusClick(status)}
								selected={currentStatus === status}
							>
								<ListItemIcon>{getPlayStatusIcon(status)}</ListItemIcon>
								<ListItemText primary={t(PLAY_STATUS_I18N_KEYS[status])} />
							</MenuItem>
						))}
						</Box>
					</Paper>
				</div>
			</Portal>
		</Box>
	);
};

export default PlayStatusSubmenu;
