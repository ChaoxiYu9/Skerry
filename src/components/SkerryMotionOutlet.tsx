import { Box } from "@mui/material";
import gsap from "gsap";
import {
	lazy,
	memo,
	Suspense,
	useEffect,
	useLayoutEffect,
	useRef,
} from "react";
import { Outlet, useLocation } from "react-router-dom";
import {
	loadAnnualReportPage,
	loadCollectionPage,
	loadLibrariesPage,
	loadPotatoImportPage,
	loadSettingsPage,
	preloadDetailPage,
} from "@/providers/routePreloads";
import { Home } from "@/pages/Home";

const Libraries = lazy(loadLibrariesPage);
const Collection = lazy(loadCollectionPage);
const AnnualReport = lazy(loadAnnualReportPage);
const PotatoImport = lazy(loadPotatoImportPage);
const Settings = lazy(loadSettingsPage);

const CachedHome = memo(function CachedHome() {
	return <Home />;
});

const CachedLibraries = memo(function CachedLibraries() {
	return <Libraries />;
});

const CachedCollection = memo(function CachedCollection() {
	return <Collection />;
});

const CachedAnnualReport = memo(function CachedAnnualReport() {
	return <AnnualReport />;
});

const CachedPotatoImport = memo(function CachedPotatoImport() {
	return <PotatoImport />;
});

const CachedSettings = memo(function CachedSettings() {
	return <Settings />;
});

const prefersReducedMotion = () =>
	typeof window !== "undefined" &&
	window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const topLevelPath = (pathname: string) => {
	const [firstSegment] = pathname.split("/").filter(Boolean);
	return firstSegment ? "/" + firstSegment : "/";
};

