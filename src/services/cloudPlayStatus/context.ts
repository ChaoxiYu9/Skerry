import {
	type BgmUserCollection,
	fetchUserCollection,
	fetchUserGameCollectionsPage,
} from "@/metadata/api/bgm";
import {
	fetchHikarinagiGameRate,
	fetchHikarinagiRatesPage,
} from "@/metadata/api/hikarinagi";
import { fetchKunUserWorkRecordsPage } from "@/metadata/api/kun";
import {
	fetchVndbCurrentUserProfile,
	fetchVndbUserCollection,
	fetchVndbUserCollectionsPage,
	type VndbUserCollectionItem,
} from "@/metadata/api/vndb";
import { withBgmAuth } from "@/services/oauth/bgmAuthSession";
import { withHikarinagiAuth } from "@/services/oauth/hikarinagiAuthSession";
import { withKungalAuth } from "@/services/oauth/kungalAuthSession";
import { getNetworkRequestContext } from "@/services/requestContext";
import { useStore } from "@/store/appStore";
import type { PlayStatus } from "@/types/collection";
import { collectCursorPages } from "@/metadata/api/collectionPagination";
import {
	type CloudPlayStatusContext,
	getBgmUsername,
	getVndbToken,
	mapBgmTypeToPlayStatus,
	mapHikarinagiStatusToPlayStatus,
	mapKungalStatusToPlayStatus,
	mapVndbCollectionToPlayStatus,
} from "./shared";
import {
	loadRequestedStatusMap,
	shouldUseTargetedStatusLookup,
	uniqueStatusLookupIds,
} from "./targetedStatusLookup";

export interface CloudPlayStatusContextInput {
	bgmIds?: Iterable<string>;
	vndbIds?: Iterable<string>;
	hikarinagiIds?: Iterable<string>;
	kunIds?: Iterable<string>;
}

const DIRECT_COLLECTION_LOOKUP_THRESHOLD = 1;
const BGM_COLLECTION_PAGE_SIZE = 50;
const VNDB_COLLECTION_PAGE_SIZE = 100;
const HIKARINAGI_COLLECTION_PAGE_SIZE = 100;

interface BgmCollectionPage {
	offset: number;
	limit: number;
	total: number;
	data: BgmUserCollection[];
}

interface VndbCollectionPage {
	results: VndbUserCollectionItem[];
	more: boolean;
	count?: number;
}

async function fetchBgmCollectionPage(
	username: string,
	token: string,
	params: { limit: number; offset: number },
): Promise<BgmCollectionPage> {
	const page = await fetchUserGameCollectionsPage(
		username,
		token,
		params,
		getNetworkRequestContext(),
	);
	return {
		offset: page.offset ?? params.offset,
		limit: page.limit ?? params.limit,
		total: page.total ?? 0,
		data: Array.isArray(page.data) ? page.data : [],
	};
}

async function fetchVndbCollectionPage(
	token: string,
	params: { userId: string; page: number; count?: boolean },
): Promise<VndbCollectionPage> {
	const page = await fetchVndbUserCollectionsPage(
		token,
		params,
		getNetworkRequestContext(),
	);
	return {
		results: Array.isArray(page.results) ? page.results : [],
		more: Boolean(page.more),
		count: page.count,
	};
}

function appendBgmCollectionsToStatusMap(
	statusMap: Map<string, PlayStatus>,
	collections: BgmUserCollection[],
) {
	for (const collection of collections) {
		const status = mapBgmTypeToPlayStatus(collection.type);
		if (status !== undefined) {
			statusMap.set(String(collection.subject_id), status);
		}
	}
}

function appendVndbCollectionsToStatusMap(
	statusMap: Map<string, PlayStatus>,
	collections: VndbUserCollectionItem[],
) {
	for (const collection of collections) {
		const status = mapVndbCollectionToPlayStatus(collection);
		if (status !== undefined) {
			statusMap.set(collection.id, status);
		}
	}
}

async function fetchBgmPlayStatusById(
	username: string,
	token: string,
	id: string,
) {
	const collection = await fetchUserCollection(
		username,
		id,
		token,
		getNetworkRequestContext(),
	);
	return mapBgmTypeToPlayStatus(collection?.type);
}

async function createBgmFullPlayStatusMap(
	username: string,
	token: string,
	firstPage?: BgmCollectionPage,
) {
	const statusMap = new Map<string, PlayStatus>();
	let page =
		firstPage ??
		(await fetchBgmCollectionPage(username, token, {
			limit: BGM_COLLECTION_PAGE_SIZE,
			offset: 0,
		}));
	appendBgmCollectionsToStatusMap(statusMap, page.data);

	while (true) {
		const nextOffset = page.offset + page.limit;
		if (page.data.length === 0 || nextOffset >= page.total) {
			break;
		}
		page = await fetchBgmCollectionPage(username, token, {
			limit: BGM_COLLECTION_PAGE_SIZE,
			offset: nextOffset,
		});
		appendBgmCollectionsToStatusMap(statusMap, page.data);
	}

	return statusMap;
}

