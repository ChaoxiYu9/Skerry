import CategoryIcon from "@mui/icons-material/Category";
import FileUploadRoundedIcon from "@mui/icons-material/FileUploadRounded";
import GamesIcon from "@mui/icons-material/Games";
import HomeIcon from "@mui/icons-material/Home";
import InsightsRoundedIcon from "@mui/icons-material/InsightsRounded";
import SettingsIcon from "@mui/icons-material/Settings";
import { Box, CircularProgress } from "@mui/material";
import React, { lazy, Suspense, useEffect, useState } from "react";
import { createBrowserRouter, Outlet, type RouteObject } from "react-router-dom";
import App from "@/App";
import Layout from "@/components/AppLayout";
import {
	loadAnnualReportPage,
	loadCollectionPage,
	loadDetailPage,
	loadLibrariesPage,
	loadNextUpDetailPage,
	loadPotatoImportPage,
	loadSettingsPage,
} from "./routePreloads";
import { Home } from "@/pages/Home";

const Libraries = lazy(loadLibrariesPage);
const Detail = lazy(loadDetailPage);
const NextUpDetail = lazy(loadNextUpDetailPage);
const Collection = lazy(loadCollectionPage);
const AnnualReport = lazy(loadAnnualReportPage);
const PotatoImport = lazy(loadPotatoImportPage);
const Settings = lazy(loadSettingsPage);

const PageLoader = () => {
	const [visible, setVisible] = useState(false);

	useEffect(() => {
		const timer = window.setTimeout(() => setVisible(true), 420);
		return () => window.clearTimeout(timer);
	}, []);

	if (!visible) return null;

	return (
		<Box
			className="skerry-route-soft-loader"
			display="flex"
			justifyContent="center"
			alignItems="center"
			minHeight={72}
			sx={{ pointerEvents: "none", opacity: 0.58 }}
		>
			<CircularProgress size={20} thickness={4} />
		</Box>
	);
};

function SuspendedPage({
	component: Component,
}: {
	component: React.ComponentType;
}) {
	return (
		<Suspense fallback={<PageLoader />}>
			<Component />
		</Suspense>
	);
}

function LibrariesRouteFrame() {
	return <Outlet />;
}

function DetailRouteLayer() {
	return (
		<Box className="skerry-detail-route-layer">
			<SuspendedPage component={Detail} />
		</Box>
	);
}

export interface AppRoute {
	path: string;
	component: React.ComponentType;
	title: string;
	icon?: React.ReactNode;
	hideInMenu?: boolean;
	children?: AppRoute[];
	index?: boolean;
	navPattern?: string;
}

export const appRoutes: AppRoute[] = [
	{
		path: "",
		title: "app.NAVIGATION.home",
		component: Home,
		icon: <HomeIcon />,
	},
	{
		path: "libraries",
		title: "app.NAVIGATION.gameLibrary",
		icon: <GamesIcon />,
		navPattern: "libraries/:id",
		component: Libraries,
	},
	
	{
		path: "libraries/:id",
		title: "Game Detail",
		component: Detail,
		hideInMenu: true,
	},
	{
		path: "next-up/:id",
		title: "Next Up Detail",
		component: NextUpDetail,
		hideInMenu: true,
	},
	{
		path: "collection",
		title: "app.NAVIGATION.collection",
		icon: <CategoryIcon />,
		component: Collection,
	},
	{
		path: "report",
		title: "app.NAVIGATION.annualReport",
		icon: <InsightsRoundedIcon />,
		component: AnnualReport,
	},
	{
		path: "potato-import",
		title: "app.NAVIGATION.potatoImport",
		icon: <FileUploadRoundedIcon />,
		component: PotatoImport,
	},
	{
		path: "settings",
		title: "app.NAVIGATION.settings",
		component: Settings,
		icon: <SettingsIcon />,
	},
];

const buildRouterObjects = (routes: AppRoute[]): RouteObject[] => {
	const result: RouteObject[] = [];
	for (const route of routes) {
		if (route.path === "libraries") {
			result.push({
				path: route.path,
				element: <LibrariesRouteFrame />,
				children: [
					{
						path: ":id",
						element: <DetailRouteLayer />,
					},
				],
			});
			continue;
		}
		if (route.path === "libraries/:id") continue;
		if (route.path === "next-up/:id") {
			result.push({
				path: route.path,
				element: <DetailRouteLayer />,
			});
			continue;
		}
		if (route.index) {
			result.push({
				index: true,
				element: <SuspendedPage component={route.component} />,
			});
			continue;
		}

		result.push({
			path: route.path,
			element: <SuspendedPage component={route.component} />,
			children: route.children ? buildRouterObjects(route.children) : undefined,
		});
	}
	return result;
};

const routeConfig: RouteObject[] = [
	{
		Component: App,
		children: [
			{
				path: "/",
				Component: Layout,
				children: buildRouterObjects(appRoutes),
			},
		],
	},
];

export const routers = createBrowserRouter(routeConfig);
