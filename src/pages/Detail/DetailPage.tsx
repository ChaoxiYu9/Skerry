/**
 * PotatoVN-inspired game detail page.
 * The banner and cover stay side by side above the game information.
 */

import WallpaperRoundedIcon from "@mui/icons-material/WallpaperRounded";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import CropFreeRoundedIcon from "@mui/icons-material/CropFreeRounded";
import ArrowDropDownRoundedIcon from "@mui/icons-material/ArrowDropDownRounded";
import DescriptionRoundedIcon from "@mui/icons-material/DescriptionRounded";
import RestartAltRoundedIcon from "@mui/icons-material/RestartAltRounded";
import FolderOpenRoundedIcon from "@mui/icons-material/FolderOpenRounded";
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
	useEffect,
	useCallback,
	useLayoutEffect,
	useMemo,
	useRef,
	type ReactNode,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { CollectionPickerDialog } from "@/components/Collection";
import { LaunchModal } from "@/components/LaunchModal";
import { MoreButton } from "@/components/Toolbar";
import { useProxyImageUrlResolver } from "@/hooks/common/useProxyImageUrlResolver";
import { useGameById } from "@/hooks/features/games/useGameFacade";
import { settingsKeys, useAllSettings } from "@/hooks/queries/useSettings";
import { queryClient } from "@/providers/queryClient";
import { useSingleGameAddActions } from "@/hooks/features/games/useGameMetadataFacade";
import { gameStaffKeys, useGameStaff } from "@/hooks/queries/useGameStaff";
import { fetchBgmStaffById } from "@/metadata/api/bgm";
import { useUpdateGame } from "@/hooks/queries/useGames";
import { buildMetadataUpdatePayload } from "@/metadata/data/metadata";
import { getSourceAdapter } from "@/metadata/sourceRegistry";
import { getDisplayGameData } from "@/metadata/data/dataTransform";
import { candidateSourcesToGameSources } from "@/metadata/sourceCandidate";
import { animateDetailClose } from "@/components/motion/detailLaunch";
import { NextUpImportDialog } from "@/pages/Home/NextUpImportDialog";
import {
	buildNextUpMetadataDraft,
	buildNextUpFullGame,
	applyNextUpEditUpdates,
	selectNextUpRuntimeOptions,
} from "@/pages/Home/nextUpLibraryImport";
import {
	copyNextUpAssetsToLibrary,
	deleteNextUpAssets,
	getNextUpAssetUrl,
	pruneMissingNextUpAssets,
} from "@/pages/Home/nextUpAssets";
import { NextUpGameReview } from "@/pages/NextUpDetail/NextUpGameReview";
import { snackbar } from "@/providers/snackBar";
import { fileService } from "@/services/invoke";
import {
	getCgIdentifierUrl,
	saveGalleryImageAs,
} from "@/services/game/customCover";
import { type NextUpVirtualGame, useStore } from "@/store/appStore";
import type { BannerFocus, FullGameData, GameData, GameMetadataDraft, GameStaffRole, UpdateGameParams } from "@/types";
import { getUserErrorMessage } from "@/utils/errors";
import {
	getGameBanner,
	getGameCover,
	getGameDetailBackdrop,
	getGameDisplayName,
} from "@/utils/game";
import { getDeveloperNames } from "@/utils/game/gameIndex";
import { getTagDisplayName } from "@/utils/game/tagTranslation";
import { LibraryGameEdit } from "./game-info/LibraryGameEdit";
import { DetailGalleryDialog } from "./game-info/DetailGalleryDialog";
import { Review } from "./Review";
import { SaveData } from "./SaveData";
import { useGameStats } from "@/hooks/queries/useStats";
import { PlayStatus } from "@/types/collection";
import { useUpdatePlayStatus } from "@/hooks/queries/usePlayStatus";

const DETAIL_PLAY_STATUS_CONFIG: Record<
	number,
	{ label: string; dotClass: string; colorClass: string }
> = {
	[PlayStatus.WISH]: { label: "想玩", dotClass: "play-status-icon-wish", colorClass: "status-badge-wish" },
	[PlayStatus.PLAYING]: { label: "在玩", dotClass: "play-status-icon-playing", colorClass: "status-badge-playing" },
	[PlayStatus.PLAYED]: { label: "通关", dotClass: "play-status-icon-played", colorClass: "status-badge-played" },
	[PlayStatus.ON_HOLD]: { label: "搁置", dotClass: "play-status-icon-hold", colorClass: "status-badge-hold" },
	[PlayStatus.DROPPED]: { label: "弃坑", dotClass: "play-status-icon-dropped", colorClass: "status-badge-dropped" },
};
import { GameStatsOverview } from "./stats/GameStatsOverview";
import { ImageFocusCropperDialog } from "./ImageFocusCropperDialog";

