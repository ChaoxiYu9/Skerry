import { collectNumberedPages } from "@/metadata/api/collectionPagination";
import {
	fetchHikarinagiById,
	fetchHikarinagiRatesPage,
} from "@/metadata/api/hikarinagi";
import { mapHikarinagiStatusToPlayStatus } from "@/services/cloudPlayStatus/shared";
import {
	hasHikarinagiScope,
	withHikarinagiAuth,
} from "@/services/oauth/hikarinagiAuthSession";
import { getNetworkRequestContext } from "@/services/requestContext";
import type { GameMetadataDraft } from "@/types";
import { AppError } from "@/utils/errors";
import { createItemKey, normalizeRating, normalizeReview } from "./shared";
import type { CloudCollectionItem } from "./types";

export async function loadHikarinagiCollection(signal?: AbortSignal) {
	return withHikarinagiAuth(async (token, auth) => {
		if (!token) {
			throw new AppError({
				code: "hikarinagi_auth_missing",
				message: "请先登录 Hikarinagi 账号",
			});
		}
		if (!hasHikarinagiScope(auth, "catalog:full")) {
			throw new AppError({
				code: "hikarinagi_catalog_full_missing",
				message: "Hikarinagi 授权缺少 catalog:full，请重新授权",
			});
		}

		const rates = await collectNumberedPages(async (pageNumber) => {
			const page = await fetchHikarinagiRatesPage(
				token,
				{ page: pageNumber, pageSize: 100 },
				getNetworkRequestContext(signal),
			);
			return {
				items: page.items,
				page: page.meta.page,
				totalPages: page.meta.total_pages,
			};
		}, signal);

		return rates.map((rate): CloudCollectionItem => {
			const externalId = String(rate.id);
			return {
				key: createItemKey("hikarinagi", externalId),
				source: "hikarinagi",
				externalId,
				name: rate.title?.trim() || `Hikarinagi #${externalId}`,
				image: rate.cover?.src,
				playStatus: mapHikarinagiStatusToPlayStatus(rate.status),
				userRating: normalizeRating(rate.rate),
				userReview: normalizeReview(rate.rate_content),
			};
		});
	});
}

export function prepareHikarinagiCollectionMetadata(
	signal: AbortSignal | undefined,
	prepare: (
		fetchDetails: (item: CloudCollectionItem) => Promise<GameMetadataDraft>,
	) => Promise<void>,
) {
	return withHikarinagiAuth(async (token, auth) => {
		if (!token) {
			throw new AppError({
				code: "hikarinagi_auth_missing",
				message: "请先登录 Hikarinagi 账号",
			});
		}
		if (!hasHikarinagiScope(auth, "catalog:full")) {
			throw new AppError({
				code: "hikarinagi_catalog_full_missing",
				message: "Hikarinagi 授权缺少 catalog:full，请重新授权",
			});
		}
		await prepare((item) =>
			fetchHikarinagiById(
				item.externalId,
				token,
				getNetworkRequestContext(signal),
			),
		);
	});
}
