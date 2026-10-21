import { fetchBgmById, fetchUserGameCollections } from "@/metadata/api/bgm";
import {
	getBgmUsername,
	mapBgmTypeToPlayStatus,
} from "@/services/cloudPlayStatus/shared";
import { withBgmAuth } from "@/services/oauth/bgmAuthSession";
import { getNetworkRequestContext } from "@/services/requestContext";
import type { GameMetadataDraft } from "@/types";
import { AppError } from "@/utils/errors";
import { createItemKey, normalizeRating, normalizeReview } from "./shared";
import type { CloudCollectionItem } from "./types";

export async function loadBgmCollection(signal?: AbortSignal) {
	return withBgmAuth(async (token) => {
		if (!token) {
			throw new AppError({
				code: "bgm_auth_missing",
				message: "请先登录 Bangumi 账号",
			});
		}
		const username = await getBgmUsername(token);
		const collections = await fetchUserGameCollections(
			username,
			token,
			getNetworkRequestContext(signal),
		);
		return collections.map((collection): CloudCollectionItem => {
			const externalId = String(collection.subject_id);
			return {
				key: createItemKey("bgm", externalId),
				source: "bgm",
				externalId,
				name: collection.subject?.name || `Bangumi #${externalId}`,
				nameCn: collection.subject?.name_cn || undefined,
				originalName: collection.subject?.name || undefined,
				image:
					collection.subject?.images?.large ??
					collection.subject?.images?.common,
				playStatus: mapBgmTypeToPlayStatus(collection.type),
				releaseDate: collection.subject?.date,
				userRating: normalizeRating(collection.rate),
				userReview: normalizeReview(collection.comment),
			};
		});
	});
}

export function prepareBgmCollectionMetadata(
	signal: AbortSignal | undefined,
	prepare: (
		fetchDetails: (item: CloudCollectionItem) => Promise<GameMetadataDraft>,
	) => Promise<void>,
) {
	return withBgmAuth(async (token) => {
		if (!token) {
			throw new AppError({
				code: "bgm_auth_missing",
				message: "请先登录 Bangumi 账号",
			});
		}
		await prepare((item) =>
			fetchBgmById(item.externalId, token, getNetworkRequestContext(signal)),
		);
	});
}
