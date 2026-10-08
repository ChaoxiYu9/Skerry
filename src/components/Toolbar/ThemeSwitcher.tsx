import BrightnessAutoIcon from "@mui/icons-material/BrightnessAuto";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import LightModeIcon from "@mui/icons-material/LightMode";
import IconButton from "@mui/material/IconButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Tooltip from "@mui/material/Tooltip";
import { useColorScheme } from "@mui/material/styles";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { memo, type MouseEvent, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { changeThemeWithTransition } from "@/utils/themeTransition";

export type ThemeMode = "light" | "dark" | "system";

let lastAppliedWindowTheme: ThemeMode | null = null;

/**
 * 主题切换组件（亮色 / 暗色 / 跟随系统）
 */
export const ThemeSwitcher = memo(function ThemeSwitcher() {
	const { t } = useTranslation();
	const { mode, setMode, systemMode, allColorSchemes } = useColorScheme();
	const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
	const menuOpen = Boolean(anchorEl);

	const currentMode = (mode ?? "system") as ThemeMode;
	const resolvedMode = useMemo<"light" | "dark">(() => {
		if (currentMode === "system") return systemMode ?? "light";
		return currentMode;
	}, [currentMode, systemMode]);
	const isDualTheme = allColorSchemes.length > 1;

	useEffect(() => {
		if (!isTauri()) return;
		if (lastAppliedWindowTheme === currentMode) return;

		lastAppliedWindowTheme = currentMode;
		void getCurrentWindow()
			.setTheme(currentMode === "system" ? null : currentMode)
			.catch((error) => {
				lastAppliedWindowTheme = null;
				console.warn("更新窗口主题失败:", error);
			});
	}, [currentMode]);

	const handleOpenMenu = (event: MouseEvent<HTMLButtonElement>) => {
		setAnchorEl(event.currentTarget);
	};

	const handleCloseMenu = () => {
		setAnchorEl(null);
	};

	const handleSelectMode = async (nextMode: ThemeMode) => {
		if (nextMode === currentMode) return;
		changeThemeWithTransition(
			() => setMode(nextMode),
			undefined,
			nextMode === "light" ? "light" : nextMode === "dark" ? "dark" : undefined,
		);
		handleCloseMenu();
	};

	const currentIcon =
		currentMode === "system" ? (
			<BrightnessAutoIcon />
		) : resolvedMode === "dark" ? (
			<DarkModeIcon />
		) : (
			<LightModeIcon />
		);

	if (!isDualTheme) return null;

	return (
		<>
			<Tooltip title={t("components.Toolbar.theme", "主题")} enterDelay={1000}>
				<IconButton
					aria-label={t("components.Toolbar.theme", "主题")}
					onClick={handleOpenMenu}
					color="primary"
					size="small"
					className="!h-10 !w-10 !rounded-none"
				>
					{currentIcon}
				</IconButton>
			</Tooltip>
			<Menu
				anchorEl={anchorEl}
				open={menuOpen}
				onClose={handleCloseMenu}
				transitionDuration={0}
				anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
				transformOrigin={{ vertical: "top", horizontal: "right" }}
				PaperProps={{
					className: "skerry-theme-menu-paper",
				}}
			>
				<MenuItem
					selected={currentMode === "light"}
					onClick={() => handleSelectMode("light")}
				>
					<ListItemIcon>
						<LightModeIcon fontSize="small" />
					</ListItemIcon>
					<ListItemText>
						{t("components.Toolbar.themeLight", "浅色")}
					</ListItemText>
				</MenuItem>
				<MenuItem
					selected={currentMode === "dark"}
					onClick={() => handleSelectMode("dark")}
				>
					<ListItemIcon>
						<DarkModeIcon fontSize="small" />
					</ListItemIcon>
					<ListItemText>
						{t("components.Toolbar.themeDark", "深色")}
					</ListItemText>
				</MenuItem>
				<MenuItem
					selected={currentMode === "system"}
					onClick={() => handleSelectMode("system")}
				>
					<ListItemIcon>
						<BrightnessAutoIcon fontSize="small" />
					</ListItemIcon>
					<ListItemText>
						{t("components.Toolbar.themeSystem", "跟随系统")}
					</ListItemText>
				</MenuItem>
			</Menu>
		</>
	);
});