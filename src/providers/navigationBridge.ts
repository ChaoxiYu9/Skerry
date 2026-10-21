import type { NavigateFunction, NavigateOptions, To } from "react-router-dom";

let activeNavigate: NavigateFunction | null = null;

export function setSkerryNavigate(navigate: NavigateFunction | null) {
	activeNavigate = navigate;
	return () => {
		if (activeNavigate === navigate) activeNavigate = null;
	};
}

function toBrowserPath(to: To): string {
	if (typeof to === "string") return to;
	const pathname = to.pathname ?? window.location.pathname;
	const search = to.search ?? "";
	const hash = to.hash ?? "";
	return pathname + search + hash;
}

export function navigateSkerry(to: To | number, options?: NavigateOptions) {
	if (activeNavigate) {
		if (typeof to === "number") {
			activeNavigate(to);
		} else {
			activeNavigate(to, options);
		}
		return;
	}

	if (typeof window === "undefined") return;
	if (typeof to === "number") {
		window.history.go(to);
		return;
	}

	window.history.pushState(null, "", toBrowserPath(to));
	window.dispatchEvent(new PopStateEvent("popstate"));
}
