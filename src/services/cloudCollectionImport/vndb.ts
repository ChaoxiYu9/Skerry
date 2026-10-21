import {
	fetchVndbCurrentUserProfile,
	fetchVndbUserImportCollections,
} from "@/metadata/api/vndb";
import { getCandidateSourceData } from "@/metadata/sourceCandidate";
import {
	getVndbToken,
	mapVndbCollectionToPlayStatus,
} from "@/services/cloudPlayStatus/shared";
import { getMetadataRequestContext } from "@/services/requestContext";
import type { VndbData } from "@/types";
import { AppError } from "@/utils/errors";
import { createItemKey, normalizeReview } from "./shared";
import type { CloudCollectionItem } from "./types";

export async function loadVndbCollection(signal?: AbortSignal) {
	const token = await getVndbToken();
	if (!token) {
		throw new AppError({
			code: "vndb_token_missing",
			message: "请先配置 VNDB Token",
		});
	}
	const context = getMetadataRequestContext({ signal });
	const profile = await fetchVndbCurrentUserProfile(token, context);
	if (!profile?.permissions.includes("listread")) {
		throw new AppError({
			code: "vndb_listread_missing",
			message: "VNDB Token 缺少 listread 权限",
		});
	}
	const collections = await fetchVndbUserImportCollections(
		token,
		profile.id,
		context,
	);
	return collections.map((collection): CloudCollectionItem => {
		const data = getCandidateSourceData<VndbData>(collection.metadata, "vndb");
		return {
			developer: data?.developer,
			key: createItemKey("vndb", collection.id),
			source: "vndb",
			externalId: collection.id,
			name: data?.name || `VNDB ${collection.id}`,
			nameCn: data?.name_cn,
			originalName: data?.name,
			image: data?.image,
			playStatus: mapVndbCollectionToPlayStatus(collection),
			releaseDate: data?.date,
			userRating: collection.vote == null ? undefined : collection.vote / 10,
			userReview: normalizeReview(collection.notes),
			metadata: collection.metadata,
		};
	});
}