async function createBgmPlayStatusMap(ids: Iterable<string>) {
	try {
		const uniqueIds = uniqueStatusLookupIds(ids);
		if (uniqueIds.length === 0) {
			return new Map<string, PlayStatus>();
		}

		return await withBgmAuth(async (token) => {
			if (!token) return undefined;

			const username = await getBgmUsername(token);
			const fetchStatus = (id: string) =>
				fetchBgmPlayStatusById(username, token, id);
			if (uniqueIds.length <= DIRECT_COLLECTION_LOOKUP_THRESHOLD) {
				return loadRequestedStatusMap(uniqueIds, new Map(), fetchStatus);
			}

			const firstPage = await fetchBgmCollectionPage(username, token, {
				limit: BGM_COLLECTION_PAGE_SIZE,
				offset: 0,
			});
			const totalPageRequests = Math.ceil(
				firstPage.total / BGM_COLLECTION_PAGE_SIZE,
			);
			const firstPageStatuses = new Map<string, PlayStatus>();
			appendBgmCollectionsToStatusMap(firstPageStatuses, firstPage.data);

			if (
				shouldUseTargetedStatusLookup(
					uniqueIds,
					firstPageStatuses,
					totalPageRequests,
				)
			) {
				return loadRequestedStatusMap(
					uniqueIds,
					firstPageStatuses,
					fetchStatus,
				);
			}

			return createBgmFullPlayStatusMap(username, token, firstPage);
		});
	} catch (error) {
		console.error("获取 BGM 收藏列表失败:", error);
		return undefined;
	}
}

async function fetchVndbPlayStatusById(
	token: string,
	userId: string,
	id: string,
) {
	const collection = await fetchVndbUserCollection(
		id,
		token,
		userId,
		getNetworkRequestContext(),
	);
	return mapVndbCollectionToPlayStatus(collection);
}

async function createVndbFullPlayStatusMap(
	token: string,
	userId: string,
	firstPage?: VndbCollectionPage,
) {
	const statusMap = new Map<string, PlayStatus>();
	let page =
		firstPage ??
		(await fetchVndbCollectionPage(token, {
			userId,
			page: 1,
		}));
	appendVndbCollectionsToStatusMap(statusMap, page.results);

	let pageNumber = 2;
	while (page.more && page.results.length > 0) {
		page = await fetchVndbCollectionPage(token, {
			userId,
			page: pageNumber,
		});
		appendVndbCollectionsToStatusMap(statusMap, page.results);
		pageNumber += 1;
	}

	return statusMap;
}

async function createVndbPlayStatusMap(ids: Iterable<string>) {
	try {
		const uniqueIds = uniqueStatusLookupIds(ids);
		if (uniqueIds.length === 0) {
			return new Map<string, PlayStatus>();
		}

		const token = await getVndbToken();
		if (!token) return undefined;

		const profile = await fetchVndbCurrentUserProfile(
			token,
			getNetworkRequestContext(),
		);
		const userId = profile?.id;
		if (!userId || !profile.permissions.includes("listread")) {
			return undefined;
		}

		const fetchStatus = (id: string) =>
			fetchVndbPlayStatusById(token, userId, id);
		if (uniqueIds.length <= DIRECT_COLLECTION_LOOKUP_THRESHOLD) {
			return loadRequestedStatusMap(uniqueIds, new Map(), fetchStatus);
		}

		const firstPage = await fetchVndbCollectionPage(token, {
			userId,
			page: 1,
			count: true,
		});
		const total = firstPage.count ?? 0;
		const totalPageRequests = Math.ceil(total / VNDB_COLLECTION_PAGE_SIZE);
		const firstPageStatuses = new Map<string, PlayStatus>();
		appendVndbCollectionsToStatusMap(firstPageStatuses, firstPage.results);

		if (
			shouldUseTargetedStatusLookup(
				uniqueIds,
				firstPageStatuses,
				totalPageRequests,
			)
		) {
			return loadRequestedStatusMap(uniqueIds, firstPageStatuses, fetchStatus);
		}

		return createVndbFullPlayStatusMap(token, userId, firstPage);
	} catch (error) {
		console.error("获取 VNDB 收藏列表失败:", error);
		return undefined;
	}
}

function appendHikarinagiRatesToStatusMap(
	statusMap: Map<string, PlayStatus>,
	rates: Awaited<ReturnType<typeof fetchHikarinagiRatesPage>>["items"],
) {
	for (const rate of rates) {
		const status = mapHikarinagiStatusToPlayStatus(rate.status);
		if (status !== undefined) {
			statusMap.set(String(rate.id), status);
		}
	}
}

async function fetchHikarinagiPlayStatusById(token: string, id: string) {
	const rate = await fetchHikarinagiGameRate(
		id,
		token,
		getNetworkRequestContext(),
	);
	return mapHikarinagiStatusToPlayStatus(rate?.status);
}

