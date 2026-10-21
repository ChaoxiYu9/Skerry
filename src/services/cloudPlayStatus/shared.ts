import {
	fetchAllSettings,
	fetchBgmCurrentUserProfile,
} from "@/hooks/queries/useSettings";
import type { HikarinagiStatus } from "@/metadata/api/hikarinagi";
import type { fetchVndbUserCollection } from "@/metadata/api/vndb";
import {
	getAnySourceId,
	type SourceIdentityPayload,
} from "@/metadata/sourceRecord";
import { queryClient } from "@/providers/queryClient";
import { PlayStatus } from "@/types/collection";
import { resolveCloudStatusByPriority } from "./syncPlan";

export interface CloudPlayStatusContext {
	bgm?: Map<string, PlayStatus>;
	vndb?: Map<string, PlayStatus>;
	hikarinagi?: Map<string, PlayStatus>;
	kun?: Map<string, PlayStatus>;
}

const VNDB_STATUS_LABEL_IDS = {
	PLAYING: 1,
	PLAYED: 2,
	ON_HOLD: 3,
	DROPPED: 4,
	WISH: 5,
} as const;

const VNDB_STATUS_LABEL_NAMES = {
	PLAYING: "Playing",
	PLAYED: "Finished",
	ON_HOLD: "Stalled",
	DROPPED: "Dropped",
	WISH: "Wishlist",
} as const;

export const VNDB_NORMAL_STATUS_LABEL_IDS = [
	VNDB_STATUS_LABEL_IDS.PLAYING,
	VNDB_STATUS_LABEL_IDS.PLAYED,
	VNDB_STATUS_LABEL_IDS.ON_HOLD,
	VNDB_STATUS_LABEL_IDS.DROPPED,
	VNDB_STATUS_LABEL_IDS.WISH,
];

export async function getVndbToken() {
	try {
		const settings = await fetchAllSettings(queryClient);
		return settings.vndb_token ?? "";
	} catch (error) {
		console.error("获取 VNDB Token 失败:", error);
		return "";
	}
}

export async function getBgmUsername(token: string) {
	const settings = await fetchAllSettings(queryClient);
	if (settings.bgm_auth?.username) return settings.bgm_auth.username;
	const profile = await fetchBgmCurrentUserProfile(queryClient, token);
	return profile.username;
}

export function mapBgmTypeToPlayStatus(type?: number | null) {
	switch (type) {
		case PlayStatus.WISH:
		case PlayStatus.PLAYED:
		case PlayStatus.PLAYING:
		case PlayStatus.ON_HOLD:
		case PlayStatus.DROPPED:
			return type;
		default:
			return undefined;
	}
}

export function mapVndbCollectionToPlayStatus(
	collection: Awaited<ReturnType<typeof fetchVndbUserCollection>>,
) {
	if (!collection?.labels?.length) return undefined;

	const hasLabel = (id: number, name: string) =>
		collection.labels.some((label) => label.id === id || label.label === name);

	if (
		hasLabel(VNDB_STATUS_LABEL_IDS.PLAYING, VNDB_STATUS_LABEL_NAMES.PLAYING)
	) {
		return PlayStatus.PLAYING;
	}
	if (hasLabel(VNDB_STATUS_LABEL_IDS.PLAYED, VNDB_STATUS_LABEL_NAMES.PLAYED)) {
		return PlayStatus.PLAYED;
	}
	if (
		hasLabel(VNDB_STATUS_LABEL_IDS.ON_HOLD, VNDB_STATUS_LABEL_NAMES.ON_HOLD)
	) {
		return PlayStatus.ON_HOLD;
	}
	if (
		hasLabel(VNDB_STATUS_LABEL_IDS.DROPPED, VNDB_STATUS_LABEL_NAMES.DROPPED)
	) {
		return PlayStatus.DROPPED;
	}
	if (hasLabel(VNDB_STATUS_LABEL_IDS.WISH, VNDB_STATUS_LABEL_NAMES.WISH)) {
		return PlayStatus.WISH;
	}

	return undefined;
}

export function mapPlayStatusToVndbLabelId(status: PlayStatus) {
	switch (status) {
		case PlayStatus.PLAYING:
			return VNDB_STATUS_LABEL_IDS.PLAYING;
		case PlayStatus.PLAYED:
			return VNDB_STATUS_LABEL_IDS.PLAYED;
		case PlayStatus.ON_HOLD:
			return VNDB_STATUS_LABEL_IDS.ON_HOLD;
		case PlayStatus.DROPPED:
			return VNDB_STATUS_LABEL_IDS.DROPPED;
		case PlayStatus.WISH:
			return VNDB_STATUS_LABEL_IDS.WISH;
		default:
			return undefined;
	}
}

export function mapHikarinagiStatusToPlayStatus(
	status?: HikarinagiStatus | null,
) {
	switch (status) {
		case "GOING":
			return PlayStatus.PLAYING;
		case "COMPLETED":
			return PlayStatus.PLAYED;
		case "ON_HOLD":
			return PlayStatus.ON_HOLD;
		case "DROPPED":
			return PlayStatus.DROPPED;
		case "PLAN":
			return PlayStatus.WISH;
		default:
			return undefined;
	}
}

export function mapPlayStatusToHikarinagiStatus(
	status: PlayStatus,
): HikarinagiStatus {
	switch (status) {
		case PlayStatus.PLAYING:
			return "GOING";
		case PlayStatus.PLAYED:
			return "COMPLETED";
		case PlayStatus.ON_HOLD:
			return "ON_HOLD";
		case PlayStatus.DROPPED:
			return "DROPPED";
		case PlayStatus.WISH:
			return "PLAN";
	}
}

export function mapKungalStatusToPlayStatus(status?: string | null) {
	switch (status) {
		case "doing":
			return PlayStatus.PLAYING;
		case "done":
			return PlayStatus.PLAYED;
		case "on_hold":
			return PlayStatus.ON_HOLD;
		case "dropped":
			return PlayStatus.DROPPED;
		case "wish":
			return PlayStatus.WISH;
		default:
			return undefined;
	}
}

export function mapPlayStatusToKungalStatus(
	status: PlayStatus,
): "doing" | "done" | "on_hold" | "dropped" | "wish" {
	switch (status) {
		case PlayStatus.PLAYING:
			return "doing";
		case PlayStatus.PLAYED:
			return "done";
		case PlayStatus.ON_HOLD:
			return "on_hold";
		case PlayStatus.DROPPED:
			return "dropped";
		case PlayStatus.WISH:
			return "wish";
	}
}

export function resolveCloudPlayStatusFromContext(
	game: SourceIdentityPayload,
	context: CloudPlayStatusContext,
) {
	return resolveCloudStatusByPriority(
		{
			bgm: getAnySourceId(game, "bgm"),
			vndb: getAnySourceId(game, "vndb"),
			hikarinagi: getAnySourceId(game, "hikarinagi"),
			kun: getAnySourceId(game, "kun"),
		},
		context,
	);
}
