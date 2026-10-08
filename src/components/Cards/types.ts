import type React from "react";
import type { GameData } from "@/types";

export interface CardInteraction {
	onContextMenu?: (event: React.MouseEvent) => void;
	onClick: (target?: HTMLElement | null) => void;
	onDoubleClick?: () => void;
	useDelayedClick?: boolean;
}

export interface CardBatchState {
	selected: boolean;
}

export interface CardRemoveAction {
	title: string;
	onRemove: () => void;
}

export interface CardSortFieldOverlay {
	value: string;
}

export interface CardItemProps extends React.HTMLAttributes<HTMLDivElement> {
	game: GameData;
	displayName: string;
	imageLoading?: "eager" | "lazy";
	sortFieldOverlay?: CardSortFieldOverlay;
	interaction?: CardInteraction;
	batch?: CardBatchState;
	removeAction?: CardRemoveAction;
	dragHandleProps?: React.HTMLAttributes<HTMLDivElement>;
	isOverlay?: boolean;
	disableWarmup?: boolean;
	disableTooltips?: boolean;
	disableImageReveal?: boolean;
}

/** SortableCardItem 组件的 Props（不包含 style 和 ref） */
export type SortableCardItemProps = Omit<CardItemProps, "style" | "ref"> & {
	/** 是否禁用拖拽排序 */
	disabledSortable?: boolean;
};

/** 右键菜单位置状态 */
export interface MenuPosition {
	mouseX: number;
	mouseY: number;
	cardId: number;
}

/** 右键菜单控制器 */
export interface RightMenuHostHandle {
	open: (cardId: number, mouseX: number, mouseY: number) => void;
}
