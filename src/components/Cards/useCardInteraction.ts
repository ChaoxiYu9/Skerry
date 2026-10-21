import { useCallback, useEffect, useRef } from "react";

const SINGLE_CLICK_DELAY_MS = 120;

/**
 * 卡片交互 Hook - 处理点击、双击逻辑
 * 使用 useRef 管理计时器，避免不必要的重渲染
 */
export function useCardInteraction(options: {
	onClick: () => void;
	onDoubleClick: () => void;
	useDelayedClick: boolean;
}) {
	const { onClick, onDoubleClick, useDelayedClick } = options;

	// 使用 ref 管理计时器，避免 state 更新导致重渲染
	const clickTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// 清理计时器
	const clearClickTimeout = useCallback(() => {
		if (clickTimeoutRef.current) {
			clearTimeout(clickTimeoutRef.current);
			clickTimeoutRef.current = null;
		}
	}, []);

	// 点击处理
	const handleClick = useCallback(() => {
		if (useDelayedClick) {
			clearClickTimeout();
			clickTimeoutRef.current = setTimeout(() => {
				onClick();
				clickTimeoutRef.current = null;
			}, SINGLE_CLICK_DELAY_MS);
		} else {
			onClick();
		}
	}, [onClick, useDelayedClick, clearClickTimeout]);

	// 双击处理
	const handleDoubleClick = useCallback(() => {
		if (useDelayedClick) {
			clearClickTimeout();
		}
		onDoubleClick();
	}, [onDoubleClick, useDelayedClick, clearClickTimeout]);

	// 组件卸载时清理计时器
	useEffect(() => {
		return () => {
			clearClickTimeout();
		};
	}, [clearClickTimeout]);

	return {
		handlers: {
			onClick: handleClick,
			onDoubleClick: handleDoubleClick,
		},
	};
}
