import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useSearchParams } from "react-router-dom";
import type { DetailPanel } from "./detailSceneCapabilities";

export function useDetailPanelNavigation(panels: readonly DetailPanel[]) {
	const [searchParams, setSearchParams] = useSearchParams();
	const requestedPanel = searchParams.get("panel");
	const detailPanel: DetailPanel =
		requestedPanel === "edit" ||
		requestedPanel === "save" ||
		requestedPanel === "review" ||
		requestedPanel === "stats"
			? requestedPanel
			: "overview";
	const setDetailPanel = useCallback(
		(panel: DetailPanel) => {
			setSearchParams(panel === "overview" ? {} : { panel }, { replace: true });
		},
		[setSearchParams],
	);
	const prevPanelRef = useRef<DetailPanel>(detailPanel);
	const [slideDirection, setSlideDirection] = useState<"forward" | "backward">(
		"forward",
	);

	useEffect(() => {
		if (prevPanelRef.current !== detailPanel) {
			const previousIndex = panels.indexOf(prevPanelRef.current);
			const currentIndex = panels.indexOf(detailPanel);
			setSlideDirection(currentIndex >= previousIndex ? "forward" : "backward");
			prevPanelRef.current = detailPanel;
		}
	}, [detailPanel, panels]);

	const tabRefs = useRef<Record<string, HTMLSpanElement | null>>({});
	const [indicatorStyle, setIndicatorStyle] = useState<{
		left: number;
		width: number;
		ready: boolean;
	}>({ left: 0, width: 0, ready: false });

	const updateIndicator = useCallback(() => {
		const element = tabRefs.current[detailPanel];
		if (!element) return;
		setIndicatorStyle({
			left: element.offsetLeft,
			width: element.offsetWidth,
			ready: true,
		});
	}, [detailPanel]);

	useLayoutEffect(updateIndicator, [updateIndicator]);

	useEffect(() => {
		window.addEventListener("resize", updateIndicator);
		return () => window.removeEventListener("resize", updateIndicator);
	}, [updateIndicator]);

	return {
		detailPanel,
		setDetailPanel,
		slideDirection,
		tabRefs,
		indicatorStyle,
	};
}