export function SkerryMotionOutlet() {
	const location = useLocation();
	const rootRef = useRef<HTMLDivElement | null>(null);
	const veilRef = useRef<HTMLDivElement | null>(null);
	const prevPathRef = useRef(location.pathname);
	const currentTopLevelPath = topLevelPath(location.pathname);
	const isHomeRoute = location.pathname === "/";
	const isLibrariesRoute = location.pathname === "/libraries";
	const isLibrariesSection =
		isLibrariesRoute || location.pathname.startsWith("/libraries/");
	const isLibraryDetailRoute = location.pathname.startsWith("/libraries/");
	const isNextUpDetailRoute = location.pathname.startsWith("/next-up/");
	const isDetailRoute = isLibraryDetailRoute || isNextUpDetailRoute;
	const isCollectionRoute = currentTopLevelPath === "/collection";
	const isReportRoute = currentTopLevelPath === "/report";
	const isPotatoImportRoute = currentTopLevelPath === "/potato-import";
	const isSettingsRoute = currentTopLevelPath === "/settings";
	const isPrimaryRoute =
		isHomeRoute ||
		isLibrariesSection ||
		isCollectionRoute ||
		isReportRoute ||
		isPotatoImportRoute ||
		isSettingsRoute;

	useLayoutEffect(() => {
		if (!isLibrariesSection) return;
		const base = rootRef.current?.querySelector<HTMLElement>(
			".skerry-library-route-base",
		);
		base?.style.removeProperty("visibility");
	}, [isLibrariesSection, isLibraryDetailRoute]);

	// Smooth, natural page transition when switching top-level routes
	useLayoutEffect(() => {
		const root = rootRef.current;
		const veil = veilRef.current;
		if (!root) return;

		const activeLayer = root.querySelector<HTMLElement>(
			"[data-skerry-route-layer].is-active",
		);

		if (veil) {
			gsap.set(veil, {
				autoAlpha: 0,
				pointerEvents: "none",
				clearProps: "transform,filter,willChange",
			});
		}

		if (activeLayer) {
			gsap.killTweensOf(activeLayer);
			gsap.set(activeLayer, {
				autoAlpha: 1,
				x: 0,
				y: 0,
				scale: 1,
				clearProps: "transform,opacity,filter,willChange",
			});
		}

		prevPathRef.current = location.pathname;
	}, [location.pathname, isDetailRoute]);

	useEffect(() => {
		if (location.pathname !== "/libraries") return;
		const idleCallback = window.requestIdleCallback?.(
			() => preloadDetailPage(),
			{ timeout: 1200 },
		);
		const timer = idleCallback
			? undefined
			: window.setTimeout(() => preloadDetailPage(), 350);
		return () => {
			if (idleCallback) window.cancelIdleCallback?.(idleCallback);
			if (timer) window.clearTimeout(timer);
		};
	}, [location.pathname]);

	useEffect(() => {
		gsap.ticker.lagSmoothing(500, 33);
		const pauseDuringResize = () => gsap.ticker.sleep();
		const resumeAfterResize = () => gsap.ticker.wake();
		window.addEventListener("skerry:window-drag-start", pauseDuringResize);
		window.addEventListener("skerry:window-drag-end", resumeAfterResize);
		window.addEventListener("skerry:window-resize-start", pauseDuringResize);
		window.addEventListener("skerry:window-resize-end", resumeAfterResize);
		return () => {
			window.removeEventListener("skerry:window-drag-start", pauseDuringResize);
			window.removeEventListener("skerry:window-drag-end", resumeAfterResize);
			window.removeEventListener("skerry:window-resize-start", pauseDuringResize);
			window.removeEventListener("skerry:window-resize-end", resumeAfterResize);
		};
	}, []);

	// Observe floating surfaces (Dialogs, Menus, Popovers, Modals) for natural opening motion
	useEffect(() => {
		const root = rootRef.current;
		if (!root || prefersReducedMotion()) return;

		const animatedFloating = new WeakSet<HTMLElement>();

		const syncSelectMenuWidth = (element: HTMLElement) => {
			if (!element.classList.contains("MuiMenu-paper")) return;
			const listbox = element.querySelector<HTMLElement>("[role='listbox'][id]");
			const listboxId = listbox?.id;
			if (!listboxId) return;

			const trigger = gsap.utils
				.toArray<HTMLElement>(
					".MuiSelect-select[aria-controls], [role='combobox'][aria-controls]",
				)
				.find(
					(candidate) => candidate.getAttribute("aria-controls") === listboxId,
				);
			if (!trigger) return;

			const triggerRect = trigger.getBoundingClientRect();
			const width = Math.round(triggerRect.width);
			if (width < 64) return;

			const viewportPadding = 12;
			const maxLeft = Math.max(
				viewportPadding,
				window.innerWidth - width - viewportPadding,
			);
			const left = Math.round(
				Math.min(Math.max(viewportPadding, triggerRect.left), maxLeft),
			);

			element.classList.add("skerry-select-menu-anchor-width");
			element.style.left = left + "px";
			element.style.right = "auto";
			element.style.transformOrigin = "left top";
			element.style.setProperty("--skerry-select-anchor-width", width + "px");
			element.style.setProperty("--skerry-select-anchor-left", left + "px");
		};

		const animateFloatingSurface = (element: HTMLElement) => {
			if (animatedFloating.has(element)) return;
			animatedFloating.add(element);
			syncSelectMenuWidth(element);

			gsap.fromTo(
				element,
				{
					autoAlpha: 0,
					y: 4,
					scale: 0.97,
				},
				{
					autoAlpha: 1,
					y: 0,
					scale: 1,
					duration: 0.18,
					ease: "power2.out",
					clearProps: "transform,opacity,visibility",
				},
			);
		};

		const selector =
			".MuiMenu-paper, .MuiPopover-paper, .MuiDialog-paper, .MuiSnackbar-root, .MuiAutocomplete-paper, .MuiPickersPopper-paper, .skerry-context-menu, .skerry-submenu-paper";

		const observeFloatingSurfaces = (node: Node) => {
			if (!(node instanceof HTMLElement)) return;
			if (node.matches(selector)) animateFloatingSurface(node);
			node
				.querySelectorAll<HTMLElement>(selector)
				.forEach(animateFloatingSurface);
		};

		const observer = new MutationObserver((mutations) => {
			if (document.visibilityState === "hidden") return;
			for (const mutation of mutations) {
				mutation.addedNodes.forEach((node) => {
					observeFloatingSurfaces(node);
				});
			}
		});

		observer.observe(document.body, { childList: true, subtree: true });

		return () => {
			observer.disconnect();
		};
	}, []);

	return (
		<Box
			ref={rootRef}
			className={
				isDetailRoute
					? "skerry-motion-root skerry-motion-root-contained"
					: isReportRoute
						? "skerry-motion-root skerry-motion-root-report"
						: "skerry-motion-root"
			}
		>
			<Box ref={veilRef} className="skerry-route-veil" aria-hidden="true" />
			<Box
				data-skerry-route-layer="home"
				className={
					isHomeRoute
						? "skerry-primary-route-layer skerry-home-route-cache is-active"
						: "skerry-primary-route-layer skerry-home-route-cache"
				}
				aria-hidden={!isHomeRoute}
			>
				<CachedHome />
			</Box>
			<Box
				data-skerry-route-layer="libraries"
				className={
					isLibrariesSection
						? "skerry-primary-route-layer skerry-library-route-frame skerry-library-route-cache is-active"
						: "skerry-primary-route-layer skerry-library-route-frame skerry-library-route-cache"
				}
				aria-hidden={!isLibrariesSection}
			>
				<Box
					className={
						isLibraryDetailRoute
							? "skerry-library-route-base is-detail-active"
							: "skerry-library-route-base"
					}
					aria-hidden={isLibraryDetailRoute}
				>
					<Suspense fallback={null}>
						<CachedLibraries />
					</Suspense>
				</Box>
				{isLibrariesSection ? <Outlet /> : null}
			</Box>
			<Box
				data-skerry-route-layer="collection"
				className={
					isCollectionRoute
						? "skerry-primary-route-layer is-active"
						: "skerry-primary-route-layer"
				}
				aria-hidden={!isCollectionRoute}
			>
				<Suspense fallback={null}>
					<CachedCollection />
				</Suspense>
			</Box>
			<Box
				data-skerry-route-layer="report"
				className={
					isReportRoute
						? "skerry-primary-route-layer skerry-report-route-layer is-active"
						: "skerry-primary-route-layer skerry-report-route-layer"
				}
				aria-hidden={!isReportRoute}
			>
				<Suspense fallback={null}>
					<CachedAnnualReport />
				</Suspense>
			</Box>
			<Box
				data-skerry-route-layer="potato-import"
				className={
					isPotatoImportRoute
						? "skerry-primary-route-layer is-active"
						: "skerry-primary-route-layer"
				}
				aria-hidden={!isPotatoImportRoute}
			>
				<Suspense fallback={null}>
					<CachedPotatoImport />
				</Suspense>
			</Box>
			<Box
				data-skerry-route-layer="settings"
				className={
					isSettingsRoute
						? "skerry-primary-route-layer is-active"
						: "skerry-primary-route-layer"
				}
				aria-hidden={!isSettingsRoute}
			>
				<Suspense fallback={null}>
					<CachedSettings />
				</Suspense>
			</Box>
			{isPrimaryRoute ? null : (
				<Box className="skerry-route-live-layer">
					<Outlet />
				</Box>
			)}
		</Box>
	);
}
