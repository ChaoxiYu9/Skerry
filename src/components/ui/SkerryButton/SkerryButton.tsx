import {
	Button as MuiButton,
	type ButtonProps as MuiButtonProps,
} from "@mui/material";
import { forwardRef } from "react";

export type SkerryButtonLevel =
	| "primary"
	| "secondary"
	| "tertiary"
	| "ghost"
	| "danger";
export type SkerryButtonSize = "lg" | "md" | "sm";
export type SkerryButtonShape = "pill" | "square";

export interface SkerryButtonProps
	extends Omit<MuiButtonProps, "size" | "color" | "variant"> {
	level?: SkerryButtonLevel;
	size?: SkerryButtonSize;
	shape?: SkerryButtonShape;
	iconOnly?: boolean;
}

/**
 * SkerryButton - Skerry 全站单点真理设计系统按钮基元
 * - 5 种角色：A 主行动 | B 强工具 | C 普通操作 | D 轻文本 | danger 破坏警告
 * - 3 种标准尺寸：lg (40px, 8px微圆角) | md (36px, 胶囊或微圆角) | sm (28px)
 * - 深浅配色使用共享等级令牌；A/B 共享扫光，点击不缩放或滤镜变色
 */
export const SkerryButton = forwardRef<HTMLButtonElement, SkerryButtonProps>(
	function SkerryButton(
		{
			level = "tertiary",
			size = "md",
			shape = size === "lg" ? "square" : "pill",
			iconOnly = false,
			className = "",
			children,
			...props
		},
		ref,
	) {
		const classNames = [
			"skerry-btn",
			`skerry-btn-${level}`,
			{
				primary: "skerry-button-level-a",
				secondary: "skerry-button-level-b",
				tertiary: "skerry-button-level-c",
				ghost: "skerry-button-level-d",
				danger: "skerry-button-level-danger",
			}[level],
			`skerry-btn-${size}`,
			shape === "pill" ? "skerry-btn-pill" : "skerry-btn-square",
			iconOnly ? "skerry-btn-icon" : "",
			className,
		]
			.filter(Boolean)
			.join(" ");

		return (
			<MuiButton ref={ref} disableElevation className={classNames} {...props}>
				{children}
			</MuiButton>
		);
	},
);
