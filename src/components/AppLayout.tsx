import ArrowBackRoundedIcon from "@mui/icons-material/ArrowBackRounded";
import CategoryIcon from "@mui/icons-material/Category";
import FileUploadRoundedIcon from "@mui/icons-material/FileUploadRounded";
import GamesIcon from "@mui/icons-material/Games";
import HomeIcon from "@mui/icons-material/Home";
import InsightsRoundedIcon from "@mui/icons-material/InsightsRounded";
import KeyboardArrowUpRoundedIcon from "@mui/icons-material/KeyboardArrowUpRounded";
import LightModeRoundedIcon from "@mui/icons-material/LightModeRounded";
import DarkModeRoundedIcon from "@mui/icons-material/DarkModeRounded";
import { changeThemeWithTransition } from "@/utils/themeTransition";
import SettingsIcon from "@mui/icons-material/Settings";
import { Badge, Box, Fab, Fade } from "@mui/material";
import AppBar from "@mui/material/AppBar";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Toolbar from "@mui/material/Toolbar";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useRef, useState } from "react";
import { useColorScheme } from "@mui/material/styles";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import AddModal from "@/components/AddModal";
import { animateDetailClose } from "@/components/motion/detailLaunch";
import { SkerryMotionOutlet } from "@/components/SkerryMotionOutlet";
import { TaskManagerDialog } from "@/components/TaskManagerDialog";
import { Toolbars } from "@/components/Toolbar";
import { WindowControls, WindowDragRegion, beginWindowResizeOptimization } from "@/components/WindowFrame/WindowControls";
import {
	saveScrollPosition,
	scrollToTop,
} from "@/hooks/common/useScrollRestore";
import { setSkerryNavigate } from "@/providers/navigationBridge";
import { useStore } from "@/store/appStore";


/**
 * 自定义应用标题组件
 * @returns {JSX.Element}
 */
const CustomAppTitle = () => {
	return (
		<Stack
			direction="row"
			alignItems="center"
			spacing={2}
			className="select-none"
			sx={{ marginLeft: "-4px" }}
		>
			<Box
				component="img"
				alt="Skerry"
				src="/images/skerry.png"
				onDragStart={(event) => event.preventDefault()}
				sx={{
					width: 36,
					height: 36,
					borderRadius: "50%",
					objectFit: "cover",
					flexShrink: 0,
				}}
			/>
			<Box sx={{ minWidth: 0, display: "flex", alignItems: "center" }}>
				<Typography
					variant="h5"
					fontWeight={900}
					noWrap
					sx={{
						letterSpacing: 0,
						lineHeight: 1.25,
						fontFamily: '"Microsoft YaHei", "Segoe UI", sans-serif',
						pb: "2px",
					}}
				>
					Skerry
				</Typography>
			</Box>
		</Stack>
	);
};

const useSkerryBack = () => {
	const navigate = useNavigate();
	const location = useLocation();
	const currentGroupId = useStore((state) => state.currentGroupId);
	const selectedCategory = useStore((state) => state.selectedCategory);
	const setCurrentGroup = useStore((state) => state.setCurrentGroup);
	const setSelectedCategory = useStore((state) => state.setSelectedCategory);

	return useCallback(() => {
		if (location.pathname === "/collection") {
			if (selectedCategory !== null) {
				setSelectedCategory(null);
				return;
			}

			if (currentGroupId !== null) {
				setCurrentGroup(null);
				return;
			}
		}

		saveScrollPosition(location.pathname);
		animateDetailClose({ onComplete: () => navigate(-1) });
	}, [
		location.pathname,
		navigate,
		selectedCategory,
		currentGroupId,
		setCurrentGroup,
		setSelectedCategory,
	]);
};

const Header = () => (
	<AppBar
		color="inherit"
		position="fixed"
		className="print:hidden border-0 border-b border-solid shadow-none"
		sx={{
			borderColor: "divider",
			zIndex: 20,
			left: 0,
			right: 0,
			width: "auto",
			backgroundColor: "color-mix(in srgb, var(--skerry-canvas) 82%, transparent)",
			color: "text.primary",
			backdropFilter: "blur(18px) saturate(125%)",
		}}
	>
		<Toolbar
			className="bg-inherit !min-h-14"
			sx={{
				mx: {
					xs: -0.75,
					sm: -1,
				},
			}}
		>
			<Stack direction="row" alignItems="center" className="w-full">
				<CustomAppTitle />
				<WindowDragRegion />
				<Stack
					direction="row"
					alignItems="center"
					spacing={0.75}
					className="shrink-0"
				>
					<Toolbars />
					<WindowControls />
				</Stack>
			</Stack>
		</Toolbar>
	</AppBar>
);

