import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import CropSquareRoundedIcon from "@mui/icons-material/CropSquareRounded";
import FilterNoneRoundedIcon from "@mui/icons-material/FilterNoneRounded";
import RemoveRoundedIcon from "@mui/icons-material/RemoveRounded";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isTauri } from "@tauri-apps/api/core";

const WINDOW_RESIZE_START_EVENT = "skerry:window-resize-start";

export function beginWindowResizeOptimization() {
	const root = document.documentElement;
	if (root.classList.contains("skerry-window-resizing")) return;
	root.classList.add("skerry-window-resizing");
	window.dispatchEvent(new Event(WINDOW_RESIZE_START_EVENT));
}

function scheduleWindowResizeFallback() {
	window.setTimeout(() => {
		const root = document.documentElement;
		if (!root.classList.contains("skerry-window-resizing")) return;
		root.classList.remove("skerry-window-resizing");
		window.dispatchEvent(new Event("skerry:window-resize-end"));
	}, 900);
}

const WINDOW_MAXIMIZED_EVENT = "skerry-window-maximized";
const WINDOW_TOGGLE_COOLDOWN_MS = 450;
const WINDOW_DRAG_START_EVENT = "skerry:window-drag-start";
const WINDOW_DRAG_END_EVENT = "skerry:window-drag-end";

export const WindowControls = memo(function WindowControls() {
	const { t } = useTranslation();
	const [maximized, setMaximized] = useState(false);
	const toggleInFlightRef = useRef(false);
	const lastToggleAtRef = useRef(0);

	useEffect(() => {
		if (!isTauri()) return;

		const appWindow = getCurrentWindow();
		let disposed = false;
		let lastMaximized = false;
		const applyMaximized = (nextMaximized: boolean) => {
			if (disposed || nextMaximized === lastMaximized) return;
			document.documentElement.classList.toggle(
				"skerry-window-maximized",
				nextMaximized,
			);
			lastMaximized = nextMaximized;
			setMaximized(nextMaximized);
		};
		const updateMaximized = async () => {
			try {
				applyMaximized(await appWindow.isMaximized());
			} catch (error) {
				console.warn("读取窗口最大化状态失败:", error);
			}
		};
		void updateMaximized();
		const handleMaximized = (event: Event) => {
			const nextMaximized = (event as CustomEvent<{
				maximized: boolean;
			}>).detail?.maximized;
			if (typeof nextMaximized === "boolean") {
				lastMaximized = nextMaximized;
				setMaximized(nextMaximized);
			}
		};
		window.addEventListener(WINDOW_MAXIMIZED_EVENT, handleMaximized);

		return () => {
			disposed = true;
			window.removeEventListener(WINDOW_MAXIMIZED_EVENT, handleMaximized);
			document.documentElement.classList.remove("skerry-window-maximized");
		};
	}, []);

	if (!isTauri()) return null;

	const toggleMaximize = async () => {
		if (
			toggleInFlightRef.current ||
			Date.now() - lastToggleAtRef.current < WINDOW_TOGGLE_COOLDOWN_MS
		) {
			return;
		}
		toggleInFlightRef.current = true;
		lastToggleAtRef.current = Date.now();
		const appWindow = getCurrentWindow();
		const nextMaximized = !maximized;
		setMaximized(nextMaximized);
		beginWindowResizeOptimization();
		try {
			await appWindow.toggleMaximize();
			scheduleWindowResizeFallback();
			window.dispatchEvent(
				new CustomEvent(WINDOW_MAXIMIZED_EVENT, {
					detail: { maximized: nextMaximized },
				}),
			);
		} catch (error) {
			setMaximized(maximized);
			document.documentElement.classList.remove("skerry-window-resizing");
			window.dispatchEvent(new Event("skerry:window-resize-end"));
			console.error("切换窗口大小失败:", error);
		} finally {
			toggleInFlightRef.current = false;
		}
	};

	return (
		<Stack
			direction="row"
			spacing={0}
			className="self-stretch skerry-window-chrome"
		>
			<Tooltip title={t("components.AppLayout.minimizeWindow", "最小化")}>
				<IconButton
					aria-label={t("components.AppLayout.minimizeWindow", "最小化")}
					onClick={() => void getCurrentWindow().minimize()}
					className="!h-10 !w-11 !rounded-none"
				>
					<RemoveRoundedIcon fontSize="small" />
				</IconButton>
			</Tooltip>
			<Tooltip
				title={
					maximized
						? t("components.AppLayout.restoreWindow", "还原窗口")
						: t("components.AppLayout.maximizeWindow", "最大化")
				}
			>
				<IconButton
					aria-label={
						maximized
							? t("components.AppLayout.restoreWindow", "还原窗口")
							: t("components.AppLayout.maximizeWindow", "最大化")
					}
					onClick={() => void toggleMaximize()}
					className="!h-10 !w-11 !rounded-none"
				>
					{maximized ? (
						<FilterNoneRoundedIcon fontSize="small" />
					) : (
						<CropSquareRoundedIcon fontSize="small" />
					)}
				</IconButton>
			</Tooltip>
			<Tooltip title={t("components.AppLayout.closeWindow", "关闭")}>
				<IconButton
					aria-label={t("components.AppLayout.closeWindow", "关闭")}
					onClick={() => void getCurrentWindow().close()}
					className="!h-10 !w-11 !rounded-none hover:!bg-[#c42b1c] hover:!text-white"
				>
					<CloseRoundedIcon fontSize="small" />
				</IconButton>
			</Tooltip>
		</Stack>
	);
});

