import { saveDataKeys } from "@/hooks/queries/useSavedata";
import { settingsKeys } from "@/hooks/queries/useSettings";
import { statsKeys } from "@/hooks/queries/useStats";
import { queryClient } from "@/providers/queryClient";
import { getCgIdentifierUrl } from "@/services/game/customCover";
import { getFormattedGameStats } from "@/services/game/gameStats";
import { savedataService, statsService } from "@/services/invoke";
import type { UserSettings } from "@/services/invoke/settingsService";
import type { GameData } from "@/types";
import {
	getGameBannerOrCover,
	getGameCover,
	getGameDetailBackdrop,
} from "@/utils/game";

const DETAIL_SESSION_WARMUP_LIMIT = 30;
const DETAIL_WARMUP_TTL_MS = 60_000;

const detailWarmupAt = new Map<number, number>();

async function preloadImage(src: string): Promise<void> {
	if (!src || typeof Image === "undefined") return;
	await new Promise<void>((resolve) => {
		const image = new Image();
		image.decoding = "async";
		image.onload = () => {
			if (image.decode) {
				image
					.decode()
					.catch(() => undefined)
					.then(resolve);
				return;
			}
			resolve();
		};
		image.onerror = () => resolve();
		image.src = src;
		if (image.complete) resolve();
	});
}

async function runDetailWarmup(game: GameData) {
	const settings = queryClient.getQueryData<UserSettings>(
		settingsKeys.allSettings(),
	);
	const customRoot = settings?.detail_backdrop_path;
	const customCgs: string[] = (game.custom_data as any)?.cgs ?? [];
	const customCgUrls = customCgs
		.slice(0, 8)
		.map((entry) => getCgIdentifierUrl(game.id, entry, customRoot));

	await Promise.allSettled([
		queryClient.prefetchQuery({
			queryKey: statsKeys.gameStats(game.id),
			queryFn: () => getFormattedGameStats(game.id),
		}),
		queryClient.prefetchQuery({
			queryKey: statsKeys.sessions(game.id, DETAIL_SESSION_WARMUP_LIMIT),
			queryFn: () =>
				statsService.getGameSessions(game.id, DETAIL_SESSION_WARMUP_LIMIT),
		}),
		queryClient.prefetchQuery({
			queryKey: saveDataKeys.backupCount(game.id),
			queryFn: () => savedataService.getSavedataCount(game.id),
		}),
		queryClient.prefetchQuery({
			queryKey: saveDataKeys.backups(game.id),
			queryFn: () => savedataService.getSavedataRecords(game.id),
		}),
		preloadImage(getGameCover(game)),
		preloadImage(getGameBannerOrCover(game)),
		preloadImage(getGameDetailBackdrop(game, customRoot) ?? ""),
		...customCgUrls.map((url) => preloadImage(url)),
	]);
}

export function warmupGameDetailCaches(game: GameData) {
	const now = Date.now();
	const previous = detailWarmupAt.get(game.id) ?? 0;
	if (now - previous < DETAIL_WARMUP_TTL_MS) return;
	detailWarmupAt.set(game.id, now);

	void runDetailWarmup(game).catch((error) => {
		console.debug("Skerry detail cache warmup skipped:", game.id, error);
	});
}
