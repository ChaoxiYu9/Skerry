/**
 * Game detail page. The banner and cover stay side by side above the game information.
 */

import AddRoundedIcon from "@mui/icons-material/AddRounded";
import ArrowDropDownRoundedIcon from "@mui/icons-material/ArrowDropDownRounded";
import CropFreeRoundedIcon from "@mui/icons-material/CropFreeRounded";
import DescriptionRoundedIcon from "@mui/icons-material/DescriptionRounded";
import FolderOpenRoundedIcon from "@mui/icons-material/FolderOpenRounded";
import RestartAltRoundedIcon from "@mui/icons-material/RestartAltRounded";
import WallpaperRoundedIcon from "@mui/icons-material/WallpaperRounded";
import Tooltip from "@mui/material/Tooltip";
import {
	Box,
	Button,
	CircularProgress,
	IconButton,
	ListItemIcon,
	ListItemText,
	Menu,
	MenuItem,
	Typography,
} from "@mui/material";
import gsap from "gsap";
import {
	Fragment,
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { CollectionPickerDialog } from "@/components/Collection";
import { LaunchModal } from "@/components/LaunchModal";
import "./styles/detail-buttons.css";
import { MoreButton } from "@/components/Toolbar";
import { useProxyImageUrlResolver } from "@/hooks/common/useProxyImageUrlResolver";
import { useUpdateGame } from "@/hooks/queries/useGames";
import { useUpdatePlayStatus } from "@/hooks/queries/usePlayStatus";
import { settingsKeys, useAllSettings } from "@/hooks/queries/useSettings";
import { NextUpImportDialog } from "@/pages/NextUpDetail/NextUpImportDialog";
import { getNextUpAssetUrl } from "@/pages/NextUpDetail/nextUpAssets";
import { useNextUpGameLibraryImport } from "@/pages/NextUpDetail/useNextUpGameLibraryImport";
import { queryClient } from "@/providers/queryClient";
import { snackbar } from "@/providers/snackBar";
import { getCgIdentifierUrl } from "@/services/game/customCover";
import { fileService } from "@/services/invoke";
import { useStore } from "@/store/appStore";
import type { BannerFocus, GameData, GameStaffRole } from "@/types";
import { PlayStatus } from "@/types/collection";
import { getUserErrorMessage } from "@/utils/errors";
import {
	getGameBanner,
	getGameCover,
	getGameDetailBackdrop,
	getGameDisplayName,
} from "@/utils/game";
import { getDeveloperNames } from "@/utils/game/gameIndex";
import { getTagDisplayName } from "@/utils/game/tagTranslation";
import {
	DETAIL_SCENE_CAPABILITIES,
	type DetailSceneKind,
} from "./detailSceneCapabilities";
import { DetailGalleryDialog } from "./game-info/DetailGalleryDialog";
import { LibraryGameEdit } from "./game-info/LibraryGameEdit";
import { useDetailMetadataDraft } from "./game-info/useDetailMetadataDraft";
import { NextUpGameReview } from "./next-up/NextUpGameReview";
import { Review } from "./Review";
import { SaveData } from "./SaveData";
import { useDetailSceneModel } from "./useDetailSceneModel";
import { useDetailPanelNavigation } from "./useDetailPanelNavigation";
import { useDetailScenePersistence } from "./useDetailScenePersistence";

const DETAIL_PLAY_STATUS_CONFIG: Record<
	number,
	{ label: string; dotClass: string; colorClass: string }
> = {
	[PlayStatus.WISH]: {
		label: "想玩",
		dotClass: "play-status-icon-wish",
		colorClass: "status-badge-wish",
	},
	[PlayStatus.PLAYING]: {
		label: "在玩",
		dotClass: "play-status-icon-playing",
		colorClass: "status-badge-playing",
	},
	[PlayStatus.PLAYED]: {
		label: "通关",
		dotClass: "play-status-icon-played",
		colorClass: "status-badge-played",
	},
	[PlayStatus.ON_HOLD]: {
		label: "搁置",
		dotClass: "play-status-icon-hold",
		colorClass: "status-badge-hold",
	},
	[PlayStatus.DROPPED]: {
		label: "弃坑",
		dotClass: "play-status-icon-dropped",
		colorClass: "status-badge-dropped",
	},
};

import { ImageFocusCropperDialog } from "./ImageFocusCropperDialog";
import { GameStatsOverview } from "./stats/GameStatsOverview";

const prefersReducedMotion = () =>
	typeof window !== "undefined" &&
	window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const DEFAULT_COLLAPSED_SUMMARY_HEIGHT = 94;
const clampBackdropFocus = (value: unknown) => {
	const numeric =
		typeof value === "number" && Number.isFinite(value) ? value : 50;
	return Math.min(100, Math.max(0, numeric));
};

const normalizeBackdropFocus = (focus?: BannerFocus | null): BannerFocus => ({
	x: clampBackdropFocus(focus?.x),
	y: clampBackdropFocus(focus?.y),
});

function formatScoreValue(value: number | null | undefined) {
	return typeof value === "number" && value > 0 ? value.toFixed(1) : "-";
}

function hasRating(value: number | null | undefined) {
	return typeof value === "number" && value > 0;
}

function formatCompactPlaytime(
	val?: string | number | null,
	fallback = "0m",
): string {
	if (!val) return fallback;
	if (typeof val === "number") {
		if (val <= 0) return fallback;
		if (val < 60) return `${val}m`;
		const h = val / 60;
		return h >= 10 ? `${Math.round(h)}h` : `${h.toFixed(1)}h`;
	}
	const hMatch = val.match(/(\d+)\s*小时/);
	const mMatch = val.match(/(\d+)\s*分钟/);
	const hours = hMatch ? parseInt(hMatch[1], 10) : 0;
	const minutes = mMatch ? parseInt(mMatch[1], 10) : 0;
	const totalMins = hours * 60 + minutes;
	if (totalMins <= 0) return fallback;
	if (totalMins < 60) return `${totalMins}m`;
	const totalHours = totalMins / 60;
	return totalHours >= 10
		? `${Math.round(totalHours)}h`
		: `${totalHours.toFixed(1)}h`;
}

function renderSummaryWithLineBreaks(value?: string): ReactNode {
	const normalized = (value ?? "")
		.replace(/\r\n?/g, "\n")
		.replace(/\\r\\n/g, "\n")
		.replace(/\\r/g, "\n")
		.replace(/\\n/g, "\n");
	if (!normalized) return null;

	const lines = normalized.split("\n");
	return lines.map((line, index) => (
		<Fragment key={index}>
			{line}
			{index < lines.length - 1 && <br />}
		</Fragment>
	));
}

export const Detail: React.FC = () => {
	const location = useLocation();
	const sceneKind: DetailSceneKind = location.pathname.startsWith("/next-up/")
		? "next-up"
		: "library";
	const capabilities = DETAIL_SCENE_CAPABILITIES[sceneKind];
	const routeId = Number(location.pathname.split("/").at(-1));
	const id = sceneKind === "next-up" ? -Math.abs(routeId) : routeId;
	const { t } = useTranslation();
	const detailMotionRef = useRef<HTMLDivElement | null>(null);
	const updateGameMutation = useUpdateGame();
	const resolveImageUrl = useProxyImageUrlResolver();
	const { tagTranslation, setSelectedGameId } = useStore(
		useShallow((state) => ({
			tagTranslation: state.tagTranslation,
			setSelectedGameId: state.setSelectedGameId,
		})),
	);
	const detailScene = useDetailSceneModel({
		sceneKind,
		gameId: id,
		updateLibraryGame: updateGameMutation.mutateAsync,
	});
	const {
		selectedGame,
		rawSelectedGame,
		rawGameForEdit,
		isLoadingSelectedGame,
		gameStatsQuery,
		nextUpGame,
		nextUpRawGame,
		updateNextUpGame,
	} = detailScene;
	const persistCustomData = useDetailScenePersistence({
		sceneKind,
		gameId: id,
		updateLibraryGame: updateGameMutation.mutateAsync,
	});
	const { importGame: handleImportNextUpGame, isAddingGame } =
		useNextUpGameLibraryImport(nextUpGame);
	const { data: appSettings } = useAllSettings({ enabled: true });
	const activeCustomRoot =
		appSettings?.detail_backdrop_path ??
		(queryClient.getQueryData(settingsKeys.allSettings()) as any)
			?.detail_backdrop_path;
	const [collectionDialogOpen, setCollectionDialogOpen] = useState(false);
	const [playStatusMenuAnchor, setPlayStatusMenuAnchor] =
		useState<null | HTMLElement>(null);
	const updatePlayStatusMutation = useUpdatePlayStatus();

	const handlePlayStatusSelect = useCallback(
		async (newStatus: PlayStatus) => {
			setPlayStatusMenuAnchor(null);
			if (!capabilities.canChangePlayStatus) return;
			try {
				await updatePlayStatusMutation.mutateAsync({
					gameId: id,
					newStatus,
				});
				snackbar.success("游玩状态已更新");
			} catch (err) {
				snackbar.error("更新游玩状态失败");
			}
		},
		[id, capabilities.canChangePlayStatus, updatePlayStatusMutation],
	);
	const [sourceUpdateOpen, setSourceUpdateOpen] = useState(false);
	const [, setSelectedTags] = useState<string[]>([]);
	const [manageCgDialogOpen, setManageCgDialogOpen] = useState(false);
	const customCgs: string[] = (selectedGame?.custom_data as any)?.cgs ?? [];
	const importedScreenshotUrls: string[] =
		selectedGame?.custom_data?.imported_screenshot_urls ?? [];
	const hiddenSourceScreenshotUrls: string[] =
		selectedGame?.custom_data?.hidden_source_screenshots ?? [];
	const customCgUrls = customCgs.map((entry) =>
		getCgIdentifierUrl(id, entry, activeCustomRoot),
	);
	const sourceScreenshots: string[] = (selectedGame?.screenshots ?? []).filter(
		(url) =>
			!importedScreenshotUrls.includes(url) &&
			!hiddenSourceScreenshotUrls.includes(url),
	);
	const [summaryExpanded, setSummaryExpanded] = useState(false);
	const summaryContainerRef = useRef<HTMLDivElement | null>(null);
	const summaryPrevHeightRef = useRef<number | null>(null);
	const belowSummaryRef = useRef<HTMLDivElement | null>(null);
	const isInitialSummaryRender = useRef(true);
	const isCollapsingRef = useRef(false);
	const isMountedRef = useRef(true);

	// 切换游戏时彻底重置折叠状态与缓存高度，避免跨游戏状态污染
	useEffect(() => {
		if (isMountedRef.current) setSummaryExpanded(false);
		summaryPrevHeightRef.current = null;
		isCollapsingRef.current = false;
	}, [selectedGame?.id]);

	// 组件卸载时安全清理 GSAP 补间，防止内存泄漏和未挂载状态更新
	useEffect(() => {
		isMountedRef.current = true;
		return () => {
			isMountedRef.current = false;
			if (summaryContainerRef.current)
				gsap.killTweensOf(summaryContainerRef.current);
			if (belowSummaryRef.current) gsap.killTweensOf(belowSummaryRef.current);
		};
	}, []);

	const handleExpandSummary = () => {
		if (summaryContainerRef.current) {
			summaryPrevHeightRef.current = summaryContainerRef.current.offsetHeight;
		}
		setSummaryExpanded(true);
	};

	const handleCollapseSummary = () => {
		const el = summaryContainerRef.current;
		const belowEl = belowSummaryRef.current;
		if (!el || isCollapsingRef.current) return;
		isCollapsingRef.current = true;

		const startHeight = el.offsetHeight;
		const targetHeight =
			summaryPrevHeightRef.current || DEFAULT_COLLAPSED_SUMMARY_HEIGHT;

		// 1. 若视口已向下滚入长文下方，平滑回滑归位
		const scrollContainer = document.querySelector<HTMLElement>(
			".skerry-detail-route-layer",
		);
		if (scrollContainer) {
			const containerRect = scrollContainer.getBoundingClientRect();
			const elRect = el.getBoundingClientRect();
			if (elRect.top < containerRect.top + 30) {
				gsap.killTweensOf(scrollContainer);
				gsap.to(scrollContainer, {
					scrollTop: Math.max(
						0,
						scrollContainer.scrollTop + (elRect.top - containerRect.top - 80),
					),
					duration: 0.44,
					ease: "power2.inOut",
				});
			}
		}

		gsap.killTweensOf(el);
		if (belowEl) {
			gsap.killTweensOf(belowEl);
			gsap.set(belowEl, { clearProps: "transform,opacity" });
		}

		// 2. 文本慢慢收缩核心逻辑：
		// 动画进行时保持 summaryExpanded 为 true，长文本在视口中慢慢向上卷拢收缩，
		// 底部画廊与标签行严密贴合容器底部自然向上推移，全程不出现任何大面积空白！
		gsap.fromTo(
			el,
			{ height: startHeight },
			{
				height: targetHeight,
				duration: 0.44,
				ease: "power2.inOut",
				onComplete: () => {
					// 高度收拢到达 targetHeight 时，保持高度锁定在当前像素值，触发 React 切换状态
					// 绝不能在此处直接赋 auto（因 React 尚未提交新 DOM，否则会在当前长文下瞬间撑开 1 帧引起突兀弹跳）
					if (isMountedRef.current) setSummaryExpanded(false);
				},
			},
		);
	};

	useLayoutEffect(() => {
		if (isInitialSummaryRender.current) {
			isInitialSummaryRender.current = false;
			return;
		}
		const el = summaryContainerRef.current;
		const belowEl = belowSummaryRef.current;
		if (!el) return;

		if (summaryExpanded) {
			// 1. 展开阶段（长文平滑展开 + 下方平滑推开 + 视线平滑锚定）
			const naturalCollapsedHeight =
				(el.firstElementChild as HTMLElement)?.offsetHeight ||
				el.offsetHeight ||
				DEFAULT_COLLAPSED_SUMMARY_HEIGHT;
			const startHeight =
				summaryPrevHeightRef.current ?? naturalCollapsedHeight;
			const targetHeight = el.scrollHeight;
			const deltaHeight = Math.max(0, targetHeight - startHeight);

			gsap.killTweensOf(el);
			if (belowEl) gsap.killTweensOf(belowEl);

			// 简介展开
			gsap.fromTo(
				el,
				{ height: startHeight, opacity: 0.88 },
				{
					height: targetHeight,
					opacity: 1,
					duration: 0.44,
					ease: "power2.out",
					onComplete: () => {
						if (el) {
							el.style.height = "auto";
						}
					},
				},
			);

			// 下方 tag 和画廊协同向下平滑推开
			if (belowEl && deltaHeight > 0) {
				gsap.fromTo(
					belowEl,
					{ y: -Math.min(deltaHeight * 0.45, 120), opacity: 0.85 },
					{
						y: 0,
						opacity: 1,
						duration: 0.44,
						ease: "power2.out",
						clearProps: "transform,opacity",
					},
				);
			}

			// 视线平滑锚定
			const scrollContainer = document.querySelector<HTMLElement>(
				".skerry-detail-route-layer",
			);
			if (scrollContainer) {
				const containerRect = scrollContainer.getBoundingClientRect();
				const elRect = el.getBoundingClientRect();
				const targetScrollTop =
					scrollContainer.scrollTop + (elRect.top - containerRect.top - 90);
				gsap.to(scrollContainer, {
					scrollTop: targetScrollTop,
					duration: 0.44,
					ease: "power2.out",
				});
			}
		} else {
			// 当 summaryExpanded 变为 false 且 React 已将折叠短文切实提交到 DOM 后，安全释放为 auto 并微渐变
			el.style.height = "auto";
			isCollapsingRef.current = false;
			if (belowEl) {
				gsap.killTweensOf(belowEl);
				gsap.set(belowEl, { clearProps: "transform,opacity" });
			}
			gsap.fromTo(
				el,
				{ opacity: 0.88 },
				{ opacity: 1, duration: 0.16, ease: "power1.out" },
			);
		}
	}, [summaryExpanded]);

	const [isSettingBackdrop, setIsSettingBackdrop] = useState(false);
	const [backdropMenuAnchor, setBackdropMenuAnchor] =
		useState<HTMLElement | null>(null);
	const [backdropCropperOpen, setBackdropCropperOpen] = useState(false);
	const [backdropCropSource, setBackdropCropSource] = useState("");
	const [heroAspectRatio, setHeroAspectRatio] = useState(16 / 9);
	const [openActionsMenuAnchor, setOpenActionsMenuAnchor] =
		useState<HTMLElement | null>(null);

	const openBackdropCropper = (source: string) => {
		const hero = document.querySelector<HTMLElement>(".detail-hero");
		const heroRect = hero?.getBoundingClientRect();
		if (heroRect && heroRect.height > 0) {
			setHeroAspectRatio(heroRect.width / heroRect.height);
		}
		setBackdropCropSource(source);
		setBackdropCropperOpen(true);
	};

	const handleAdjustBackdropFocus = () => {
		if (!selectedGame) return;
		const currentImage = detailHeroImage ?? getGameCover(selectedGame);
		if (!currentImage) return;
		openBackdropCropper(currentImage);
	};

	const handleResetBackdropFocus = async () => {
		if (!selectedGame) return;
		try {
			setIsSettingBackdrop(true);
			await persistCustomData({
				...selectedGame.custom_data,
				detail_backdrop_focus: null,
			});
			snackbar.success("底图位置已重置");
		} catch (error) {
			snackbar.error("重置底图位置失败: " + getUserErrorMessage(error, t));
		} finally {
			setIsSettingBackdrop(false);
		}
	};

	const handleSaveBackdropFocus = async (focus: BannerFocus) => {
		if (!selectedGame || !backdropCropSource) return;
		try {
			setIsSettingBackdrop(true);
			const normalizedFocus = normalizeBackdropFocus(focus);
			const customData = {
				...selectedGame.custom_data,
				detail_backdrop_focus: normalizedFocus,
				banner_focus: normalizedFocus,
			};
			await persistCustomData(customData);
			snackbar.success("底图显示位置已更新");
			setBackdropCropperOpen(false);
		} catch (error) {
			snackbar.error("设置底图位置失败: " + getUserErrorMessage(error, t));
		} finally {
			setIsSettingBackdrop(false);
		}
	};

	const persistGameCustomData = useCallback(
		async (customData: Partial<NonNullable<GameData["custom_data"]>>) => {
			if (!selectedGame) return;
			const mergedCustomData = {
				...selectedGame.custom_data,
				...customData,
			};

			await persistCustomData(mergedCustomData);
		},
		[persistCustomData, selectedGame],
	);

	const handleOpenGameFolder = async () => {
		if (selectedGame?.localpath) {
			await fileService.openDirectory(selectedGame.localpath);
		} else {
			snackbar.warning("未配置游戏本地目录");
		}
	};

	const handleOpenGameText = async () => {
		if (!selectedGame || !capabilities.canOpenGameText) return;
		try {
			await fileService.openGameReadmeText(selectedGame.id);
		} catch (error) {
			snackbar.error("打开文本失败: " + getUserErrorMessage(error, t));
		}
	};

	const {
		detailPanel,
		setDetailPanel,
		slideDirection,
		tabRefs,
		indicatorStyle,
	} = useDetailPanelNavigation(capabilities.panels);

	useLayoutEffect(() => {
		document
			.querySelector<HTMLElement>(".skerry-detail-route-layer")
			?.scrollTo({ top: 0 });
		if (capabilities.tracksSelectedLibraryGame) setSelectedGameId(id);
		setSelectedTags([]);
	}, [capabilities.tracksSelectedLibraryGame, id, setSelectedGameId]);

	useLayoutEffect(() => {
		const root = detailMotionRef.current;
		if (
			!root ||
			isLoadingSelectedGame ||
			!selectedGame ||
			selectedGame.id !== id ||
			prefersReducedMotion()
		) {
			return;
		}

		const ctx = gsap.context(() => {
			const bannerShell = root.querySelector<HTMLElement>(
				".detail-hero-banner-shell",
			);
			const coverShell = root.querySelector<HTMLElement>(".detail-cover-shell");
			const copy = root.querySelector<HTMLElement>(".detail-hero-copy");
			const actions = root.querySelector<HTMLElement>(".detail-hero-actions");
			const info = root.querySelector<HTMLElement>(".detail-info-panel");
			const secondary = gsap.utils.toArray<HTMLElement>(
				".detail-stats-summary, .detail-overview-grid, .detail-stats-overview, .detail-collection-footer",
			);
			const animated = [
				root,
				bannerShell,
				coverShell,
				copy,
				actions,
				info,
				...secondary,
			].filter(Boolean) as HTMLElement[];

			const timeline = gsap.timeline({
				defaults: { ease: "power2.out" },
				onComplete: () => {
					gsap.set(animated, {
						clearProps: "transform,opacity,visibility",
					});
				},
			});

			timeline.fromTo(
				root,
				{ autoAlpha: 0 },
				{ autoAlpha: 1, duration: 0.3, ease: "power2.out" },
				0,
			);

			if (bannerShell) {
				timeline.fromTo(
					bannerShell,
					{ autoAlpha: 0, y: -14, scale: 1.03 },
				{ autoAlpha: 1, y: 0, scale: 1, duration: 0.38, ease: "power2.out" },
					0,
				);
			}

			if (coverShell) {
				timeline.fromTo(
					coverShell,
					{ autoAlpha: 0, y: 18, scale: 0.94 },
					{ autoAlpha: 1, y: 0, scale: 1, duration: 0.38, ease: "power2.out" },
					0.04,
				);
			}

			if (copy) {
				timeline.fromTo(
					copy,
					{ autoAlpha: 0, y: 12 },
				{ autoAlpha: 1, y: 0, duration: 0.34, ease: "power2.out" },
				0.08,
				);
			}

			if (actions) {
				timeline.fromTo(
					actions,
					{ autoAlpha: 0, y: 12 },
				{ autoAlpha: 1, y: 0, duration: 0.34, ease: "power2.out" },
				0.1,
				);
			}

			if (info) {
				timeline.fromTo(
					info,
					{ autoAlpha: 0, y: 12 },
				{ autoAlpha: 1, y: 0, duration: 0.34, ease: "power2.out" },
				0.12,
				);
			}

			if (secondary.length) {
				timeline.fromTo(
					secondary,
					{ autoAlpha: 0, y: 12 },
					{
						autoAlpha: 1,
						y: 0,
						duration: 0.4,
						stagger: 0.045,
						ease: "power2.out",
					},
					0.14,
				);
			}
		}, root);

		return () => {
			if (root.dataset.detailMotionClosing === "true") return;
			ctx.revert();
		};
	}, [id, isLoadingSelectedGame, selectedGame]);

	const handleSourceDraft = useDetailMetadataDraft({
		id,
		sceneKind,
		nextUpGame,
		nextUpRawGame,
		rawSelectedGame,
		selectedGame,
		updateGame: updateGameMutation.mutateAsync,
	});

	const handleSaveDetailEdit = detailScene.saveEdit;

	const customStaff = selectedGame?.custom_data?.staff;
	const visibleStaff = customStaff ?? [];
	const staffByRole = useMemo(() => {
		const roleOrder: GameStaffRole[] = [
			"writer",
			"artist",
			"composer",
			"director",
		];
		return roleOrder
			.map((role) => ({
				role,
				members: visibleStaff.filter(
					(member) => member.roles.includes(role) && member.name.trim(),
				),
			}))
			.filter(({ members }) => members.length > 0);
	}, [visibleStaff]);
	const staffDisplayByRole = useMemo(() => {
		let remaining = 7;
		return staffByRole
			.map(({ role, members }) => {
				const visibleMembers = members.slice(0, Math.min(3, remaining));
				remaining -= visibleMembers.length;
				return {
					role,
					members: visibleMembers,
					hasMore: members.length > visibleMembers.length,
				};
			})
			.filter(({ members, hasMore }) => members.length > 0 || hasMore);
	}, [staffByRole]);
	const staffTooltipRows = staffByRole
		.map(({ role, members }) => ({
			role,
			label: t(`pages.Detail.staffRoles.${role}`, role),
			names: members
				.map((member) => member.name.trim())
				.filter(Boolean)
				.join("、"),
		}))
		.filter(({ names }) => names.length > 0);
	const staffSummary = staffTooltipRows
		.map(({ label, names }) => `${label} ${names}`)
		.join(" · ");

	useEffect(() => {
		if (!selectedGame) return;
		const cover = getGameCover(selectedGame);
		const heroImage =
			getGameDetailBackdrop(selectedGame, activeCustomRoot) ??
			(sceneKind === "next-up" && nextUpGame
				? getNextUpAssetUrl(nextUpGame, "banner") ||
					getGameBanner(selectedGame) ||
					resolveImageUrl(nextUpGame.banner) ||
					cover
				: (getGameBanner(selectedGame) ?? cover));
		if (!heroImage || typeof Image === "undefined") return;
		const image = new Image();
		image.decoding = "async";
		image.fetchPriority = "high";
		image.src = heroImage;
	}, [activeCustomRoot, sceneKind, nextUpGame, resolveImageUrl, selectedGame]);

	if (sceneKind === "next-up" && !nextUpGame) {
		return (
			<Box
				key={id}
				className="skerry-detail-page is-loading"
				sx={{ minHeight: "100vh", background: "var(--skerry-canvas, #090e17)" }}
			>
				<Box className="detail-soft-loading" role="status" aria-live="polite">
					<Typography variant="caption" fontWeight={800}>
						{t("home.nextUp.notFound", "这项待玩游戏已不存在")}
					</Typography>
				</Box>
			</Box>
		);
	}

	if (isLoadingSelectedGame || !selectedGame || selectedGame.id !== id) {
		return (
			<Box
				key={id}
				className="skerry-detail-page is-loading"
				sx={{ minHeight: "100vh", background: "var(--skerry-canvas, #090e17)" }}
			>
				<Box className="detail-soft-loading" role="status" aria-live="polite">
					<CircularProgress size={18} thickness={4} />
					<Typography variant="caption" fontWeight={800}>
						{t("pages.Detail.loading", "Loading...")}
					</Typography>
				</Box>
			</Box>
		);
	}

	const cover = getGameCover(selectedGame);
	const banner =
		sceneKind === "next-up" && nextUpGame
			? getNextUpAssetUrl(nextUpGame, "banner") ||
				getGameBanner(selectedGame) ||
				resolveImageUrl(nextUpGame.banner) ||
				cover
			: (getGameBanner(selectedGame) ?? cover);
	const detailBackdrop = getGameDetailBackdrop(selectedGame, activeCustomRoot);
	const detailHeroImage = detailBackdrop ?? banner;
	const detailBackdropFocus =
		selectedGame.custom_data?.detail_backdrop_focus ??
		selectedGame.custom_data?.banner_focus;
	const detailHeroObjectPosition = detailBackdropFocus
		? `${normalizeBackdropFocus(detailBackdropFocus).x}% ${normalizeBackdropFocus(detailBackdropFocus).y}%`
		: "center";
	const developers = getDeveloperNames(
		selectedGame.developer,
		t("category.unknownDeveloper", "Unknown developer"),
	);
	const tags = selectedGame.tags ?? [];
	return (
		<Box id="skerry-detail-page" className="skerry-detail-page">
			<Box className="game-detail-fixed">
				<Box className="detail-hero">
					<Box
						component="img"
						src={detailHeroImage}
						alt=""
						className="detail-hero-bg"
						loading="eager"
						decoding="sync"
						fetchPriority="high"
						style={{ objectPosition: detailHeroObjectPosition }}
						onError={(e: any) => {
							e.currentTarget.style.display = "none";
						}}
					/>
					<Box className="detail-hero-scrim" />
					<Box className="detail-hero-content">
						<Box className="detail-hero-info-group">
							<Box className="detail-poster">
								<Box
									component="img"
									src={cover}
									alt={getGameDisplayName(selectedGame)}
									className="detail-poster-image"
								/>
							</Box>

							<Box className="detail-copy-group">
								<Box className="detail-badge-row">
									<Box
										component="button"
										type="button"
										onClick={(event) =>
											setPlayStatusMenuAnchor(event.currentTarget)
										}
										className={`detail-badge-playstatus ${
											selectedGame.clear &&
											DETAIL_PLAY_STATUS_CONFIG[selectedGame.clear]
												? DETAIL_PLAY_STATUS_CONFIG[selectedGame.clear]
														.colorClass
												: "status-badge-default"
										}`}
									>
										<Box
											component="span"
											className={
												selectedGame.clear &&
												DETAIL_PLAY_STATUS_CONFIG[selectedGame.clear]
													? DETAIL_PLAY_STATUS_CONFIG[selectedGame.clear]
															.dotClass
													: ""
											}
											sx={{
												width: 7,
												height: 7,
												borderRadius: "50%",
												bgcolor:
													selectedGame.clear &&
													DETAIL_PLAY_STATUS_CONFIG[selectedGame.clear]
														? "currentColor"
														: "rgba(255, 255, 255, 0.4)",
												boxShadow:
													selectedGame.clear &&
													DETAIL_PLAY_STATUS_CONFIG[selectedGame.clear]
														? "0 0 6px currentColor"
														: "none",
												flexShrink: 0,
											}}
										/>
										<span>
											{selectedGame.clear &&
											DETAIL_PLAY_STATUS_CONFIG[selectedGame.clear]
												? DETAIL_PLAY_STATUS_CONFIG[selectedGame.clear].label
												: "+ 状态"}
										</span>
										<span className="detail-badge-playstatus-arrow">▾</span>
									</Box>
									<span className="detail-badge-vendor">
										{developers[0] || "UNKNOWN"}
									</span>
									{hasRating(
										selectedGame.score ?? selectedGame.custom_data?.user_rating,
									) && (
										<span className="detail-badge-bgm">
											<span className="detail-badge-star">★</span>
											<span>
												{formatScoreValue(
													selectedGame.score ??
														selectedGame.custom_data?.user_rating,
												)}
											</span>
										</span>
									)}
									<span className="detail-badge-playtime">
										Playtime:{" "}
										<span className="detail-badge-playtime-val">
											{gameStatsQuery.data?.totalPlayTime ||
												(selectedGame.average_hours
													? `${selectedGame.average_hours}h`
													: "0小时")}
										</span>
									</span>
								</Box>
								<Typography className="detail-title">
									{getGameDisplayName(selectedGame)}
								</Typography>
								<Typography className="detail-subtitle">
									<span className="detail-subtitle-text">
										{selectedGame.name}
									</span>
									{staffSummary && (
										<Tooltip
											title={
												<span>
													{staffTooltipRows.map(({ role, label, names }) => (
														<span key={role} style={{ display: "block" }}>
															<span className="detail-badge-staff-role">
																{label}
															</span>{" "}
															<span>{names}</span>
														</span>
													))}
												</span>
											}
											placement="bottom-start"
											arrow
											enterDelay={300}
										>
											<span className="detail-badge-staff">
												{staffDisplayByRole.length > 0
													? staffDisplayByRole.map(
															({ role, members, hasMore }, roleIdx) => (
																<Fragment key={role}>
																	{roleIdx > 0 && (
																		<span className="detail-badge-staff-sep">
																			/
																		</span>
																	)}
																	<span className="detail-badge-staff-role">
																		{t(`pages.Detail.staffRoles.${role}`, role)}
																	</span>
																	<span className="detail-badge-staff-names">
																		{members
																			.map((member) => member.name.trim())
																			.join("、")}
																		{hasMore ? "…" : ""}
																	</span>
																</Fragment>
															),
														)
													: staffSummary}
											</span>
										</Tooltip>
									)}
								</Typography>
							</Box>
						</Box>

						<Box className="detail-action-group">
							{capabilities.canLaunch && <LaunchModal />}
							{capabilities.canLaunch && (
								<Button
									className="detail-action-btn detail-action-btn-text detail-action-btn-open detail-secondary-button"
									endIcon={<ArrowDropDownRoundedIcon />}
									onClick={(event) =>
										setOpenActionsMenuAnchor(event.currentTarget)
									}
								>
									打开——
								</Button>
							)}
							<Menu
								anchorEl={playStatusMenuAnchor}
								open={Boolean(playStatusMenuAnchor)}
								onClose={() => setPlayStatusMenuAnchor(null)}
								anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
								transformOrigin={{ vertical: "top", horizontal: "left" }}
								PaperProps={{
									sx: {
										background: "#18202c",
										border: "1px solid rgba(255, 255, 255, 0.15)",
										borderRadius: "8px",
										boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
										color: "#ffffff",
										width: "102px",
										minWidth: "102px",
										maxWidth: "102px",
										py: 0.5,
									},
								}}
								MenuListProps={{
									dense: true,
									sx: {
										py: 0.5,
										px: 0.5,
										minWidth: "0 !important",
										width: "100%",
										boxSizing: "border-box",
									},
								}}
							>
								{Object.entries(DETAIL_PLAY_STATUS_CONFIG).map(
									([key, item]) => {
										const statusVal = Number(key);
										const isSelected = selectedGame?.clear === statusVal;
										return (
											<MenuItem
												key={key}
												onClick={() =>
													void handlePlayStatusSelect(statusVal as PlayStatus)
												}
												selected={isSelected}
												sx={{
													fontSize: "13px",
													py: 0.6,
													px: 1,
													gap: 1,
													borderRadius: "6px",
													minHeight: "30px !important",
													"&.Mui-selected": {
														bgcolor: "rgba(59, 130, 246, 0.22)",
													},
												}}
											>
												<Box
													className={item.dotClass}
													sx={{
														width: 7,
														height: 7,
														borderRadius: "50%",
														bgcolor: "currentColor",
														boxShadow: "0 0 6px currentColor",
														flexShrink: 0,
													}}
												/>
												<Typography
													sx={{
														fontSize: "13px",
														fontWeight: isSelected ? 700 : 500,
													}}
												>
													{item.label}
												</Typography>
											</MenuItem>
										);
									},
								)}
							</Menu>
							<Menu
								anchorEl={openActionsMenuAnchor}
								open={Boolean(openActionsMenuAnchor)}
								onClose={() => setOpenActionsMenuAnchor(null)}
								anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
								transformOrigin={{ vertical: "top", horizontal: "left" }}
								PaperProps={{
									sx: {
										width: "max-content",
										minWidth: 0,
										maxWidth: "max-content",
									},
								}}
								MenuListProps={{ dense: true, sx: { py: 0.5 } }}
							>
								<MenuItem
									disabled={!selectedGame?.localpath}
									onClick={() => {
										setOpenActionsMenuAnchor(null);
										void handleOpenGameFolder();
									}}
								>
									<ListItemIcon>
										<FolderOpenRoundedIcon />
									</ListItemIcon>
									<ListItemText primary="打开文件夹" />
								</MenuItem>
								<MenuItem
									disabled={!selectedGame?.localpath}
									onClick={() => {
										setOpenActionsMenuAnchor(null);
										void handleOpenGameText();
									}}
								>
									<ListItemIcon>
										<DescriptionRoundedIcon />
									</ListItemIcon>
									<ListItemText primary="打开文本" />
								</MenuItem>
							</Menu>
							{capabilities.canImportToLibrary && (
								<Button
									className="detail-primary-button"
									startIcon={<AddRoundedIcon />}
									disabled={isAddingGame}
									onClick={() => void handleImportNextUpGame()}
								>
									加入游戏库
								</Button>
							)}
							<Button
								className="detail-action-btn detail-action-btn-text detail-action-btn-update detail-secondary-button"
								onClick={() => setSourceUpdateOpen(true)}
							>
								更新资料
							</Button>
							<MoreButton
								selectedGame={selectedGame}
								variant="hamburger"
								className="detail-action-btn detail-action-btn-icon detail-action-btn-more detail-more-button"
								onlySourceLinks={capabilities.sourceLinksOnly}
							/>
							<IconButton
								className="detail-action-btn detail-action-btn-icon detail-action-btn-backdrop detail-backdrop-button"
								disabled={isSettingBackdrop}
								onClick={(event) => setBackdropMenuAnchor(event.currentTarget)}
							>
								<WallpaperRoundedIcon sx={{ fontSize: 18 }} />
							</IconButton>
							<Menu
								anchorEl={backdropMenuAnchor}
								open={Boolean(backdropMenuAnchor)}
								onClose={() => setBackdropMenuAnchor(null)}
								anchorOrigin={{ vertical: "top", horizontal: "right" }}
								transformOrigin={{ vertical: "bottom", horizontal: "right" }}
								PaperProps={{
									sx: {
										width: "max-content",
										minWidth: 0,
										maxWidth: "max-content",
									},
								}}
								MenuListProps={{ dense: true, sx: { py: 0.5 } }}
							>
								<MenuItem
									disabled={!detailHeroImage}
									onClick={() => {
										setBackdropMenuAnchor(null);
										handleAdjustBackdropFocus();
									}}
								>
									<ListItemIcon>
										<CropFreeRoundedIcon />
									</ListItemIcon>
									<ListItemText primary="调整显示位置" />
								</MenuItem>
								<MenuItem
									disabled={!selectedGame?.custom_data?.detail_backdrop_focus}
									onClick={() => {
										setBackdropMenuAnchor(null);
										void handleResetBackdropFocus();
									}}
								>
									<ListItemIcon>
										<RestartAltRoundedIcon />
									</ListItemIcon>
									<ListItemText primary="重置显示位置" />
								</MenuItem>
							</Menu>
						</Box>
					</Box>
				</Box>

				<Box className="detail-body">
					<Box className="detail-main-column detail-panel">
						<Box className="detail-tabs">
							<span
								ref={(node) => {
									tabRefs.current["overview"] = node;
								}}
								className={detailPanel === "overview" ? "is-active" : ""}
								onClick={() => setDetailPanel("overview")}
							>
								剧情概要 (Story & Overview)
							</span>
							{capabilities.canViewStatistics && (
								<span
									ref={(node) => {
										tabRefs.current["stats"] = node;
									}}
									className={detailPanel === "stats" ? "is-active" : ""}
									onClick={() => setDetailPanel("stats")}
								>
									游戏统计
								</span>
							)}
							{capabilities.canManageSaves && (
								<span
									ref={(node) => {
										tabRefs.current["save"] = node;
									}}
									className={detailPanel === "save" ? "is-active" : ""}
									onClick={() => setDetailPanel("save")}
								>
									存档管理
								</span>
							)}
							<span
								ref={(node) => {
									tabRefs.current["review"] = node;
								}}
								className={detailPanel === "review" ? "is-active" : ""}
								onClick={() => setDetailPanel("review")}
							>
								评测
							</span>
							<span
								ref={(node) => {
									tabRefs.current["edit"] = node;
								}}
								className={detailPanel === "edit" ? "is-active" : ""}
								onClick={() => setDetailPanel("edit")}
							>
								游戏编辑
							</span>
							<div
								className="detail-tab-indicator"
								style={{
									left: indicatorStyle.left,
									width: indicatorStyle.width,
									opacity: indicatorStyle.ready ? 1 : 0,
								}}
							/>
						</Box>

						<Box
							className={`detail-tab-pane-container ${slideDirection === "forward" ? "detail-tab-pane-slide-forward" : "detail-tab-pane-slide-backward"}`}
							key={detailPanel}
						>
							{detailPanel === "overview" && (
								<Box className="detail-overview">
									<Box
										ref={summaryContainerRef}
										sx={{
											position: "relative",
											overflow: "hidden",
											willChange: "height, opacity",
										}}
									>
										{summaryExpanded ? (
											<Box sx={{ position: "relative" }}>
												<Typography
													className="detail-summary detail-summary-expanded"
													sx={{
														whiteSpace: "pre-wrap",
														overflowWrap: "anywhere",
														pt: 0.5,
													}}
												>
													{renderSummaryWithLineBreaks(selectedGame.summary)}
													<Box
														className="detail-summary-toggle"
														component="button"
														type="button"
														onClick={handleCollapseSummary}
													>
														⤴ 收起排版
													</Box>
												</Typography>
											</Box>
										) : (
											<Typography className="detail-summary">
												<span className="detail-drop-cap">
													{(selectedGame.summary || "新").charAt(0)}
												</span>
												{(
													selectedGame.summary || "暂无剧情概要可用。"
												).substring(1)}
												<Box
													className="detail-summary-toggle"
													component="button"
													type="button"
													onClick={handleExpandSummary}
												>
													⤵ 完全显示
												</Box>
											</Typography>
										)}
									</Box>

									<Box ref={belowSummaryRef} sx={{ willChange: "transform" }}>
										<Box className="detail-tag-row">
											{tags.slice(0, 10).map((tag) => (
												<span key={tag} className="detail-tag-pill">
													{getTagDisplayName(tag, tagTranslation)}
												</span>
											))}
										</Box>

										<Box className="detail-gallery-section">
											<Box
												sx={{
													display: "flex",
													justifyContent: "space-between",
													alignItems: "center",
													mb: 2,
												}}
											>
												<Typography
													className="detail-panel-title"
													sx={{ mb: 0 }}
												>
													画廊 (GALLERY CG)
												</Typography>
												<Button
													size="small"
													variant="outlined"
													className="detail-gallery-manage-btn skerry-button-level-c"
													onClick={() => setManageCgDialogOpen(true)}
												>
													CG管理
												</Button>
											</Box>

											{/* 纯净的画廊网格 */}
											<Box className="detail-gallery-grid">
												{(customCgUrls.length > 0 ||
												sourceScreenshots.length > 0
													? [...customCgUrls, ...sourceScreenshots]
													: [banner, banner, banner, banner].filter(Boolean)
												).map((src, i) => (
													<Box
														component="img"
														key={i}
														src={src}
														className="detail-gallery-item"
														loading={i < 4 ? "eager" : "lazy"}
														decoding="async"
													/>
												))}
											</Box>
										</Box>
									</Box>
								</Box>
							)}

							{detailPanel === "stats" && (
								<Box className="detail-stats-tab-content" sx={{ mt: 2 }}>
									<GameStatsOverview gameID={id} showSummary={true} />
								</Box>
							)}

							{capabilities.canManageSaves && detailPanel === "save" && (
								<SaveData />
							)}
							{sceneKind === "library" && detailPanel === "review" && (
								<Review selectedGame={selectedGame} />
							)}
							{detailPanel === "edit" && (
								<LibraryGameEdit
									selectedGame={selectedGame}
									rawGame={rawGameForEdit}
									virtualGame={sceneKind === "next-up" ? nextUpGame : undefined}
									onSave={handleSaveDetailEdit}
								/>
							)}
							{sceneKind === "next-up" &&
								detailPanel === "review" &&
								nextUpGame && (
									<NextUpGameReview
										game={nextUpGame}
										onSave={(rating, review) => {
											updateNextUpGame(nextUpGame.id, {
												userRating: rating,
												userReview: review,
											});
										}}
									/>
								)}
						</Box>
					</Box>

					<Box className="detail-side-column">
						<Box className="detail-panel compact">
							<Typography className="detail-panel-title">
								PLAYER STATS / 游玩统计
							</Typography>
							<Box className="detail-stats-grid">
								<Box className="detail-stat-item">
									<Box className="detail-stat-circle is-green">
										{formatCompactPlaytime(
											gameStatsQuery.data?.totalMinutes ??
												gameStatsQuery.data?.totalPlayTime,
											"0m",
										)}
									</Box>
									<Typography className="detail-stat-label">Total</Typography>
								</Box>
								<Box className="detail-stat-item">
									<Box className="detail-stat-circle">
										{formatCompactPlaytime(
											gameStatsQuery.data?.todayPlayTime,
											"0m",
										)}
									</Box>
									<Typography className="detail-stat-label">Daily</Typography>
								</Box>
								<Box className="detail-stat-item">
									<Box className="detail-stat-circle is-amber">
										{gameStatsQuery.data?.sessionCount ?? 0}
									</Box>
									<Typography className="detail-stat-label">Times</Typography>
								</Box>
							</Box>
						</Box>

						<Box className="detail-panel compact">
							<Typography className="detail-panel-title">
								DOSSIER SPECS / 作品档案
							</Typography>
							<Box className="dossier-row">
								<span className="dossier-key">开发商</span>
								<span className="dossier-value">
									{developers.join(", ") || "-"}
								</span>
							</Box>
							<Box className="dossier-row">
								<span className="dossier-key">发行商</span>
								<span className="dossier-value">-</span>
							</Box>
							<Box className="dossier-row">
								<span className="dossier-key">发售日期</span>
								<span className="dossier-value">
									{selectedGame.date || "-"}
								</span>
							</Box>
							{selectedGame.created_at && (
								<Box className="dossier-row">
									<span className="dossier-key">添加时间</span>
									<span className="dossier-value">
										{new Date(
											selectedGame.created_at * 1000,
										).toLocaleDateString()}
									</span>
								</Box>
							)}
						</Box>

						<Box className="detail-panel compact">
							<Typography className="detail-panel-title">
								COMMUNITY FEEDS / 社区动态
							</Typography>
							<Box className="dossier-row">
								<span className="dossier-key">社区评分</span>
								<span className="dossier-value" style={{ color: "#f59e0b" }}>
									{hasRating(selectedGame.score)
										? `★ ${formatScoreValue(selectedGame.score)}`
										: "-"}
								</span>
							</Box>
							{hasRating(selectedGame.custom_data?.user_rating) && (
								<Box className="dossier-row">
									<span className="dossier-key">我的评分</span>
									<span className="dossier-value" style={{ color: "#00e5ff" }}>
										★ {formatScoreValue(selectedGame.custom_data?.user_rating)}
									</span>
								</Box>
							)}
							<Box className="dossier-row">
								<span className="dossier-key">数据源 ID</span>
								<span
									className="dossier-value"
									style={{ fontSize: "11px", opacity: 0.8 }}
								>
									<span className="dossier-source-ids">
										{selectedGame.sourceIds
											? Object.entries(selectedGame.sourceIds).map(
													([sourceKey, sourceId]) => {
														const displayKey =
															sourceKey === "kun"
																? "Kungal"
																: sourceKey === "bgm"
																	? "Bangumi"
																	: sourceKey === "vndb"
																		? "VNDB"
																		: sourceKey;
														return (
															<span
																key={`${sourceKey}:${sourceId}`}
															>{`${displayKey}:${sourceId}`}</span>
														);
													},
												)
											: "-"}
									</span>
								</span>
							</Box>
						</Box>
					</Box>
				</Box>
			</Box>

			{capabilities.canManageCollections && (
				<CollectionPickerDialog
					open={collectionDialogOpen}
					mode="manage"
					gameIds={[selectedGame.id]}
					onClose={() => setCollectionDialogOpen(false)}
				/>
			)}
			<NextUpImportDialog
				open={sourceUpdateOpen}
				onClose={() => setSourceUpdateOpen(false)}
				initialSourceIds={selectedGame.sourceIds}
				initialQuery={selectedGame.name}
				title={t(
					"pages.Detail.DataSourceUpdate.updateFromSource",
					"更新资料源",
				)}
				onImportDraft={handleSourceDraft}
				onImport={() => undefined}
			/>
			{selectedGame && (
				<DetailGalleryDialog
					open={manageCgDialogOpen}
					onClose={() => setManageCgDialogOpen(false)}
					game={selectedGame}
					activeCustomRoot={activeCustomRoot}
					onPersistCustomData={persistGameCustomData}
				/>
			)}
			{selectedGame ? (
				<ImageFocusCropperDialog
					open={backdropCropperOpen}
					title="调整底图显示位置"
					imageUrl={backdropCropSource}
					initialFocus={selectedGame.custom_data?.detail_backdrop_focus}
					aspectRatio={heroAspectRatio}
					onCancel={() => {
						setBackdropCropperOpen(false);
					}}
					onSave={(focus) => void handleSaveBackdropFocus(focus)}
				/>
			) : null}
		</Box>
	);
};
