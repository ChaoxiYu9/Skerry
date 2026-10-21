import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { gameStaffKeys } from "@/hooks/queries/useGameStaff";
import { fetchBgmStaffById } from "@/metadata/api/bgm";
import { buildMetadataUpdatePayload } from "@/metadata/data/metadata";
import { getSourceAdapter } from "@/metadata/sourceRegistry";
import { applyNextUpEditUpdates } from "@/pages/NextUpDetail/nextUpLibraryImport";
import { queryClient } from "@/providers/queryClient";
import { snackbar } from "@/providers/snackBar";
import { saveGalleryImageAs, saveRemoteCgs } from "@/services/game/customCover";
import { fileService } from "@/services/invoke";
import type { NextUpVirtualGame } from "@/store/appStore";
import { useStore } from "@/store/appStore";
import type {
	FullGameData,
	GameData,
	GameMetadataDraft,
	UpdateGameParams,
} from "@/types";
import { getUserErrorMessage } from "@/utils/errors";
import type { DetailSceneKind } from "../detailSceneCapabilities";

async function pickBestScreenshotUrl(urls: string[]): Promise<string> {
	const valid = urls.filter(
		(url) => url && typeof url === "string" && url.startsWith("http"),
	);
	if (valid.length === 0) return urls[0] ?? "";
	const candidates = valid.slice(0, 5);
	let bestUrl = candidates[0];
	let maxScore = 0;

	await Promise.all(
		candidates.map(async (url) => {
			try {
				const image = new Image();
				image.src = url;
				await new Promise<void>((resolve, reject) => {
					image.onload = () => resolve();
					image.onerror = () => reject();
					setTimeout(reject, 2500);
				});
				const isLandscape = image.naturalWidth > image.naturalHeight;
				const score =
					image.naturalWidth * image.naturalHeight * (isLandscape ? 1.5 : 1);
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

interface DetailMetadataDraftOptions {
	id: number;
	sceneKind: DetailSceneKind;
	nextUpGame?: NextUpVirtualGame;
	nextUpRawGame?: FullGameData;
	rawSelectedGame?: FullGameData | null;
	selectedGame?: GameData | null;
	updateGame: (input: {
		gameId: number;
		updates: UpdateGameParams;
	}) => Promise<unknown>;
}

export function useDetailMetadataDraft({
	id,
	sceneKind,
	nextUpGame,
	nextUpRawGame,
	rawSelectedGame,
	selectedGame,
	updateGame,
}: DetailMetadataDraftOptions) {
	const { t } = useTranslation();
	const isNextUpRoute = sceneKind === "next-up";
	const updateNextUpGame = useStore((state) => state.updateNextUpVirtualGame);

	return useCallback(
		(draft: GameMetadataDraft) => {
			return (async () => {
				try {
					const currentCustomData = isNextUpRoute
						? nextUpGame?.customData
						: rawSelectedGame?.custom_data;

					const bgmId =
						draft.sources.find((source) => source.source === "bgm")
							?.external_id ?? selectedGame?.sourceIds?.bgm;
					if (bgmId) {
						try {
							const freshStaff = await fetchBgmStaffById(bgmId);
							if (freshStaff && freshStaff.length > 0) {
								if (!draft.custom_data) draft.custom_data = {};
								draft.custom_data.staff = freshStaff;
							}
						} catch (error) {
							console.warn("更新资料拉取制作人员失败:", error);
						}
					}

					const updates = buildMetadataUpdatePayload(
						draft,
						[],
						isNextUpRoute
							? (nextUpRawGame?.sources ?? [])
							: (rawSelectedGame?.sources ?? []),
						currentCustomData,
					);

					// 普通游戏没有自定义底图时，从来源截图选一张高清大图作为底图。
					const hasExistingBackdrop = Boolean(
						currentCustomData?.detail_backdrop ||
							currentCustomData?.banner ||
							rawSelectedGame?.custom_data?.detail_backdrop ||
							rawSelectedGame?.custom_data?.banner,
					);
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
								candidateScreenshots.filter((url) =>
									Boolean(
										url && typeof url === "string" && url.startsWith("http"),
									),
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
							} catch (error) {
								console.warn("自动设置高清底图失败:", error);
							}
						}
					}

					// 普通游戏画廊最多补充到 8 张，并跳过已有来源截图。
					if (!isNextUpRoute) {
						try {
							const existingCgs = currentCustomData?.cgs ?? [];
							const availableQuota = Math.max(0, 8 - existingCgs.length);
							if (availableQuota > 0) {
								const candidateGalleryUrls: string[] = [];
								for (const record of draft.sources) {
									try {
										const adapter = getSourceAdapter(record.source);
										if (record.data) {
											const fields = adapter.toDisplayFields(record.data);
											if (
												fields.screenshots &&
												Array.isArray(fields.screenshots)
											) {
												candidateGalleryUrls.push(...fields.screenshots);
											}
										}
									} catch {
										// ignore adapter errors
									}
								}
								const uniqueScreenshots = Array.from(
									new Set(
										candidateGalleryUrls.filter((url) =>
											Boolean(
												url &&
													typeof url === "string" &&
													url.startsWith("http"),
											),
										),
									),
								);
								const existingUrls =
									currentCustomData?.imported_screenshot_urls ?? [];
								const existingMap =
									currentCustomData?.imported_screenshot_map ?? {};
								const pendingUrls = uniqueScreenshots
									.filter((url) => !existingUrls.includes(url))
									.slice(0, availableQuota);

								if (pendingUrls.length > 0) {
									const savedIdentifiers = await saveRemoteCgs(id, pendingUrls);
									const nextUrls = [...existingUrls, ...pendingUrls];
									const nextMap = { ...existingMap };
									pendingUrls.forEach((url, index) => {
										if (savedIdentifiers[index]) {
											nextMap[url] = savedIdentifiers[index];
										}
									});

									updates.custom_data = {
										...(updates.custom_data ?? currentCustomData ?? {}),
										cgs: [...existingCgs, ...savedIdentifiers],
										imported_screenshot_urls: nextUrls,
										imported_screenshot_map: nextMap,
									};
								}
							}
						} catch (error) {
							console.warn("自动拉取剧照截图失败:", error);
						}
					}

					if (isNextUpRoute) {
						if (!nextUpGame) throw new Error("Next up game not found");
						updateNextUpGame(id, applyNextUpEditUpdates(nextUpGame, updates));
					} else {
						await fileService.deleteCloudCoverCache(id);
						await updateGame({ gameId: id, updates });
						queryClient.invalidateQueries({ queryKey: gameStaffKeys.all });
					}
					snackbar.success(
						t("pages.Detail.Edit.updateSuccess", "游戏信息已更新"),
					);
				} catch (error) {
					throw new Error(getUserErrorMessage(error, t));
				}
			})();
		},
		[
			id,
			isNextUpRoute,
			nextUpGame,
			nextUpRawGame,
			rawSelectedGame,
			selectedGame,
			t,
			updateGame,
			updateNextUpGame,
		],
	);
}