/**
 * Keeps frameless-window dragging local to the empty title-bar area. Using
 * the Tauri helper directly avoids the injected drag-region listener, which
 * otherwise handles the same double click through a second IPC path.
 */
export const WindowDragRegion = memo(function WindowDragRegion() {
	const maximizeKnownRef = useRef<boolean | null>(null);
	const toggleInFlightRef = useRef(false);
	const lastToggleAtRef = useRef(0);
	const dragSafetyTimerRef = useRef<number | null>(null);

	const endDragOptimization = () => {
		if (dragSafetyTimerRef.current !== null) {
			window.clearTimeout(dragSafetyTimerRef.current);
			dragSafetyTimerRef.current = null;
		}
		document.documentElement.classList.remove("skerry-window-dragging");
		window.dispatchEvent(new Event(WINDOW_DRAG_END_EVENT));
	};

	const beginDragOptimization = () => {
		document.documentElement.classList.add("skerry-window-dragging");
		window.dispatchEvent(new Event(WINDOW_DRAG_START_EVENT));
		if (dragSafetyTimerRef.current !== null) {
			window.clearTimeout(dragSafetyTimerRef.current);
		}
		dragSafetyTimerRef.current = window.setTimeout(
			endDragOptimization,
			15000,
		);
	};

	useEffect(() => {
		window.addEventListener("mouseup", endDragOptimization, true);
		window.addEventListener("blur", endDragOptimization);
		document.addEventListener("visibilitychange", endDragOptimization);
		return () => {
			window.removeEventListener("mouseup", endDragOptimization, true);
			window.removeEventListener("blur", endDragOptimization);
			document.removeEventListener("visibilitychange", endDragOptimization);
			endDragOptimization();
		};
	}, []);

	useEffect(() => {
		if (!isTauri()) return;
		const appWindow = getCurrentWindow();
		void appWindow
			.isMaximized()
			.then((value) => {
				maximizeKnownRef.current = value;
			})
			.catch(() => undefined);
	}, []);

	const toggleMaximize = async () => {
		if (
			!isTauri() ||
			toggleInFlightRef.current ||
			Date.now() - lastToggleAtRef.current < WINDOW_TOGGLE_COOLDOWN_MS
		) {
			return;
		}
		toggleInFlightRef.current = true;
		lastToggleAtRef.current = Date.now();
		const appWindow = getCurrentWindow();
		beginWindowResizeOptimization();
		try {
			const currentMaximized =
				maximizeKnownRef.current ?? (await appWindow.isMaximized());
			await appWindow.toggleMaximize();
			scheduleWindowResizeFallback();
			const nextMaximized = !currentMaximized;
			maximizeKnownRef.current = nextMaximized;
			window.dispatchEvent(
				new CustomEvent(WINDOW_MAXIMIZED_EVENT, {
					detail: { maximized: nextMaximized },
				}),
			);
		} catch (error) {
			document.documentElement.classList.remove("skerry-window-resizing");
			window.dispatchEvent(new Event("skerry:window-resize-end"));
			console.error("切换窗口大小失败:", error);
		} finally {
			toggleInFlightRef.current = false;
		}
	};

	const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
		if (event.button !== 0 || !isTauri()) return;
		event.preventDefault();
		if (event.detail >= 2) {
			void toggleMaximize();
			return;
		}
		const appWindow = getCurrentWindow();
		void appWindow
			.isMaximized()
			.then((maximized) => {
				if (maximized) return;
				beginDragOptimization();
				const dragPromise = appWindow.startDragging();
				void dragPromise.catch((error) => {
					console.warn("拖动窗口失败:", error);
				});
			})
			.catch((error) => {
				console.warn("读取窗口最大化状态失败:", error);
			});
	};

	return (
		<Box
			aria-hidden="true"
			onMouseDown={handleMouseDown}
			className="h-10 min-w-6 flex-1 self-stretch select-none skerry-window-drag-region"
		/>
	);
});