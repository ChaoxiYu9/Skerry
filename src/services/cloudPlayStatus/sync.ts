import { fetchUserCollection, updateUserCollection } from "@/metadata/api/bgm";
import {
	fetchHikarinagiGameRate,
	updateHikarinagiGameRate,
} from "@/metadata/api/hikarinagi";
import { updateKunUserWorkRecord } from "@/metadata/api/kun";
import {
	fetchVndbUserCollection,
	updateVndbUserCollection,
} from "@/metadata/api/vndb";
import {
	getAnySourceId,
	type SourceIdentityPayload,
} from "@/metadata/sourceRecord";
import { withBgmAuth } from "@/services/oauth/bgmAuthSession";
import { withHikarinagiAuth } from "@/services/oauth/hikarinagiAuthSession";
import { withKungalAuth } from "@/services/oauth/kungalAuthSession";
import { getNetworkRequestContext } from "@/services/requestContext";
import { useStore } from "@/store/appStore";
import type { PlayStatus } from "@/types/collection";
import { createKunPlayStatusMap } from "./context";
import {
	type CollectionSyncSource,
	resolveCollectionSyncSources,
} from "./syncPlan";
import { createSerialTaskQueue } from "./serialTaskQueue";
import {
	type CloudPlayStatusContext,
	getBgmUsername,
	getVndbToken,
	mapBgmTypeToPlayStatus,
	mapHikarinagiStatusToPlayStatus,
	mapPlayStatusToHikarinagiStatus,
	mapPlayStatusToKungalStatus,
	mapPlayStatusToVndbLabelId,
	mapVndbCollectionToPlayStatus,
	resolveCloudPlayStatusFromContext,
	VNDB_NORMAL_STATUS_LABEL_IDS,
} from "./shared";

async function resolveBgmPlayStatus(game: SourceIdentityPayload) {
	const bgmId = getAnySourceId(game, "bgm");
	if (!bgmId) return undefined;

	try {
		const collection = await withBgmAuth(async (token) => {
			if (!token) return undefined;

			const username = await getBgmUsername(token);
			return fetchUserCollection(
				username,
				bgmId,
				token,
				getNetworkRequestContext(),
			);
		});
		return mapBgmTypeToPlayStatus(collection?.type);
	} catch (error) {
		console.error("解析 BGM 收藏状态失败:", error);
		return undefined;
	}
}

async function resolveVndbPlayStatus(game: SourceIdentityPayload) {
	const vndbId = getAnySourceId(game, "vndb");
	if (!vndbId) return undefined;

	try {
		const token = await getVndbToken();
		if (!token) return undefined;

		const collection = await fetchVndbUserCollection(
			vndbId,
			token,
			undefined,
			getNetworkRequestContext(),
		);
		return mapVndbCollectionToPlayStatus(collection);
	} catch (error) {
		console.error("解析 VNDB 收藏状态失败:", error);
		return undefined;
	}
}

async function resolveHikarinagiPlayStatus(game: SourceIdentityPayload) {
	const hikarinagiId = getAnySourceId(game, "hikarinagi");
	if (!hikarinagiId) return undefined;

	try {
		const rate = await withHikarinagiAuth(async (token) => {
			if (!token) return undefined;
			return fetchHikarinagiGameRate(
				hikarinagiId,
				token,
				getNetworkRequestContext(),
			);
		});
		return mapHikarinagiStatusToPlayStatus(rate?.status);
	} catch (error) {
		console.error("获取 Hikarinagi 游玩状态失败:", error);
		return undefined;
	}
}

async function resolveKunPlayStatus(game: SourceIdentityPayload) {
	const kunId = getAnySourceId(game, "kun");
	if (!kunId) return undefined;
	const statusMap = await createKunPlayStatusMap([kunId]);
	return statusMap?.get(kunId);
}

const playStatusResolvers: Record<
	CollectionSyncSource,
	(game: SourceIdentityPayload) => Promise<PlayStatus | undefined>
> = {
	bgm: resolveBgmPlayStatus,
	vndb: resolveVndbPlayStatus,
	hikarinagi: resolveHikarinagiPlayStatus,
	kun: resolveKunPlayStatus,
};

