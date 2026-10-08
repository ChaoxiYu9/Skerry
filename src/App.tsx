import "./App.css";
import "@/providers/i18n";
import { isTauri } from "@tauri-apps/api/core";
import { SnackbarProvider } from "notistack";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Outlet } from "react-router-dom";
import WindowsHandler from "@/components/Windows";
import { UiZoom } from "@/components/UiZoom";
import { appRoutes } from "@/providers/router"; // 引入新的统一配置
import { SnackbarUtilsConfigurator } from "@/providers/snackBar";
import { ToolpadReactRouterAppProvider } from "@/providers/ToolpadReactRouterAppProvider";
import { initBgmAuthRefresh } from "@/services/oauth/bgmAuthSession";
import { initHikarinagiAuthRefresh } from "@/services/oauth/hikarinagiAuthSession";
import { initWebviewKeepAlive } from "@/providers/webviewKeepAlive";

const App: React.FC = () => {
	const { t } = useTranslation();

	useEffect(() => {
		initWebviewKeepAlive();
		void initBgmAuthRefresh();
		void initHikarinagiAuthRefresh();
	}, []);

	// 从路由配置动态生成导航菜单
	const visibleRoutes = appRoutes.filter((route) => !route.hideInMenu);
	const routeItem = (route: (typeof visibleRoutes)[number]) => ({
		segment: route.path,
		title: t(route.title),
		icon: route.icon,
		pattern: route.navPattern,
	});
	const byPath = (path: string) =>
		visibleRoutes.find((route) => route.path === path);
	const Navigation = [
		{ kind: "header" as const, title: t("app.navigation.workspace", "工作区") },
		...["", "libraries", "collection", "report"]
			.map((path) => byPath(path))
			.filter((route): route is NonNullable<typeof route> => Boolean(route))
			.map(routeItem),
		{ kind: "divider" as const },
		{ kind: "header" as const, title: t("app.navigation.system", "系统") },
		...["settings", "potato-import"]
			.map((path) => byPath(path))
			.filter((route): route is NonNullable<typeof route> => Boolean(route))
			.map(routeItem),
	];

	return (
		<SnackbarProvider
			maxSnack={3}
			autoHideDuration={3000}
			anchorOrigin={{ vertical: "top", horizontal: "center" }}
		>
			<SnackbarUtilsConfigurator />
			<ToolpadReactRouterAppProvider navigation={Navigation}>
				{isTauri() && <WindowsHandler />}
												<UiZoom />
				<Outlet />
			</ToolpadReactRouterAppProvider>
		</SnackbarProvider>
	);
};

export default App;