const BackToTopButton = () => {
	const { t } = useTranslation();
	const location = useLocation();
	const [visible, setVisible] = useState(false);
	const visibleRef = useRef(false);
	const scrollFrameRef = useRef<number | null>(null);

	useEffect(() => {
		const container = document.querySelector<HTMLElement>("main");
		if (!container) return;

		const commitVisible = () => {
			scrollFrameRef.current = null;
			const nextVisible = container.scrollTop > 320;
			if (visibleRef.current === nextVisible) return;
			visibleRef.current = nextVisible;
			setVisible(nextVisible);
		};

		const updateVisible = () => {
			if (scrollFrameRef.current !== null) return;
			scrollFrameRef.current = window.requestAnimationFrame(commitVisible);
		};

		updateVisible();
		container.addEventListener("scroll", updateVisible, { passive: true });

		return () => {
			if (scrollFrameRef.current !== null) {
				window.cancelAnimationFrame(scrollFrameRef.current);
				scrollFrameRef.current = null;
			}
			container.removeEventListener("scroll", updateVisible);
		};
	}, []);

	const label = t("components.AppLayout.backToTop", "返回顶部");

	return (
		<Fade in={visible} unmountOnExit>
			<Tooltip title={label} enterDelay={1000}>
				<Fab
					color="primary"
					size="small"
					aria-label={label}
					className="print:hidden"
					onClick={() => scrollToTop(location.pathname)}
					sx={{
						position: "fixed",
						right: { xs: 16, sm: 24 },
						bottom: { xs: 16, sm: 24 },
						zIndex: 40,
					}}
				>
					<KeyboardArrowUpRoundedIcon />
				</Fab>
			</Tooltip>
		</Fade>
	);
};

/**
 * 应用主布局组件
 * 集成侧边栏、顶部工具栏、页面容器等，支持自定义标题、国际化和响应式布局。
 *
 * @component
 * @returns {JSX.Element} 应用主布局
 */
