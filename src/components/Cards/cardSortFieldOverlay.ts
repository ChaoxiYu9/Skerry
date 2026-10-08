import type { TFunction } from "i18next";
import type { SortOption } from "@/services/invoke/types";
import type { GameData } from "@/types";
import { formatDateLabel, getLocalDateString } from "@/utils/dateTime";
import type { CardSortFieldOverlay } from "./types";

interface CardSortFieldOverlayParams {
	game: GameData;
	sortOption: SortOption;
	lastPlayed?: number | null;
	language: string;
	t: TFunction;
}

function formatScore(value: number | null | undefined) {
	return value ? value.toFixed(1) : null;
}

function formatRank(value: number | null | undefined) {
	return value && value > 0 ? `#${value}` : null;
}

function formatBgmOverlay(
	score: number | null | undefined,
	rank: number | null | undefined,
) {
	const parts = [formatScore(score), formatRank(rank)].filter(Boolean);
	return parts.length > 0 ? parts.join(" ") : null;
}

function formatLastPlayedOverlay(
	timestamp: number | null | undefined,
	language: string,
	t: TFunction,
) {
	if (!timestamp) return null;
	return formatDateLabel(timestamp, {
		language,
		todayLabel: t("common.today", "今天"),
		yesterdayLabel: t("common.yesterday", "昨天"),
		showRecentTime: true,
	});
}

export function getCardSortFieldOverlay({
	game,
	sortOption,
	lastPlayed,
	language,
	t,
}: CardSortFieldOverlayParams): CardSortFieldOverlay | undefined {
	let value: string | null;

	switch (sortOption) {
		case "addtime":
			value = game.created_at ? getLocalDateString(game.created_at) : null;
			break;
		case "datetime":
			value = game.date || null;
			break;
		case "userratingrank":
			value = formatScore(game.custom_data?.user_rating);
			break;
		case "bgmrank":
			value = formatBgmOverlay(game.sourceScores?.bgm, game.rank);
			break;
		case "vndbrank":
			value = formatScore(game.sourceScores?.vndb);
			break;
		case "lastplayed":
			value = formatLastPlayedOverlay(lastPlayed, language, t);
			break;
		case "namesort":
			value = null;
			break;
	}

	return value ? { value } : undefined;
}