export async function resolveCloudPlayStatus(
	game: SourceIdentityPayload,
	context?: CloudPlayStatusContext,
) {
	const settings = useStore.getState();

	if (context) {
		const status = resolveCloudPlayStatusFromContext(game, context);
		if (status !== undefined) return status;
		return undefined;
	}

	for (const source of resolveCollectionSyncSources(settings)) {
		const status = await playStatusResolvers[source](game);
		if (status !== undefined) return status;
	}

	return undefined;
}

async function syncPlayStatusToBgm(
	game: SourceIdentityPayload,
	newStatus: PlayStatus,
) {
	const bgmId = getAnySourceId(game, "bgm");
	if (!bgmId) return true;

	try {
		return await withBgmAuth((token) => {
			if (!token) return Promise.resolve(true);

			return updateUserCollection(
				bgmId,
				{ type: newStatus },
				token,
				getNetworkRequestContext(),
			);
		});
	} catch (error) {
		console.error("同步 BGM 收藏状态失败:", error);
		return false;
	}
}

async function syncPlayStatusToVndb(
	game: SourceIdentityPayload,
	newStatus: PlayStatus,
) {
	const vndbId = getAnySourceId(game, "vndb");
	if (!vndbId) return true;

	try {
		const token = await getVndbToken();
		if (!token) return true;

		const targetLabelId = mapPlayStatusToVndbLabelId(newStatus);
		if (!targetLabelId) return true;

		return updateVndbUserCollection(
			vndbId,
			{
				labels_set: [targetLabelId],
				labels_unset: VNDB_NORMAL_STATUS_LABEL_IDS.filter(
					(labelId) => labelId !== targetLabelId,
				),
			},
			token,
			getNetworkRequestContext(),
		);
	} catch (error) {
		console.error("同步 VNDB 收藏状态失败:", error);
		return false;
	}
}

async function syncPlayStatusToHikarinagi(
	game: SourceIdentityPayload,
	newStatus: PlayStatus,
) {
	const hikarinagiId = getAnySourceId(game, "hikarinagi");
	if (!hikarinagiId) return true;

	try {
		return await withHikarinagiAuth(async (token) => {
			if (!token) return false;
			return updateHikarinagiGameRate(
				hikarinagiId,
				{ status: mapPlayStatusToHikarinagiStatus(newStatus) },
				token,
				getNetworkRequestContext(),
			);
		});
	} catch (error) {
		console.error("同步 Hikarinagi 游玩状态失败:", error);
		return false;
	}
}

async function syncPlayStatusToKun(
	game: SourceIdentityPayload,
	newStatus: PlayStatus,
) {
	const kunId = getAnySourceId(game, "kun");
	if (!kunId) return true;

	try {
		return await withKungalAuth(async (token) => {
			if (!token) return true;
			return updateKunUserWorkRecord(
				kunId,
				{
					work_state: {
						state: mapPlayStatusToKungalStatus(newStatus),
					},
				},
				token,
				getNetworkRequestContext(),
			);
		});
	} catch (error) {
		console.error("同步 KunGal 游玩状态失败:", error);
		return false;
	}
}

const syncHandlers: Record<
	CollectionSyncSource,
	(game: SourceIdentityPayload, status: PlayStatus) => Promise<boolean>
> = {
	bgm: syncPlayStatusToBgm,
	vndb: syncPlayStatusToVndb,
	hikarinagi: syncPlayStatusToHikarinagi,
	kun: syncPlayStatusToKun,
};

const enqueueStatusSync = createSerialTaskQueue();

export async function syncPlayStatusToCloud(
	game: SourceIdentityPayload,
	newStatus: PlayStatus,
): Promise<CollectionSyncSource[]> {
	const enabledSources = resolveCollectionSyncSources(useStore.getState());
	const failedSources: CollectionSyncSource[] = [];
	for (const source of enabledSources) {
		const id = getAnySourceId(game, source);
		if (!id) continue;
		const success = await enqueueStatusSync(`${source}:${id}`, () =>
			syncHandlers[source]({ sourceIds: { [source]: id } }, newStatus),
		);
		if (!success) failedSources.push(source);
	}
	return failedSources;
}
