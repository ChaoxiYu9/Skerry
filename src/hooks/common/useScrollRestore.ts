import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useLocation } from "react-router-dom";
import type { GridStateSnapshot } from "react-virtuoso";

const scrollPositions: Record<string, number> = {};
const virtuosoGridStates: Record<string, GridStateSnapshot | undefined> = {};
const VIRTUAL_SCROLL_CONTAINER_SELECTOR = "main";

export const getScrollPosition = (path: string): number => {
	return scrollPositions[path] ?? 0;
};

export const setScrollPosition = (path: string, position: number): void => {
	scrollPositions[path] = position;
	if (position === 0) {
		for (const key of Object.keys(virtuosoGridStates)) {
			if (key === path || key.startsWith(`${path}:`)) {
				delete virtuosoGridStates[key];
			}
		}
	}
};

export const saveScrollPosition = (path: string) => {
	const container = document.querySelector<HTMLElement>(
		VIRTUAL_SCROLL_CONTAINER_SELECTOR,
	);

	if (container && container.scrollHeight > container.clientHeight) {
		setScrollPosition(path, container.scrollTop);
	}
};

export const scrollToTop = (path: string) => {
	const container = document.querySelector<HTMLElement>(
		VIRTUAL_SCROLL_CONTAINER_SELECTOR,
	);

	if (!container) return;

	setScrollPosition(path, 0);
	container.scrollTo({ top: 0, behavior: "smooth" });
};

interface UseScrollRestoreOptions {
	/** 滚动容器选择器，默认 'main' */
	containerSelector?: string;
	/** 是否正在加载中 */
	isLoading?: boolean;
	/** 是否启用调试日志 */
	debug?: boolean;
}

const DEFAULT_OPTIONS: Required<Omit<UseScrollRestoreOptions, "isLoading">> = {
	containerSelector: "main",
	debug: false,
};

/**
 * 滚动位置还原 Hook
 * 等页面数据加载完成后一帧恢复；目标超过当前高度时回到顶部。
 */
export function useScrollRestore(
	scrollPath: string,
	options: UseScrollRestoreOptions = {},
) {
	const { containerSelector, isLoading, debug } = {
		...DEFAULT_OPTIONS,
		...options,
	};

	const location = useLocation();

	const cleanupRef = useRef<(() => void) | null>(null);
	const settledRef = useRef(false);
	const lastPathRef = useRef<string>("");

	const log = useCallback(
		(...args: Parameters<Console["log"]>) => {
			if (debug) console.log("[useScrollRestore]", ...args);
		},
		[debug],
	);

	useEffect(() => {
		if ("scrollRestoration" in window.history) {
			window.history.scrollRestoration = "manual";
		}
	}, []);

	// 提取滚动恢复逻辑为独立函数
	const performScrollRestore = useCallback(() => {
		// 路径变化时重置状态
		if (lastPathRef.current !== location.pathname) {
			settledRef.current = false;
			lastPathRef.current = location.pathname;
		}

		// 清理上一次的副作用
		if (cleanupRef.current) {
			log("Cleaning up previous effect");
			cleanupRef.current();
			cleanupRef.current = null;
		}

		if (isLoading) {
			log("Skipping: isLoading=true");
			return;
		}

		const container = document.querySelector<HTMLElement>(containerSelector);
		if (!container) {
			log("Container not found:", containerSelector);
			return;
		}

		const isTargetPath = location.pathname === scrollPath;
		const target = isTargetPath ? getScrollPosition(scrollPath) : 0;

		log("Target position:", target, "for path:", location.pathname);

		// 快速路径：目标为 0
		if (target === 0) {
			container.scrollTop = 0;
			settledRef.current = true;
			log("Scrolled to top immediately");
			return;
		}

		if (settledRef.current) {
			log("Already settled, skipping");
			return;
		}

		let frameId: number | null = null;
		let cancelled = false;
		let attempts = 0;
		const MAX_ATTEMPTS = 10;

		// 清理函数（先定义，避免在 performRestore 中引用未定义的变量）
		const cleanup = () => {
			cancelled = true;
			if (frameId !== null) {
				window.cancelAnimationFrame(frameId);
				frameId = null;
			}
		};

		// 执行滚动恢复（支持等待虚拟列表动态高度异步撑开）
		const performRestore = (reason: string) => {
			if (settledRef.current || cancelled) return;

			const maxScroll = Math.max(
				0,
				container.scrollHeight - container.clientHeight,
			);

			// 若目标位置超过当前最大可滚动高度，且尝试次数未超限，等待下一帧（等待虚拟网格首屏测量/挂载完成）
			if (target > maxScroll && attempts < MAX_ATTEMPTS) {
				attempts++;
				frameId = window.requestAnimationFrame(() => performRestore("retry frame " + attempts));
				return;
			}

			const restoreTarget = target > maxScroll ? maxScroll : target;

			const prevBehavior = container.style.scrollBehavior;
			container.style.scrollBehavior = "auto";
			container.scrollTop = restoreTarget;
			container.style.scrollBehavior = prevBehavior;

			settledRef.current = true;

			if (restoreTarget < target) {
				log(`⚠ Restored to maxScroll (${restoreTarget}/${target}) - ${reason}`);
			} else {
				log(`✓ Restored scroll to ${restoreTarget} - ${reason}`);
			}

			// 清理资源
			cleanup();
		};

		const restoreNextFrame = () => {
			if (settledRef.current || cancelled) return;
			performRestore("initial frame");
		};

		frameId = window.requestAnimationFrame(restoreNextFrame);

		cleanupRef.current = cleanup;
		return cleanup;
	}, [location.pathname, scrollPath, isLoading, containerSelector, log]);

	// 普通模式：使用 useEffect
	useEffect(() => {
		performScrollRestore();
	}, [performScrollRestore]);
}