async function createHikarinagiFullPlayStatusMap(
	token: string,
	firstPage?: Awaited<ReturnType<typeof fetchHikarinagiRatesPage>>,
) {
	const statusMap = new Map<string, PlayStatus>();
	let page =
		firstPage ??
		(await fetchHikarinagiRatesPage(
			token,
			{ page: 1, pageSize: HIKARINAGI_COLLECTION_PAGE_SIZE },
			getNetworkRequestContext(),
		));
	appendHikarinagiRatesToStatusMap(statusMap, page.items);

	while (page.meta.page < page.meta.total_pages && page.items.length > 0) {
		page = await fetchHikarinagiRatesPage(
			token,
			{ page: page.meta.page + 1, pageSize: HIKARINAGI_COLLECTION_PAGE_SIZE },
			getNetworkRequestContext(),
		);
		appendHikarinagiRatesToStatusMap(statusMap, page.items);
	}

	return statusMap;
}

async function createHikarinagiPlayStatusMap(ids: Iterable<string>) {
	try {
		const uniqueIds = uniqueStatusLookupIds(ids);
		if (uniqueIds.length === 0) {
			return new Map<string, PlayStatus>();
		}

		return await withHikarinagiAuth(async (token) => {
			if (!token) return undefined;
			const fetchStatus = (id: string) =>
				fetchHikarinagiPlayStatusById(token, id);
			if (uniqueIds.length <= DIRECT_COLLECTION_LOOKUP_THRESHOLD) {
				return loadRequestedStatusMap(uniqueIds, new Map(), fetchStatus);
			}

			const firstPage = await fetchHikarinagiRatesPage(
				token,
				{ page: 1, pageSize: HIKARINAGI_COLLECTION_PAGE_SIZE },
				getNetworkRequestContext(),
			);
			const totalPageRequests = Math.ceil(
				firstPage.meta.total_items / HIKARINAGI_COLLECTION_PAGE_SIZE,
			);
			const firstPageStatuses = new Map<string, PlayStatus>();
			appendHikarinagiRatesToStatusMap(firstPageStatuses, firstPage.items);
			if (
				shouldUseTargetedStatusLookup(
					uniqueIds,
					firstPageStatuses,
					totalPageRequests,
				)
			) {
				return loadRequestedStatusMap(
					uniqueIds,
					firstPageStatuses,
					fetchStatus,
				);
			}

			return createHikarinagiFullPlayStatusMap(token, firstPage);
		});
	} catch (error) {
		console.error("获取 Hikarinagi 游玩状态失败:", error);
		return undefined;
	}
}

export async function createKunPlayStatusMap(ids: Iterable<string>) {
	const uniqueIds = [...new Set(ids)].filter(Boolean);
	if (uniqueIds.length === 0) return new Map<string, PlayStatus>();
	const requestedIds = new Set(uniqueIds);
	const foundIds = new Set<string>();

	try {
		return await withKungalAuth(async (token) => {
			if (!token) return undefined;

			const records = await collectCursorPages(
				(cursor) =>
					fetchKunUserWorkRecordsPage(token, {
						cursor,
						limit: 100,
					}),
				undefined,
				(pageItems) => {
					for (const record of pageItems) {
						const workId = String(record.work_id);
						if (requestedIds.has(workId)) foundIds.add(workId);
					}
					return foundIds.size === requestedIds.size;
				},
			);
			const statusMap = new Map<string, PlayStatus>();
			for (const record of records) {
				const workId = String(record.work_id);
				if (!requestedIds.has(workId)) continue;
				const status = mapKungalStatusToPlayStatus(record.work_state?.state);
				if (status !== undefined) statusMap.set(workId, status);
			}
			return statusMap;
		});
	} catch (error) {
		console.error("获取 KunGal 游玩状态失败:", error);
		return undefined;
	}
}

export async function createCloudPlayStatusContext(
	input: CloudPlayStatusContextInput = {},
): Promise<CloudPlayStatusContext> {
	const {
		syncBgmCollection,
		syncVndbCollection,
		syncHikarinagiCollection,
		syncKungalCollection,
	} = useStore.getState();
	const [bgm, vndb, hikarinagi, kun] = await Promise.all([
		syncBgmCollection
			? createBgmPlayStatusMap(input.bgmIds ?? [])
			: Promise.resolve(undefined),
		syncVndbCollection
			? createVndbPlayStatusMap(input.vndbIds ?? [])
			: Promise.resolve(undefined),
		syncHikarinagiCollection
			? createHikarinagiPlayStatusMap(input.hikarinagiIds ?? [])
			: Promise.resolve(undefined),
		syncKungalCollection
			? createKunPlayStatusMap(input.kunIds ?? [])
			: Promise.resolve(undefined),
	]);

	return {
		...(bgm ? { bgm } : {}),
		...(vndb ? { vndb } : {}),
		...(hikarinagi ? { hikarinagi } : {}),
		...(kun ? { kun } : {}),
	};
}