export const Layout: React.FC = () => {
	const location = useLocation();
	const navigate = useNavigate();
	const taskManagerOpen = useStore((s) => s.taskManagerOpen);
	const closeTaskManager = useStore((s) => s.closeTaskManager);
	const { t } = useTranslation();
	const handleBack = useSkerryBack();
	const { mode, setMode } = useColorScheme();
	const [activeScheme, setActiveScheme] = useState<"light" | "dark">(() => {
		if (typeof document !== "undefined") {
			const attr = document.documentElement.getAttribute("data-toolpad-color-scheme");
			if (attr === "light" || attr === "dark") return attr;
		}
		return mode === "light" ? "light" : "dark";
	});

	useEffect(() => {
		const updateScheme = () => {
			const current =
				document.documentElement.getAttribute("data-toolpad-color-scheme") ||
				(mode === "light" ? "light" : "dark");
			const resolved: "light" | "dark" = current === "light" ? "light" : "dark";
			setActiveScheme(resolved);
			if (document.documentElement.getAttribute("data-mui-color-scheme") !== resolved) {
				document.documentElement.setAttribute("data-mui-color-scheme", resolved);
			}
			if (document.documentElement.style.colorScheme !== resolved) {
				document.documentElement.style.colorScheme = resolved;
			}
		};
		updateScheme();

		const observer = new MutationObserver((mutations) => {
			for (const m of mutations) {
				if (m.attributeName === "data-toolpad-color-scheme" || m.attributeName === "data-mui-color-scheme") {
					updateScheme();
					break;
				}
			}
		});
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["data-toolpad-color-scheme", "data-mui-color-scheme"],
		});
		return () => observer.disconnect();
	}, [mode]);

	const isLightMode = activeScheme === "light" || mode === "light";

	useEffect(() => {
		const handleEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.repeat || event.defaultPrevented) {
				return;
			}

			const target = event.target;
			if (!(target instanceof Element)) return;
			if (
				target.closest(
					"input, textarea, select, [contenteditable='true'], [role='dialog'], [role='menu'], [role='listbox'], .MuiModal-root, .MuiMenu-paper, .MuiPopover-paper, .skerry-context-menu",
				)
			) {
				return;
			}

			event.preventDefault();
			handleBack();
		};

		window.addEventListener("keydown", handleEscape);
		return () => window.removeEventListener("keydown", handleEscape);
	}, [handleBack]);
	useEffect(() => {
		// Warm the compositor during idle time so the first native resize does
		// not pay the one-time cost of promoting glass surfaces to layers.
		const root = document.documentElement;
		let timer: number | undefined;
		const prewarm = () => {
			root.classList.add("skerry-window-prewarm", "skerry-window-resizing");
			window.requestAnimationFrame(() => {
				window.requestAnimationFrame(() => {
					root.classList.remove("skerry-window-prewarm", "skerry-window-resizing");
				});
			});
		};
		if (window.requestIdleCallback) {
			const idleId = window.requestIdleCallback(prewarm, { timeout: 2200 });
			return () => window.cancelIdleCallback(idleId);
		}
		timer = window.setTimeout(prewarm, 1400);
		return () => {
			if (timer !== undefined) window.clearTimeout(timer);
			root.classList.remove("skerry-window-prewarm", "skerry-window-resizing");
		};
	}, []);
	useEffect(() => {
		const root = document.documentElement;
		let endTimer: number | null = null;
		let disposed = false;
		const markResizing = () => {
			if (disposed) return;
			beginWindowResizeOptimization();
			if (endTimer !== null) window.clearTimeout(endTimer);
			endTimer = window.setTimeout(() => {
				endTimer = null;
				root.classList.remove("skerry-window-resizing");
				window.dispatchEvent(new Event("skerry:window-resize-end"));
			}, 140);
		};
		window.addEventListener("resize", markResizing, { passive: true });
		return () => {
			disposed = true;
			window.removeEventListener("resize", markResizing);
			if (endTimer !== null) window.clearTimeout(endTimer);
			root.classList.remove("skerry-window-resizing");
		};
	}, []);
	useEffect(() => setSkerryNavigate(navigate), [navigate]);
	const workspaceItems: Array<{ path: string; label: string; icon: React.ReactNode; badge?: boolean }> = [
		{ path: "/", label: t("app.NAVIGATION.home", "主页"), icon: <HomeIcon /> },
		{
			path: "/libraries",
			label: t("app.NAVIGATION.gameLibrary", "游戏库"),
			icon: <GamesIcon />,
		},
		{
			path: "/collection",
			label: t("app.NAVIGATION.collection", "收藏与集合"),
			icon: <CategoryIcon />,
		},
		{
			path: "/report",
			label: t("app.NAVIGATION.annualReport", "游戏总结"),
			icon: <InsightsRoundedIcon />,
		},
	];
	const systemItems = [
		{
			path: "/potato-import",
			label: t("app.NAVIGATION.potatoImport", "导入数据"),
			icon: <FileUploadRoundedIcon />,
		},
		{
			path: "/settings",
			label: t("app.NAVIGATION.settings", "系统设置"),
			icon: <SettingsIcon />,
		},
	];
	const isActive = (path: string) =>
		path === "/"
			? location.pathname === "/"
			: location.pathname.startsWith(path);
	const isLibraryRoute =
		location.pathname === "/libraries" ||
		location.pathname === "/collection";
	const isSettingsRoute =
		location.pathname === "/settings";
	const isHomeRoute = location.pathname === "/";
	const isReportRoute = location.pathname === "/report";
	const isDetailRoute =
		location.pathname.startsWith("/libraries/") ||
		location.pathname.startsWith("/next-up/");
	const navigateFromDock = (path: string) => {
		if (path === location.pathname) return;
		const commitNavigation = () =>
			animateDetailClose({ onComplete: () => navigate(path) });
		if (path === "/") {
			window.requestAnimationFrame(() => {
				window.requestAnimationFrame(commitNavigation);
			});
			return;
		}
		commitNavigation();
	};

	return (
		<>
			<AddModal />
			<TaskManagerDialog open={taskManagerOpen} onClose={closeTaskManager} />
			<Header />
			<Box
				className="skerry-shell"
				sx={{
					height: "100dvh",
					display: "flex",
					overflow: "hidden",
				}}
			>
				<Box
					component="aside"
					className="skerry-dock"
					sx={{
						display: "flex",
						flexDirection: "column",
						alignItems: "center",
						position: "sticky",
						top: "56px",
						marginTop: "56px",
						height: "calc(100dvh - 56px)",
						width: 64,
						flexShrink: 0,
						zIndex: 30,
						px: 1,
						py: 1.5,
						gap: 1.5,
					}}
				>
					<Tooltip
						title={t("components.AppLayout.back", "返回")}
						placement="right"
					>
						<IconButton
							aria-label={t("components.AppLayout.back", "返回")}
							onClick={handleBack}
							sx={{
								width: 42,
								height: 42,
								color: "text.secondary",
							}}
						>
							<ArrowBackRoundedIcon />
						</IconButton>
					</Tooltip>
					<Box className="skerry-dock-divider" />
					<Box
						className="skerry-dock-items"
						sx={{
							display: "flex",
							flexDirection: "column",
							alignItems: "center",
							justifyContent: "center",
							flex: 1,
							minHeight: 0,
							gap: 1.25,
						}}
					>
						{workspaceItems.map((item) => (
							<Tooltip key={item.path} title={item.label} placement="right">
								<IconButton
									aria-label={item.label}
									onClick={() => navigateFromDock(item.path)}
									className={isActive(item.path) ? "is-active" : ""}
									sx={{
										width: 42,
										height: 42,
										color: isActive(item.path)
											? "primary.main"
											: "text.secondary",
									}}
								>
									{item.badge ? (
										<Badge color="secondary" variant="dot" overlap="circular">
											{item.icon}
										</Badge>
									) : (
										item.icon
									)}
								</IconButton>
							</Tooltip>
						))}
					</Box>
					<Box className="skerry-dock-divider" />
					<Box
						className="skerry-dock-items"
						sx={{
							display: "flex",
							flexDirection: "column",
							alignItems: "center",
							flexShrink: 0,
							marginTop: "auto",
							gap: 1.25,
						}}
					>
						<Tooltip
							title={isLightMode ? "切换到深色模式" : "切换到浅色模式"}
							placement="right"
						>
							<IconButton
								aria-label={isLightMode ? "Switch to dark mode" : "Switch to light mode"}
							onClick={(event) => {
								const nextMode: "light" | "dark" = isLightMode ? "dark" : "light";
								changeThemeWithTransition(() => {
									document.documentElement.setAttribute("data-toolpad-color-scheme", nextMode);
									document.documentElement.setAttribute("data-mui-color-scheme", nextMode);
									document.documentElement.style.colorScheme = nextMode;
									try {
										localStorage.setItem("toolpad-mode", nextMode);
										localStorage.setItem("toolpad-color-scheme", nextMode);
									} catch {}
									setMode(nextMode);
									setActiveScheme(nextMode);
								}, event, nextMode);
							}}
								sx={{
									width: 42,
									height: 42,
									color: isLightMode ? "primary.main" : "text.secondary",
								}}
							>
								<Box
									className="skerry-theme-toggle-icon-wrap"
									sx={{
										position: "relative",
										width: 24,
										height: 24,
										display: "flex",
										alignItems: "center",
										justifyContent: "center",
									}}
								>
									<LightModeRoundedIcon
										className="skerry-theme-toggle-icon skerry-theme-sun"
										sx={{
											position: "absolute",
											fontSize: 24,
											color: "inherit",
											transform: isLightMode ? "rotate(0deg) scale(1)" : "rotate(90deg) scale(0)",
											opacity: isLightMode ? 1 : 0,
											transition: "transform 400ms cubic-bezier(0.34, 1.2, 0.64, 1), opacity 320ms ease",
											pointerEvents: "none",
										}}
									/>
									<DarkModeRoundedIcon
										className="skerry-theme-toggle-icon skerry-theme-moon"
										sx={{
											position: "absolute",
											fontSize: 24,
											color: "inherit",
											transform: !isLightMode ? "rotate(0deg) scale(1)" : "rotate(-90deg) scale(0)",
											opacity: !isLightMode ? 1 : 0,
											transition: "transform 400ms cubic-bezier(0.34, 1.2, 0.64, 1), opacity 320ms ease",
											pointerEvents: "none",
										}}
									/>
								</Box>
							</IconButton>
						</Tooltip>
						{systemItems.map((item) => (
							<Tooltip key={item.path} title={item.label} placement="right">
								<IconButton
									aria-label={item.label}
									onClick={() => navigateFromDock(item.path)}
									className={isActive(item.path) ? "is-active" : ""}
									sx={{
										width: 42,
										height: 42,
										color: isActive(item.path)
											? "primary.main"
											: "text.secondary",
									}}
								>
									{item.icon}
								</IconButton>
							</Tooltip>
						))}
					</Box>
				</Box>
				<Box
					component="main"
					className={
						isSettingsRoute
							? "skerry-main skerry-settings-page-scroll"
								: isLibraryRoute
									? "skerry-main library-page-scroll"
								: isReportRoute
										? "skerry-main skerry-report-page-scroll"
											: "skerry-main"
					}
					sx={{
						boxSizing: "border-box",
						minWidth: 0,
						flex: "1 1 0",
						width: "auto",
							minHeight: "100dvh",
							height: "100dvh",
							pt: { xs: 7, lg: 8 },
							px: isHomeRoute
								? 0
								: isDetailRoute
									? 0
									: { xs: 1.5, sm: 3, xl: 5 },
						pb: isDetailRoute || isHomeRoute || isLibraryRoute ? 0 : isReportRoute ? 2 : 3,
						overflow:
							isDetailRoute || isHomeRoute || isLibraryRoute
								? "hidden"
								: "auto",
						paddingLeft: isHomeRoute
							? "0px"
							: isLibraryRoute
								? "6px"
								: isReportRoute
									? undefined
									: "20px",
						paddingRight: isDetailRoute
							? "5px"
							: isLibraryRoute
								? "40px"
								: undefined,
					}}
				>
					<SkerryMotionOutlet />
					<BackToTopButton />
				</Box>
			</Box>
		</>
	);
};
export default Layout;