interface UseVirtuosoGridRestoreOptions {
	columns: number;
	itemCount: number;
	rowHeight: number;
	scrollKey: string | null | undefined;
	containerSelector?: string;
	scrollParentElement?: HTMLElement | null;
	wrapperElement?: HTMLElement | null;
	preferScrollParentElement?: boolean;
}

export function useVirtuosoGridRestore({
	columns,
	itemCount,
	rowHeight,
	scrollKey,
	containerSelector = VIRTUAL_SCROLL_CONTAINER_SELECTOR,
	scrollParentElement,
	wrapperElement,
	preferScrollParentElement = false,
}: UseVirtuosoGridRestoreOptions) {
	const [scrollParent, setScrollParent] = useState<HTMLElement | null>(() =>
		typeof document === "undefined"
			? null
			: preferScrollParentElement
				? (scrollParentElement ?? null)
				: (scrollParentElement ??
					document.querySelector<HTMLElement>(containerSelector)),
	);
	const wrapperRef = useRef<HTMLDivElement>(null);
	const initialScrollTop = useMemo(
		() => (scrollKey ? getScrollPosition(scrollKey) : 0),
		[scrollKey],
	);
	const lastScrollTopRef = useRef(initialScrollTop);

	useLayoutEffect(() => {
		setScrollParent(
			preferScrollParentElement
				? (scrollParentElement ?? null)
				: (scrollParentElement ??
					document.querySelector<HTMLElement>(containerSelector)),
		);
	}, [containerSelector, preferScrollParentElement, scrollParentElement]);

	useEffect(() => {
		lastScrollTopRef.current = initialScrollTop;
	}, [initialScrollTop]);

	useEffect(() => {
		if (!scrollParent || !scrollKey) return;

		const wrapper = wrapperElement ?? wrapperRef.current;
		if (!wrapper) return;

		const wrapperOffsetTop =
			wrapper === scrollParent
				? 0
				: wrapper.getBoundingClientRect().top -
					scrollParent.getBoundingClientRect().top +
					scrollParent.scrollTop;

		const onScroll = () => {
			lastScrollTopRef.current = Math.max(
				0,
				scrollParent.scrollTop - wrapperOffsetTop,
			);
		};

		scrollParent.addEventListener("scroll", onScroll, { passive: true });

		return () => {
			scrollParent.removeEventListener("scroll", onScroll);
			setScrollPosition(scrollKey, lastScrollTopRef.current);
		};
	}, [scrollKey, scrollParent, wrapperElement]);
	const stateKey = scrollKey ? `${scrollKey}:${columns}:${itemCount}` : null;
	const state = stateKey ? virtuosoGridStates[stateKey] : undefined;
	const initialTopMostItemIndex =
		itemCount > 0 && initialScrollTop > 0
			? Math.min(
					itemCount - 1,
					Math.max(0, Math.floor(initialScrollTop / rowHeight) * columns),
				)
			: null;
	const restoreProps = state
		? { restoreStateFrom: state }
		: initialTopMostItemIndex !== null
			? {
					initialTopMostItemIndex,
				}
			: {};

	const handleStateChanged = useCallback(
		(nextState: GridStateSnapshot) => {
			if (!stateKey) return;
			virtuosoGridStates[stateKey] = nextState;
		},
		[stateKey],
	);

	return {
		restoreProps,
		scrollParent,
		stateChanged: handleStateChanged,
		wrapperRef,
	};
}