type DetailPanel = "overview" | "stats" | "edit" | "save" | "review";


const prefersReducedMotion = () =>
	typeof window !== "undefined" &&
	window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const clampBackdropFocus = (value: unknown) => {
	const numeric = typeof value === "number" && Number.isFinite(value) ? value : 50;
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

function formatCompactPlaytime(val?: string | number | null, fallback = "0m"): string {
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
	return totalHours >= 10 ? `${Math.round(totalHours)}h` : `${totalHours.toFixed(1)}h`;
}

function createNextUpDisplayGame(
	game: NextUpVirtualGame,
	rawGame: FullGameData,
): GameData {
	const displayGame = getDisplayGameData(rawGame);
	displayGame.image =
		getNextUpAssetUrl(game, "cover") ||
		displayGame.image ||
		game.image;
	displayGame.custom_data = {
		...displayGame.custom_data,
		image: game.coverAsset ?? displayGame.custom_data?.image,
		banner: game.bannerAsset ?? displayGame.custom_data?.banner,
	};
	return displayGame;
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

async function pickBestScreenshotUrl(urls: string[]): Promise<string> {
	const valid = urls.filter((u) => u && typeof u === "string" && u.startsWith("http"));
	if (valid.length === 0) return urls[0] ?? "";
	const candidates = valid.slice(0, 5);
	let bestUrl = candidates[0];
	let maxScore = 0;

	await Promise.all(
		candidates.map(async (url) => {
			try {
				const img = new Image();
				img.src = url;
				await new Promise<void>((resolve, reject) => {
					img.onload = () => resolve();
					img.onerror = () => reject();
					setTimeout(reject, 2500);
				});
				const isLandscape = img.naturalWidth > img.naturalHeight;
				const score = img.naturalWidth * img.naturalHeight * (isLandscape ? 1.5 : 1);
				if (score > maxScore) {
					maxScore = score;
					bestUrl = url;
				}
			} catch {
				// 忽略探测超时
			}
		}),
	);
	return bestUrl;
}

export const Detail: React.FC = () => {
	const location = useLocation();
	const isNextUpRoute = location.pathname.startsWith("/next-up/");
	const routeId = Number(location.pathname.split("/").at(-1));
	const id = isNextUpRoute ? -Math.abs(routeId) : routeId;
	const { t } = useTranslation();
	const navigate = useNavigate();
	const detailMotionRef = useRef<HTMLDivElement | null>(null);
	const updateGameMutation = useUpdateGame();
	const resolveImageUrl = useProxyImageUrlResolver();
	const { addGameFromMetadata, isAddingGame } = useSingleGameAddActions();
	const [searchParams, setSearchParams] = useSearchParams();
	const {
		tagTranslation,
		setSelectedGameId,
	} = useStore(
		useShallow((state) => ({
			tagTranslation: state.tagTranslation,
			setSelectedGameId: state.setSelectedGameId,
		})),
	);
	const nextUpGame = useStore((state) =>
		isNextUpRoute
			? state.nextUpVirtualGames.find((item) => item.id === id)
			: undefined,
	);
	const updateNextUpGame = useStore((state) => state.updateNextUpVirtualGame);
	const replaceNextUpGame = useStore((state) => state.replaceNextUpVirtualGame);
	const prunedNextUpAssetIdsRef = useRef<Set<number>>(new Set());
	useEffect(() => {
		if (!nextUpGame || prunedNextUpAssetIdsRef.current.has(nextUpGame.id)) return;
		prunedNextUpAssetIdsRef.current.add(nextUpGame.id);
		let cancelled = false;

		pruneMissingNextUpAssets(nextUpGame)
			.then((updates) => {
				if (!cancelled && updates) updateNextUpGame(nextUpGame.id, updates);
			})
			.catch((error) => console.warn("清理心愿媒体引用失败:", error));

		return () => {
			cancelled = true;
		};
	}, [nextUpGame?.id, updateNextUpGame]);
	const nextUpRawGame = useMemo(() => {
		return nextUpGame ? buildNextUpFullGame(nextUpGame) : undefined;
	}, [nextUpGame]);
	const nextUpDisplayGame = useMemo(
		() =>
			nextUpGame && nextUpRawGame
				? createNextUpDisplayGame(nextUpGame, nextUpRawGame)
				: null,
		[nextUpGame, nextUpRawGame],
	);
	const libraryGame = useGameById(isNextUpRoute ? null : id);
	const selectedGame = isNextUpRoute
		? nextUpDisplayGame
		: libraryGame.selectedGame;
	const rawSelectedGame = isNextUpRoute ? null : libraryGame.rawSelectedGame;
	const isLoadingSelectedGame =
		!isNextUpRoute && libraryGame.isLoadingSelectedGame;
	const gameStatsQuery = useGameStats(isNextUpRoute ? null : id);
	const { data: appSettings } = useAllSettings({ enabled: true });
	const activeCustomRoot = appSettings?.detail_backdrop_path ?? (queryClient.getQueryData(settingsKeys.allSettings()) as any)?.detail_backdrop_path;
	const [collectionDialogOpen, setCollectionDialogOpen] = useState(false);
	const [playStatusMenuAnchor, setPlayStatusMenuAnchor] = useState<null | HTMLElement>(null);
	const updatePlayStatusMutation = useUpdatePlayStatus();

	const handlePlayStatusSelect = useCallback(
		async (newStatus: PlayStatus) => {
			setPlayStatusMenuAnchor(null);
			if (isNextUpRoute) return;
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
		[id, isNextUpRoute, updatePlayStatusMutation],
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
	const [isSettingBackdrop, setIsSettingBackdrop] = useState(false);
	const [backdropMenuAnchor, setBackdropMenuAnchor] = useState<HTMLElement | null>(null);
	const [backdropCropperOpen, setBackdropCropperOpen] = useState(false);
	const [backdropCropSource, setBackdropCropSource] = useState("");
	const [heroAspectRatio, setHeroAspectRatio] = useState(16 / 9);
	const [openActionsMenuAnchor, setOpenActionsMenuAnchor] = useState<HTMLElement | null>(null);

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
			if (isNextUpRoute) {
				updateNextUpGame(selectedGame.id, {
					customData: {
						...selectedGame.custom_data,
						detail_backdrop_focus: null,
					},
				});
			} else {
				await updateGameMutation.mutateAsync({
					gameId: selectedGame.id,
					updates: {
						custom_data: {
							...selectedGame.custom_data,
							detail_backdrop_focus: null,
						},
					},
				});
			}
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
			if (isNextUpRoute) {
				updateNextUpGame(selectedGame.id, { customData });
			} else {
				await updateGameMutation.mutateAsync({
					gameId: selectedGame.id,
					updates: { custom_data: customData },
				});
			}
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

			if (isNextUpRoute) {
				updateNextUpGame(selectedGame.id, { customData: mergedCustomData });
				return;
			}

			await updateGameMutation.mutateAsync({
				gameId: id,
				updates: { custom_data: mergedCustomData },
			});
		},
		[id, isNextUpRoute, selectedGame, updateGameMutation, updateNextUpGame],
	);

	const handleOpenGameFolder = async () => {
		if (selectedGame?.localpath) {
			await fileService.openDirectory(selectedGame.localpath);
		} else {
			snackbar.warning("未配置游戏本地目录");
		}
	};

	const handleOpenGameText = async () => {
		if (!selectedGame || isNextUpRoute) return;
		try {
			await fileService.openGameReadmeText(selectedGame.id);
		} catch (error) {
			snackbar.error("打开文本失败: " + getUserErrorMessage(error, t));
		}
	};

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

	useLayoutEffect(() => {
		document
			.querySelector<HTMLElement>(".skerry-detail-route-layer")
			?.scrollTo({ top: 0 });
		if (!isNextUpRoute) setSelectedGameId(id);
		setSelectedTags([]);
	}, [id, isNextUpRoute, setSelectedGameId]);

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
			const bannerShell = root.querySelector<HTMLElement>(".detail-hero-banner-shell");
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
				{ autoAlpha: 1, duration: 0.28, ease: "power2.out" },
				0,
			);

			if (bannerShell) {
				timeline.fromTo(
					bannerShell,
					{ autoAlpha: 0, y: -14, scale: 1.03 },
					{ autoAlpha: 1, y: 0, scale: 1, duration: 0.36, ease: "power3.out" },
					0,
				);
			}

			if (coverShell) {
				timeline.fromTo(
					coverShell,
					{ autoAlpha: 0, y: 18, scale: 0.94 },
					{ autoAlpha: 1, y: 0, scale: 1, duration: 0.36, ease: "power3.out" },
					0.04,
				);
			}

			if (copy) {
				timeline.fromTo(
					copy,
					{ autoAlpha: 0, y: 12 },
					{ autoAlpha: 1, y: 0, duration: 0.28, ease: "power2.out" },
					0.08,
				);
			}

			if (actions) {
				timeline.fromTo(
					actions,
					{ autoAlpha: 0, y: 12 },
					{ autoAlpha: 1, y: 0, duration: 0.28, ease: "power2.out" },
					0.10,
				);
			}

			if (info) {
				timeline.fromTo(
					info,
					{ autoAlpha: 0, y: 12 },
					{ autoAlpha: 1, y: 0, duration: 0.28, ease: "power2.out" },
					0.12,
				);
			}

			if (secondary.length) {
				timeline.fromTo(
					secondary,
					{ autoAlpha: 0, y: 12 },
					{ autoAlpha: 1, y: 0, duration: 0.28, stagger: 0.03, ease: "power2.out" },
					0.14,
				);
			}
		}, root);

		return () => {
			if (root.dataset.detailMotionClosing === "true") return;
			ctx.revert();
		};
	}, [id, isLoadingSelectedGame, selectedGame]);

	const handleSourceDraft = useCallback(
		(draft: GameMetadataDraft) => {
			void (async () => {
				try {
					const currentCustomData = isNextUpRoute
						? nextUpGame?.customData
						: rawSelectedGame?.custom_data;

					const bgmId =
						draft.sources.find((s) => s.source === "bgm")?.external_id ??
						selectedGame?.sourceIds?.bgm;
					if (bgmId) {
						try {
							const freshStaff = await fetchBgmStaffById(bgmId);
							if (freshStaff && freshStaff.length > 0) {
								if (!draft.custom_data) draft.custom_data = {};
								draft.custom_data.staff = freshStaff;
							}
						} catch (err) {
							console.warn("更新资料拉取制作人员失败:", err);
						}
					}

					const updates = buildMetadataUpdatePayload(
						draft,
						[],
						isNextUpRoute
							? nextUpRawGame?.sources ?? []
							: rawSelectedGame?.sources ?? [],
						currentCustomData,
					);

					// 若当前游戏没有自定义底图，自动从拉取到的截图选取一张高清大图作为底图
					const hasExistingBackdrop = Boolean(currentCustomData?.detail_backdrop);
					if (!hasExistingBackdrop && !isNextUpRoute) {
						const candidateScreenshots: string[] = [];
						for (const record of draft.sources) {
							try {
								const adapter = getSourceAdapter(record.source);
								if (record.data) {
									const fields = adapter.toDisplayFields(record.data);
									if (fields.screenshots && Array.isArray(fields.screenshots)) {
										candidateScreenshots.push(...fields.screenshots);
									}
								}
							} catch {
								// ignore adapter errors
							}
						}
						const validScreenshots = Array.from(
							new Set(
								candidateScreenshots.filter(
									(url) => Boolean(url && typeof url === "string" && url.startsWith("http")),
								),
							),
						);
						if (validScreenshots.length > 0) {
							try {
								const bestUrl = await pickBestScreenshotUrl(validScreenshots);
								if (bestUrl) {
									const identifier = await saveGalleryImageAs(
										id,
										{ type: "remote", url: bestUrl },
										"detail",
										undefined,
									);
									if (identifier) {
										updates.custom_data = {
											...(updates.custom_data ?? currentCustomData ?? {}),
											detail_backdrop: identifier,
											detail_backdrop_focus: { x: 50, y: 50 },
										};
									}
								}
							} catch (err) {
								console.warn("自动设置高清底图失败:", err);
							}
						}
					}

					if (isNextUpRoute) {
						if (!nextUpGame) throw new Error("Next up game not found");
						updateNextUpGame(id, applyNextUpEditUpdates(nextUpGame, updates));
					} else {
						await fileService.deleteCloudCoverCache(id);
						await updateGameMutation.mutateAsync({ gameId: id, updates });
						queryClient.invalidateQueries({ queryKey: gameStaffKeys.all });
					}
					snackbar.success(
						t("pages.Detail.Edit.updateSuccess", "游戏信息已更新"),
					);
				} catch (error) {
					snackbar.error(getUserErrorMessage(error, t));
				}
			})();
		},
		[
			id,
			isNextUpRoute,
			nextUpGame,
			nextUpRawGame,
			rawSelectedGame,
			t,
			updateGameMutation,
			updateNextUpGame,
		],
	);

	const handleImportNextUpGame = useCallback(async () => {
		if (!nextUpGame) return;
		try {
			const runtimeOptions = await selectNextUpRuntimeOptions();
			if (!runtimeOptions) return;
			const inserted = await addGameFromMetadata(
				buildNextUpMetadataDraft(nextUpGame),
				runtimeOptions,
			);
			const assets = await copyNextUpAssetsToLibrary(nextUpGame, inserted.id);
			if (
				assets.image ||
				assets.banner ||
				nextUpGame.date ||
				Object.keys(assets.customData).length > 0
			) {
				await updateGameMutation.mutateAsync({
					gameId: inserted.id,
					updates: {
						...(nextUpGame.date ? { date: nextUpGame.date } : {}),
						custom_data: {
							...inserted.custom_data,
							...assets.customData,
							...(assets.image ? { image: assets.image } : {}),
							...(assets.banner ? { banner: assets.banner } : {}),
						},
					},
				});
			}
			replaceNextUpGame(nextUpGame.id, inserted.id);
			await deleteNextUpAssets(nextUpGame);
			snackbar.success(
				t("home.nextUp.importedToLibrary", "已设置游戏路径并加入游戏库"),
			);
			animateDetailClose({
				onComplete: () => navigate(`/libraries/${inserted.id}`),
			});
		} catch (error) {
			snackbar.error(getUserErrorMessage(error, t));
		}
	}, [
		addGameFromMetadata,
		navigate,
		nextUpGame,
		replaceNextUpGame,
		t,
		updateGameMutation,
	]);

	const handleSaveNextUpEdit = useCallback(
		async (updates: UpdateGameParams): Promise<FullGameData> => {
			if (!nextUpGame || !nextUpDisplayGame) {
				throw new Error("Next up game not found");
			}

			const virtualUpdates = applyNextUpEditUpdates(nextUpGame, updates);
			updateNextUpGame(nextUpGame.id, virtualUpdates);
			snackbar.success(
				t("pages.Detail.Edit.updateSuccess", "游戏信息已更新"),
			);
			setDetailPanel("overview");

			return {
				...nextUpDisplayGame,
				date: virtualUpdates.date ?? nextUpGame.date,
				sources: candidateSourcesToGameSources(
					virtualUpdates.sourceRecords ?? nextUpGame.sourceRecords ?? [],
				),
				custom_data: {
					...nextUpDisplayGame.custom_data,
					...virtualUpdates.customData,
				},
			} as unknown as FullGameData;
		},
		[
			nextUpDisplayGame,
			nextUpGame,
			setDetailPanel,
			t,
			updateNextUpGame,
		],
	);

	const handleSaveDetailEdit = useCallback(
		async (updates: UpdateGameParams): Promise<FullGameData> => {
			if (isNextUpRoute) {
				return handleSaveNextUpEdit(updates);
			}
			return updateGameMutation.mutateAsync({ gameId: id, updates });
		},
		[handleSaveNextUpEdit, id, isNextUpRoute, updateGameMutation],
	);

	const bgmId = selectedGame?.sourceIds.bgm;
	const { data: staff = [] } = useGameStaff(bgmId);
	const customStaff = selectedGame?.custom_data?.staff;
	const hasCustomStaff =
		selectedGame?.custom_data?.staff_overridden === true ||
		(customStaff?.length ?? 0) > 0;
	const visibleStaff = hasCustomStaff ? (customStaff ?? []) : staff;
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
				members: visibleStaff.filter((member) => member.roles.includes(role)),
			}))
			.filter(({ members }) => members.length > 0);
	}, [visibleStaff]);
	const staffSummary = staffByRole
		.map(({ role, members }) => {
			const names = members
				.map((member) => member.name.trim())
				.filter(Boolean)
				.join("、");
			if (!names) return "";
			return `${t(`pages.Detail.staffRoles.${role}`, role)} ${names}`;
		})
		.filter(Boolean)
		.join(" · ");

	useEffect(() => {
		if (!selectedGame) return;
		const cover = getGameCover(selectedGame);
		const heroImage =
			getGameDetailBackdrop(selectedGame, activeCustomRoot) ??
			(isNextUpRoute && nextUpGame
				? getNextUpAssetUrl(nextUpGame, "banner") ||
					getGameBanner(selectedGame) ||
					resolveImageUrl(nextUpGame.banner) ||
					cover
				: getGameBanner(selectedGame) ?? cover);
		if (!heroImage || typeof Image === "undefined") return;
		const image = new Image();
		image.decoding = "async";
		image.fetchPriority = "high";
		image.src = heroImage;
	}, [activeCustomRoot, isNextUpRoute, nextUpGame, resolveImageUrl, selectedGame]);

	if (isNextUpRoute && !nextUpGame) {
		return (
			<Box key={id} className="skerry-detail-page">
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
			<Box key={id} className="skerry-detail-page">
				<Box className="detail-soft-loading" role="status" aria-live="polite">
					<CircularProgress size={18} thickness={4} />
					<Typography variant="caption" fontWeight={800}>
						{t("pages.Detail.loading", "Loading...")}
					</Typography>
				</Box>
			</Box>
		);
	}

	const cover =
		getGameCover(selectedGame);
	const banner =
		isNextUpRoute && nextUpGame
			? getNextUpAssetUrl(nextUpGame, "banner") ||
				getGameBanner(selectedGame) ||
				resolveImageUrl(nextUpGame.banner) ||
				cover
			: getGameBanner(selectedGame) ?? cover;
	const detailBackdrop = getGameDetailBackdrop(selectedGame, activeCustomRoot);
	const detailHeroImage = detailBackdrop ?? banner;
	const detailBackdropFocus = selectedGame.custom_data?.detail_backdrop_focus ?? selectedGame.custom_data?.banner_focus;
	const detailHeroObjectPosition = detailBackdropFocus
		? `${normalizeBackdropFocus(detailBackdropFocus).x}% ${normalizeBackdropFocus(detailBackdropFocus).y}%`
		: "center";
	const developers = getDeveloperNames(
		selectedGame.developer,
		t("category.unknownDeveloper", "Unknown developer"),
	);
	const tags = selectedGame.tags ?? [];
	return (
		<Box className="skerry-detail-page">
			<Box className="game-detail-fixed">
				<Box className="detail-hero">
					<Box
						component="img"
						src={detailHeroImage}
						alt=""
						className="detail-hero-bg"
						loading="eager"
						decoding="async"
						fetchPriority="high"
						style={{ objectPosition: detailHeroObjectPosition }}
						onError={(e: any) => { e.currentTarget.style.display = 'none'; }}
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
										onClick={(event) => setPlayStatusMenuAnchor(event.currentTarget)}
										className={`detail-badge-playstatus ${
											selectedGame.clear && DETAIL_PLAY_STATUS_CONFIG[selectedGame.clear]
												? DETAIL_PLAY_STATUS_CONFIG[selectedGame.clear].colorClass
												: "status-badge-default"
										}`}
									>
										<Box
											component="span"
											className={
												selectedGame.clear && DETAIL_PLAY_STATUS_CONFIG[selectedGame.clear]
													? DETAIL_PLAY_STATUS_CONFIG[selectedGame.clear].dotClass
													: ""
											}
											sx={{
												width: 7,
												height: 7,
												borderRadius: "50%",
												bgcolor:
													selectedGame.clear && DETAIL_PLAY_STATUS_CONFIG[selectedGame.clear]
														? "currentColor"
														: "rgba(255, 255, 255, 0.4)",
												boxShadow:
													selectedGame.clear && DETAIL_PLAY_STATUS_CONFIG[selectedGame.clear]
														? "0 0 6px currentColor"
														: "none",
												flexShrink: 0,
											}}
										/>
										<span>
											{selectedGame.clear && DETAIL_PLAY_STATUS_CONFIG[selectedGame.clear]
												? DETAIL_PLAY_STATUS_CONFIG[selectedGame.clear].label
												: "+ 状态"}
										</span>
										<span className="detail-badge-playstatus-arrow">▾</span>
									</Box>
									<span className="detail-badge-vendor">
										{developers[0] || "UNKNOWN"}
									</span>
									{hasRating(selectedGame.score ?? selectedGame.custom_data?.user_rating) && (
										<span className="detail-badge-bgm">
											<span className="detail-badge-star">★</span>
											<span>{formatScoreValue(selectedGame.score ?? selectedGame.custom_data?.user_rating)}</span>
										</span>
									)}
									<span className="detail-badge-playtime">
										Playtime: <span className="detail-badge-playtime-val">{gameStatsQuery.data?.totalPlayTime || (selectedGame.average_hours ? `${selectedGame.average_hours}h` : '0小时')}</span>
									</span>
								</Box>
								<Typography className="detail-title">
									{getGameDisplayName(selectedGame)}
								</Typography>
								<Typography className="detail-subtitle">
									<span className="detail-subtitle-text">
										{selectedGame.name}
									</span>
									{staffByRole.length > 0 ? (
										<span className="detail-badge-staff">
											{staffByRole.map(({ role, members }, roleIdx) => {
												const names = members
													.map((m) => m.name.trim())
													.filter(Boolean)
													.join("、");
												return (
													<Fragment key={role}>
														{roleIdx > 0 && <span className="detail-badge-staff-sep">/</span>}
														<span className="detail-badge-staff-role">{t(`pages.Detail.staffRoles.${role}`, role)}</span>
														<span className="detail-badge-staff-names">{names}</span>
													</Fragment>
												);
											})}
										</span>
									) : staffSummary ? (
										<span className="detail-badge-staff">{staffSummary}</span>
									) : null}
								</Typography>
							</Box>
						</Box>

						<Box className="detail-action-group">
							{!isNextUpRoute && <LaunchModal />}
							{!isNextUpRoute && (
								<Button
									className="detail-secondary-button"
									endIcon={<ArrowDropDownRoundedIcon />}
									onClick={(event) => setOpenActionsMenuAnchor(event.currentTarget)}
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
								{Object.entries(DETAIL_PLAY_STATUS_CONFIG).map(([key, item]) => {
									const statusVal = Number(key);
									const isSelected = selectedGame?.clear === statusVal;
									return (
										<MenuItem
											key={key}
											onClick={() => void handlePlayStatusSelect(statusVal as PlayStatus)}
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
											<Typography sx={{ fontSize: "13px", fontWeight: isSelected ? 700 : 500 }}>
												{item.label}
											</Typography>
										</MenuItem>
									);
								})}
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
									<ListItemIcon><FolderOpenRoundedIcon /></ListItemIcon>
									<ListItemText primary="打开文件夹" />
								</MenuItem>
								<MenuItem
									disabled={!selectedGame?.localpath}
									onClick={() => {
										setOpenActionsMenuAnchor(null);
										void handleOpenGameText();
									}}
								>
									<ListItemIcon><DescriptionRoundedIcon /></ListItemIcon>
									<ListItemText primary="打开文本" />
								</MenuItem>
							</Menu>
							{isNextUpRoute && (
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
								className="detail-secondary-button"
								onClick={() => setSourceUpdateOpen(true)}
							>
								更新资料
							</Button>
							<MoreButton
								selectedGame={selectedGame}
								variant="hamburger"
								className="detail-more-button"
								onlySourceLinks={isNextUpRoute}
							/>
							<IconButton
								className="detail-more-button detail-backdrop-button"
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
									<ListItemIcon><CropFreeRoundedIcon /></ListItemIcon>
									<ListItemText primary="调整显示位置" />
								</MenuItem>
								<MenuItem
									disabled={!selectedGame?.custom_data?.detail_backdrop_focus}
									onClick={() => {
										setBackdropMenuAnchor(null);
										void handleResetBackdropFocus();
									}}
								>
									<ListItemIcon><RestartAltRoundedIcon /></ListItemIcon>
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
								className={detailPanel === "overview" ? "is-active" : ""}
								onClick={() => setDetailPanel("overview")}
							>
								剧情概要 (Story & Overview)
							</span>
							{!isNextUpRoute && (
								<span
									className={detailPanel === "stats" ? "is-active" : ""}
									onClick={() => setDetailPanel("stats")}
								>
									游戏统计
								</span>
							)}
							{!isNextUpRoute && (
								<span
									className={detailPanel === "save" ? "is-active" : ""}
									onClick={() => setDetailPanel("save")}
								>
									存档管理
								</span>
							)}
							<span
								className={detailPanel === "review" ? "is-active" : ""}
								onClick={() => setDetailPanel("review")}
							>
								评测
							</span>
							<span
								className={detailPanel === "edit" ? "is-active" : ""}
								onClick={() => setDetailPanel("edit")}
							>
								游戏编辑
							</span>
						</Box>

						{detailPanel === "overview" && (
							<Box className="detail-overview">
								{summaryExpanded ? (
								<Typography
										className="detail-summary detail-summary-expanded"
										sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
									>
										{renderSummaryWithLineBreaks(selectedGame.summary)}
										<Box
											className="detail-summary-toggle"
											component="button"
											type="button"
											onClick={() => setSummaryExpanded(false)}
										>
											⤴ 收起排版
										</Box>
									</Typography>
								) : (
									<Typography className="detail-summary">
										<span className="detail-drop-cap">
											{(selectedGame.summary || "新").charAt(0)}
										</span>
										{(selectedGame.summary || "暂无剧情概要可用。").substring(1)}
										<Box
											className="detail-summary-toggle"
											component="button"
											type="button"
											onClick={() => setSummaryExpanded(true)}
										>
											⤵ 完全显示
										</Box>
									</Typography>
								)}

								<Box className="detail-tag-row">
									{tags.slice(0, 10).map((tag) => (
										<span key={tag} className="detail-tag-pill">
											{getTagDisplayName(tag, tagTranslation)}
										</span>
									))}
								</Box>

								<Box className="detail-gallery-section">
									<Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
										<Typography className="detail-panel-title" sx={{ mb: 0 }}>画廊 (GALLERY CG)</Typography>
										<Button
											size="small"
											sx={{
												color: 'rgba(255, 255, 255, 0.85)',
												border: '1px solid rgba(255, 255, 255, 0.2)',
												borderRadius: '4px',
												px: 1.5,
												py: 0.35,
												fontSize: '11px',
												fontWeight: 600,
												background: 'rgba(255, 255, 255, 0.05)',
												backdropFilter: 'blur(8px)',
												'&:hover': {
													background: 'rgba(0, 229, 255, 0.12)',
													borderColor: '#00e5ff',
													color: '#00e5ff',
												}
											}}
											onClick={() => setManageCgDialogOpen(true)}
										>
											CG管理
										</Button>
									</Box>

									{/* 纯净的画廊网格 */}
									<Box className="detail-gallery-grid">
										{(customCgUrls.length > 0 || sourceScreenshots.length > 0
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
						)}

						{detailPanel === "stats" && (
							<Box className="detail-stats-tab-content" sx={{ mt: 2 }}>
								<GameStatsOverview gameID={id} showSummary={true} />
							</Box>
						)}
                        
						{!isNextUpRoute && detailPanel === "save" && <SaveData />}
						{!isNextUpRoute && detailPanel === "review" && (
							<Review selectedGame={selectedGame} />
						)}
						{detailPanel === "edit" && (
							<LibraryGameEdit
								selectedGame={selectedGame}
								rawGame={isNextUpRoute ? nextUpRawGame : rawSelectedGame ?? undefined}
								virtualGame={isNextUpRoute ? nextUpGame : undefined}
								onSave={handleSaveDetailEdit}
							/>
						)}
						{isNextUpRoute && detailPanel === "review" && nextUpGame && (
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

					<Box className="detail-side-column">
						<Box className="detail-panel compact">
							<Typography className="detail-panel-title">PLAYER STATS / 游玩统计</Typography>
							<Box className="detail-stats-grid">
								<Box className="detail-stat-item">
									<Box className="detail-stat-circle is-green">
										{formatCompactPlaytime(
											gameStatsQuery.data?.totalMinutes ?? gameStatsQuery.data?.totalPlayTime,
											"0m",
										)}
									</Box>
									<Typography className="detail-stat-label">Total</Typography>
								</Box>
								<Box className="detail-stat-item">
									<Box className="detail-stat-circle">
										{formatCompactPlaytime(gameStatsQuery.data?.todayPlayTime, "0m")}
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
							<Typography className="detail-panel-title">DOSSIER SPECS / 作品档案</Typography>
							<Box className="dossier-row">
								<span className="dossier-key">开发商</span>
								<span className="dossier-value">{developers.join(", ") || "-"}</span>
							</Box>
							<Box className="dossier-row">
								<span className="dossier-key">发行商</span>
								<span className="dossier-value">-</span>
							</Box>
							<Box className="dossier-row">
								<span className="dossier-key">发售日期</span>
								<span className="dossier-value">{selectedGame.date || "-"}</span>
							</Box>
							{selectedGame.created_at && (
								<Box className="dossier-row">
									<span className="dossier-key">添加时间</span>
									<span className="dossier-value">
										{new Date(selectedGame.created_at * 1000).toLocaleDateString()}
									</span>
								</Box>
							)}
						</Box>

						<Box className="detail-panel compact">
							<Typography className="detail-panel-title">COMMUNITY FEEDS / 社区动态</Typography>
							<Box className="dossier-row">
								<span className="dossier-key">社区评分</span>
								<span className="dossier-value" style={{ color: "#f59e0b" }}>
									{hasRating(selectedGame.score) ? `★ ${formatScoreValue(selectedGame.score)}` : "-"}
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
								<span className="dossier-value" style={{ fontSize: "11px", opacity: 0.8 }}>
									<span className="dossier-source-ids">
										{selectedGame.sourceIds
											? Object.entries(selectedGame.sourceIds)
												.map(([sourceKey, sourceId]) => (
													<span key={`${sourceKey}:${sourceId}`}>{`${sourceKey}:${sourceId}`}</span>
												))
											: "-"}
									</span>
								</span>
							</Box>
						</Box>
					</Box>
				</Box>
			</Box>
			{!isNextUpRoute && (
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
