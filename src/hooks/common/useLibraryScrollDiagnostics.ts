import { save } from "@tauri-apps/plugin-dialog";
import { type RefObject, useEffect } from "react";
import { getCardImageCacheStats } from "@/services/game/cardImageCache";
import { fileService } from "@/services/invoke";

const DIAGNOSTICS_ENABLED = import.meta.env.VITE_SCROLL_DIAGNOSTICS === "1";
const MAX_EVENTS = 20_000;
const FRAME_GAP_THRESHOLD_MS = 24;

interface DiagnosticEvent {
	time: number;
	type: string;
	[key: string]: unknown;
}

function getRuntimeSnapshot() {
	return {
		userAgent: navigator.userAgent,
		platform: navigator.platform,
		viewport: { width: window.innerWidth, height: window.innerHeight },
		devicePixelRatio: window.devicePixelRatio,
		hardwareConcurrency: navigator.hardwareConcurrency,
		refreshRateHint: "not available from the Web Performance API",
	};
}

function shortScriptName(sourceURL: string): string {
	try {
		return (
			new URL(sourceURL, window.location.href).pathname.split("/").pop() ?? ""
		);
	} catch {
		return sourceURL.split(/[\\/]/).pop()?.split("?")[0] ?? "";
	}
}

export function useLibraryScrollDiagnostics(
	scrollRegionRef: RefObject<HTMLDivElement | null>,
	pageScroll: boolean,
): void {
	useEffect(() => {
		if (!DIAGNOSTICS_ENABLED) return;

		const scrollRegion = scrollRegionRef.current;
		if (!scrollRegion) return;

		const scrollContainer = pageScroll
			? (scrollRegion.closest<HTMLElement>(".skerry-main") ?? scrollRegion)
			: scrollRegion;
		// The virtual list mounts after its scroll parent is attached. Observe
		// the stable region so the first range and later recycling are included.
		const grid = scrollRegion;
		const startedAt = new Date().toISOString();
		const captureStartTime = performance.now();
		const timeOrigin = performance.timeOrigin;
		const events: DiagnosticEvent[] = [];
		let droppedEvents = 0;
		let scrollIdleTimer = 0;
		let scrollFrame = 0;
		let lastFrameTime = 0;
		let lastScrollTime = 0;
		let scrolling = false;
		const lastImageLoadTime = new WeakMap<HTMLImageElement, number>();

		const record = (type: string, data: Record<string, unknown> = {}) => {
			if (events.length >= MAX_EVENTS) {
				droppedEvents++;
				return;
			}
			events.push({
				time: Number(performance.now().toFixed(2)),
				type,
				...data,
			});
		};

		record("capture-start", {
			startedAt,
			timeOrigin,
			initialCardCount: grid?.querySelectorAll(".skerry-game-card").length ?? 0,
			loadedCoverCount:
				scrollRegion.querySelectorAll<HTMLImageElement>(".game-card-image")
					.length > 0
					? Array.from(
							scrollRegion.querySelectorAll<HTMLImageElement>(
								".game-card-image",
							),
						).filter((image) => image.complete && image.naturalWidth > 0).length
					: 0,
			runtime: getRuntimeSnapshot(),
		});

		const scheduleScrollFrame = () => {
			if (scrollFrame !== 0) return;
			scrollFrame = window.requestAnimationFrame((frameTime) => {
				scrollFrame = 0;
				if (lastFrameTime > 0) {
					const gap = frameTime - lastFrameTime;
					if (gap >= FRAME_GAP_THRESHOLD_MS) {
						record("scroll-frame-gap", {
							gapMs: Number(gap.toFixed(2)),
							scrollTop: Number(scrollContainer.scrollTop.toFixed(1)),
							cardCount:
								grid?.querySelectorAll(".skerry-game-card").length ?? 0,
						});
					}
				}
				lastFrameTime = frameTime;
				if (performance.now() - lastScrollTime < 300) {
					scheduleScrollFrame();
				} else {
					lastFrameTime = 0;
				}
			});
		};

		const onScroll = () => {
			lastScrollTime = performance.now();
			if (!scrolling) {
				scrolling = true;
				record("scroll-start", {
					scrollTop: Number(scrollContainer.scrollTop.toFixed(1)),
					cardCount: grid?.querySelectorAll(".skerry-game-card").length ?? 0,
				});
			}
			if (scrollIdleTimer) window.clearTimeout(scrollIdleTimer);
			scrollIdleTimer = window.setTimeout(() => {
				scrolling = false;
				record("scroll-end", {
					scrollTop: Number(scrollContainer.scrollTop.toFixed(1)),
				});
			}, 180);
			scheduleScrollFrame();
		};
		scrollContainer.addEventListener("scroll", onScroll, { passive: true });

		const observers: PerformanceObserver[] = [];
		const supportedTypes = PerformanceObserver.supportedEntryTypes ?? [];
		for (const type of [
			"longtask",
			"long-animation-frame",
			"event",
			"layout-shift",
		]) {
			if (!supportedTypes.includes(type)) continue;
			try {
				const observer = new PerformanceObserver((list) => {
					for (const entry of list.getEntries()) {
						if (type === "event" && entry.duration < 24) continue;
						if (type === "layout-shift") {
							const shift = entry as PerformanceEntry & {
								value?: number;
								hadRecentInput?: boolean;
							};
							record(type, {
								startTime: Number(entry.startTime.toFixed(2)),
								value: shift.value,
								hadRecentInput: shift.hadRecentInput,
							});
							continue;
						}
						const detail = entry as PerformanceEntry & {
							blockingDuration?: number;
							renderStart?: number;
							styleAndLayoutStart?: number;
							scripts?: Array<{
								sourceURL?: string;
								duration?: number;
								invokerType?: string;
							}>;
						};
						record(type, {
							startTime: Number(entry.startTime.toFixed(2)),
							duration: Number(entry.duration.toFixed(2)),
							blockingDuration: detail.blockingDuration,
							renderStart: detail.renderStart,
							styleAndLayoutStart: detail.styleAndLayoutStart,
							scripts: detail.scripts?.slice(0, 8).map((script) => ({
								name: script.sourceURL ? shortScriptName(script.sourceURL) : "",
								duration: script.duration,
								invokerType: script.invokerType,
							})),
						});
					}
				});
				observer.observe({ type, buffered: true });
				observers.push(observer);
			} catch {
				// Some WebView2 runtime versions expose an entry type but reject observing it.
			}
		}

		const mutationObserver = grid
			? new MutationObserver((mutations) => {
					let added = 0;
					let removed = 0;
					for (const mutation of mutations) {
						for (const node of mutation.addedNodes) {
							if (!(node instanceof HTMLElement)) continue;
							if (node.matches(".skerry-game-card")) added++;
							added += node.querySelectorAll(".skerry-game-card").length;
						}
						for (const node of mutation.removedNodes) {
							if (!(node instanceof HTMLElement)) continue;
							if (node.matches(".skerry-game-card")) removed++;
							removed += node.querySelectorAll(".skerry-game-card").length;
						}
					}
					if (added || removed) {
						record("card-dom-change", {
							added,
							removed,
							cardCount: grid.querySelectorAll(".skerry-game-card").length,
						});
					}
				})
			: null;
		if (grid)
			mutationObserver?.observe(grid, { childList: true, subtree: true });

		const onImageLoad = (event: Event) => {
			const image = event.target;
			if (
				!(image instanceof HTMLImageElement) ||
				!image.matches(".game-card-image")
			)
				return;
			lastImageLoadTime.set(image, performance.now());
			void image
				.decode()
				.then(() => {
					const loadTime = lastImageLoadTime.get(image);
					if (loadTime === undefined) return;
					lastImageLoadTime.delete(image);
					record("cover-image-decoded", {
						loadToDecodeMs: Number((performance.now() - loadTime).toFixed(2)),
						width: image.naturalWidth,
						height: image.naturalHeight,
					});
				})
				.catch(() => undefined);
		};
		scrollRegion.addEventListener("load", onImageLoad, true);

		const onKeyDown = (event: KeyboardEvent) => {
			if (!event.ctrlKey || !event.shiftKey || event.code !== "F12") return;
			event.preventDefault();
			event.stopImmediatePropagation();
			void (async () => {
				try {
					const timestamp = new Date()
						.toISOString()
						.replaceAll(":", "-")
						.replaceAll(".", "-");
					const outputPath = await save({
						title: "导出游戏库滚动诊断记录",
						defaultPath: `Skerry-scroll-diagnostic-${timestamp}.json`,
						filters: [
							{ name: "Skerry Scroll Diagnostic", extensions: ["json"] },
						],
					});
					if (!outputPath) return;
					const report = {
						format: "skerry-library-scroll-diagnostic-v1",
						startedAt,
						endedAt: new Date().toISOString(),
						cardCountAtExport:
							grid?.querySelectorAll(".skerry-game-card").length ?? 0,
						cardImageCache: getCardImageCacheStats(),
						droppedEvents,
						eventCount: events.length,
						elapsedMs: Number(
							(performance.now() - captureStartTime).toFixed(2),
						),
						events,
					};
					await fileService.writeFileBytes(
						outputPath,
						new TextEncoder().encode(JSON.stringify(report, null, 2)),
					);
					window.alert(
						`诊断记录已保存：\n${outputPath}\n\n事件数：${events.length}`,
					);
				} catch (error) {
					console.error("导出游戏库滚动诊断失败:", error);
					window.alert(`诊断记录导出失败：${String(error)}`);
				}
			})();
		};
		window.addEventListener("keydown", onKeyDown, true);

		return () => {
			window.removeEventListener("keydown", onKeyDown, true);
			scrollRegion.removeEventListener("load", onImageLoad, true);
			scrollContainer.removeEventListener("scroll", onScroll);
			if (scrollIdleTimer) window.clearTimeout(scrollIdleTimer);
			if (scrollFrame) window.cancelAnimationFrame(scrollFrame);
			for (const observer of observers) observer.disconnect();
			mutationObserver?.disconnect();
		};
	}, [pageScroll, scrollRegionRef]);
}
