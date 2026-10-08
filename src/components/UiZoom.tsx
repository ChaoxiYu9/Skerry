import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { applyUiZoom, MAX_UI_ZOOM_PERCENT, MIN_UI_ZOOM_PERCENT } from "@/services/uiZoom";
import { useStore } from "@/store/appStore";

export const UiZoom = () => {
	const [feedbackPercent, setFeedbackPercent] = useState<number | null>(null);

	useEffect(() => {
		if (!isTauri()) return;

		let disposed = false;
		let restoring = true;
		let unlisten: (() => void) | undefined;
		let feedbackTimeout: number | undefined;
		const savedPercent = useStore.getState().zoomPercent;

		const unsubscribeStore = useStore.subscribe((state, previousState) => {
			if (restoring || state.zoomPercent === previousState.zoomPercent) return;
			setFeedbackPercent(state.zoomPercent);
			window.clearTimeout(feedbackTimeout);
			feedbackTimeout = window.setTimeout(() => setFeedbackPercent(null), 1500);
		});

				// 监听键盘快捷键：Ctrl + '+' / '=' 放大，Ctrl + '-' 缩小，Ctrl + 0 复原
		const handleKeyDown = (e: KeyboardEvent) => {
			if (!e.ctrlKey && !e.metaKey) return;

			const isZoomIn =
				e.key === "+" ||
				e.key === "=" ||
				e.code === "Equal" ||
				e.code === "NumpadAdd";
			const isZoomOut =
				e.key === "-" ||
				e.key === "_" ||
				e.code === "Minus" ||
				e.code === "NumpadSubtract";
			const isZoomReset =
				e.key === "0" ||
				e.code === "Digit0" ||
				e.code === "Numpad0";

			if (isZoomIn) {
				e.preventDefault();
				const current = useStore.getState().zoomPercent;
				const next = Math.min(MAX_UI_ZOOM_PERCENT, Math.round((current + 5) / 5) * 5);
				void applyUiZoom(next);
			} else if (isZoomOut) {
				e.preventDefault();
				const current = useStore.getState().zoomPercent;
				const next = Math.max(MIN_UI_ZOOM_PERCENT, Math.round((current - 5) / 5) * 5);
				void applyUiZoom(next);
			} else if (isZoomReset) {
				e.preventDefault();
				void applyUiZoom(100);
			}
		};

		// 监听鼠标滚轮缩放：Ctrl + 滚轮（步进 5%）
		const handleWheel = (e: WheelEvent) => {
			if (!e.ctrlKey) return;
			e.preventDefault();
			const current = useStore.getState().zoomPercent;
			const step = e.deltaY < 0 ? 5 : -5;
			const next = Math.min(MAX_UI_ZOOM_PERCENT, Math.max(MIN_UI_ZOOM_PERCENT, current + step));
			void applyUiZoom(next);
		};

		window.addEventListener("keydown", handleKeyDown, { passive: false });
		window.addEventListener("wheel", handleWheel, { passive: false });

		void (async () => {
			try {
				unlisten = await listen<number>("webview-zoom-changed", (event) => {
					if (disposed || restoring) return;
					const percent = event.payload;
					if (!Number.isFinite(percent) || percent <= 0) return;
					useStore.getState().setZoomPercent(percent);
				});
				if (disposed) {
					unlisten?.();
					return;
				}
			} catch (error) {
				console.error("监听界面缩放失败:", error);
			}
			try {
				if (!disposed) await applyUiZoom(savedPercent);
			} catch (error) {
				console.error("恢复界面缩放失败:", error);
			} finally {
				restoring = false;
			}
		})();

		return () => {
			disposed = true;
			window.removeEventListener("keydown", handleKeyDown);
			window.removeEventListener("wheel", handleWheel);
			unsubscribeStore();
			unlisten?.();
			window.clearTimeout(feedbackTimeout);
		};
	}, []);

	if (feedbackPercent === null) return null;

	return (
		<div
			role="status"
			className="pointer-events-none fixed top-5 right-5 z-[2100] flex items-center gap-2 rounded-2xl border border-[var(--mui-palette-divider)] bg-[var(--mui-palette-background-paper)] px-4 py-2.5 text-sm font-bold tracking-wider text-[var(--mui-palette-text-primary)] shadow-2xl backdrop-blur-2xl transition-all duration-200 animate-in fade-in zoom-in-95"
			style={{
				boxShadow: "0 12px 36px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255, 255, 255, 0.08)",
			}}
		>
			<span className="inline-block h-2 w-2 rounded-full bg-[var(--mui-palette-primary-main)] shadow-[0_0_8px_var(--mui-palette-primary-main)]" />
			<span>缩放 {feedbackPercent}%</span>
		</div>
	);
};
