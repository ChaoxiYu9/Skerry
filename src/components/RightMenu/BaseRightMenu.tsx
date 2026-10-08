/**
 * @file BaseRightMenu 基础右键菜单容器组件
 * @description 提供统一的定位、自动关闭和键盘事件处理逻辑，供 RightMenu 和 CollectionRightMenu 复用
 * @module src/components/RightMenu/BaseRightMenu
 * @author Skerry contributors (based on ReinaManager)
 * @copyright AGPL-3.0
 */

import { Paper } from "@mui/material";
import {
	type CSSProperties,
	type PropsWithChildren,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
} from "react";
import { createPortal } from "react-dom";

const MENU_MARGIN = 8;

function clampMenuPosition(
	anchorPosition: { top: number; left: number },
	menuSize: { width: number; height: number },
) {
	const maxTop = Math.max(
		MENU_MARGIN,
		window.innerHeight - menuSize.height - MENU_MARGIN,
	);
	const maxLeft = Math.max(
		MENU_MARGIN,
		window.innerWidth - menuSize.width - MENU_MARGIN,
	);

	return {
		top: Math.max(MENU_MARGIN, Math.min(anchorPosition.top, maxTop)),
		left: Math.max(MENU_MARGIN, Math.min(anchorPosition.left, maxLeft)),
	};
}

/**
 * BaseRightMenu 组件属性类型
 */
interface BaseRightMenuProps {
	isopen: boolean;
	anchorPosition?: { top: number; left: number };
	onClose: () => void;
	ariaLabel: string;
}

/**
 * 基础右键菜单容器组件
 * 封装了菜单的定位、自动关闭、键盘事件等通用逻辑
 */
export const BaseRightMenu: React.FC<PropsWithChildren<BaseRightMenuProps>> = ({
	isopen,
	anchorPosition,
	onClose,
	ariaLabel,
	children,
}) => {
	const menuRef = useRef<HTMLDivElement | null>(null);
	const openedAtRef = useRef(0);
	const initialStyle = useMemo<CSSProperties | undefined>(() => {
		if (!anchorPosition) return undefined;
		const { top, left } = clampMenuPosition(anchorPosition, {
			width: 224,
			height: 320,
		});
		return { top, left };
	}, [anchorPosition]);

	useLayoutEffect(() => {
		if (!isopen || !menuRef.current || !anchorPosition) return;

		const { offsetWidth, offsetHeight } = menuRef.current;
		const { top, left } = clampMenuPosition(anchorPosition, {
			width: offsetWidth,
			height: offsetHeight,
		});

		menuRef.current.style.top = top + "px";
		menuRef.current.style.left = left + "px";
	}, [isopen, anchorPosition]);

	/**
	 * 监听菜单外部点击、滚动、窗口变化，自动关闭菜单
	 */
	useEffect(() => {
		if (isopen) openedAtRef.current = performance.now();

		const handleInteraction = (event: Event) => {
			if (
				event.type === "click" &&
				event instanceof MouseEvent &&
				event.button !== 0
			) {
				return;
			}
			if (
				event.type === "scroll" &&
				performance.now() - openedAtRef.current < 120
			) {
				return;
			}
			onClose();
		};

		if (isopen) {
			document.addEventListener("click", handleInteraction);
			document.addEventListener("scroll", handleInteraction, true);
			window.addEventListener("resize", handleInteraction);
		}

		return () => {
			document.removeEventListener("click", handleInteraction);
			document.removeEventListener("scroll", handleInteraction, true);
			window.removeEventListener("resize", handleInteraction);
		};
	}, [isopen, onClose]);

	// 打开时将焦点移到菜单容器以便支持键盘事件（例如 Esc 关闭）
	useEffect(() => {
		if (isopen && menuRef.current) {
			menuRef.current.focus({ preventScroll: true });
		}
	}, [isopen]);

	if (!isopen) return null;
	if (!anchorPosition) return null;

	return createPortal(
		<div
			role="menu"
			aria-label={ariaLabel}
			tabIndex={-1}
			className="skerry-context-menu fixed z-50 select-none"
			ref={menuRef}
			style={initialStyle}
			onClick={(e) => e.stopPropagation()}
			onContextMenu={(e) => {
				e.preventDefault();
				e.stopPropagation();
			}}
			onKeyDown={(e) => {
				if (e.key === "Escape" || e.key === "Esc") {
					onClose();
				}
			}}
		>
			<Paper
				className="skerry-context-menu-paper skerry-detail-more-menu-paper skerry-right-menu-paper"
				elevation={8}
				sx={{
					width: "224px",
					maxWidth: "calc(100vw - 16px)",
					borderRadius: "8px",
					textAlign: "left",
				}}
			>
				{children}
			</Paper>
		</div>,
		document.body,
	);
};
