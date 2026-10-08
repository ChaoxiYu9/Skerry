import type { ComponentType } from "react";

type LazyPageModule = { default: ComponentType };
type PageLoader = () => Promise<LazyPageModule>;

const memoizePageLoader = (loader: PageLoader): PageLoader => {
	let promise: Promise<LazyPageModule> | null = null;
	return () => {
		promise ??= loader().catch((error) => {
			promise = null;
			throw error;
		});
		return promise;
	};
};

const preloadPages = async (loaders: PageLoader[]) => {
	await Promise.allSettled(loaders.map((loader) => loader()));
};

export const loadLibrariesPage = memoizePageLoader(() =>
	import("@/pages/LibrariesPage").then((module) => ({
		default: module.Libraries,
	})),
);

export const loadDetailPage = memoizePageLoader(() =>
	import("@/pages/Detail").then((module) => ({
		default: module.Detail,
	})),
);

export const loadNextUpDetailPage = memoizePageLoader(() =>
	import("@/pages/NextUpDetail").then((module) => ({
		default: module.NextUpDetail,
	})),
);

export const loadCollectionPage = memoizePageLoader(() =>
	import("@/pages/Collection").then((module) => ({
		default: module.Collection,
	})),
);

export const loadAnnualReportPage = memoizePageLoader(() =>
	import("@/pages/AnnualReport").then((module) => ({
		default: module.AnnualReport,
	})),
);

export const loadPotatoImportPage = memoizePageLoader(() =>
	import("@/pages/PotatoImport").then((module) => ({
		default: module.PotatoImport,
	})),
);

export const loadSettingsPage = memoizePageLoader(() =>
	import("@/pages/Settings").then((module) => ({
		default: module.Settings,
	})),
);


const coreRouteLoaders = [
	loadLibrariesPage,
	loadDetailPage,
	loadCollectionPage,
];

const secondaryRouteLoaders = [
	loadNextUpDetailPage,
	loadAnnualReportPage,
	loadPotatoImportPage,
	loadSettingsPage,
];

const routePreloaders = new Map<string, PageLoader>([
	["/libraries", loadLibrariesPage],
	["/collection", loadCollectionPage],
	["/report", loadAnnualReportPage],
	["/potato-import", loadPotatoImportPage],
	["/settings", loadSettingsPage],
]);

export const preloadDetailPage = () => {
	void loadDetailPage();
};

export const preloadNextUpDetailPage = () => {
	void loadNextUpDetailPage();
};

export const preloadRoutePath = (path: string) => {
	const [firstSegment] = path.split("/").filter(Boolean);
	const routePath = firstSegment ? "/" + firstSegment : "/";
	void routePreloaders.get(routePath)?.();
};

export const preloadCoreRoutes = () => preloadPages(coreRouteLoaders);

export const preloadSecondaryRoutes = () => preloadPages(secondaryRouteLoaders);

export const preloadAllRoutes = async () => {
	await preloadCoreRoutes();
	await preloadSecondaryRoutes();
};
