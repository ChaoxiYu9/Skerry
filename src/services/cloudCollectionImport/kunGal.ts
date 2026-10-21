import { collectCursorPages } from "@/metadata/api/collectionPagination";
import http from "@/metadata/api/http";
import {
	fetchGalgameById,
	fetchKunUserWorkRecordsPage,
} from "@/metadata/api/kun";
import { getMetadataRequestContext } from "@/services/requestContext";
import { mapKungalStatusToPlayStatus } from "@/services/cloudPlayStatus/shared";
import { withKungalAuth } from "@/services/oauth/kungalAuthSession";
import { PlayStatus } from "@/types/collection";
import { isAbortError } from "@/utils/async";
import { AppError } from "@/utils/errors";
import { mapFolderTitleToPlayStatus } from "./kunGalFolderStatus";
import { mergeKungalCollectionRecords } from "./kunGalRecords";
import { createItemKey, normalizeRating, normalizeReview } from "./shared";
import type { CloudCollectionItem } from "./types";

function pickKunWorkChineseTitle(
	localized?: Record<string, { value?: string } | string>,
): string | undefined {
	if (!localized) return undefined;
	for (const key of ["zh-Hans", "zh-cn", "zh-Hant", "zh-tw"]) {
		const item = localized[key];
		if (!item) continue;
		const val = typeof item === "string" ? item : item.value;
		const text = val?.trim();
		if (text) return text;
	}
	return undefined;
}

function extractUserIdFromJwt(token?: string): string | undefined {
	if (!token) return undefined;
	try {
		const parts = token.split(".");
		if (parts.length < 2) return undefined;
		const base64Url = parts[1];
		const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
		const jsonPayload = decodeURIComponent(
			atob(base64)
				.split("")
				.map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`)
				.join(""),
		);
		const payload = JSON.parse(jsonPayload);
		return payload.id != null
			? String(payload.id)
			: payload.sub
				? String(payload.sub)
				: undefined;
	} catch {
		return undefined;
	}
}

interface KunFolderItem {
	id: string;
	title?: string;
	item_count?: number;
}

interface KunFolderListResponse {
	items?: KunFolderItem[];
}

interface KunFolderWorkItem {
	id: string;
	display_name: string;
	localized?: Record<string, { value?: string } | string>;
	cover?: { url?: string } | null;
	banner?: { url?: string } | null;
	release_date?: string | null;
	maker?: { display_name?: string } | null;
}

interface KunFolderWorksResponse {
	items?: KunFolderWorkItem[];
}

export async function loadKungalCollection(
	signal?: AbortSignal,
): Promise<CloudCollectionItem[]> {
	return withKungalAuth(async (token, auth) => {
		if (!token) {
			throw new AppError({
				code: "kungal_auth_missing",
				message: "请先在设置中登录 KunGal 账号",
			});
		}

		const resolvedUid =
			auth?.uid != null ? String(auth.uid) : extractUserIdFromJwt(token);
		const itemsMap = new Map<string, CloudCollectionItem>();

		// 1. 优先拉取用户的游戏收藏夹（Folders / Collections）
		if (resolvedUid) {
			try {
				signal?.throwIfAborted();
				const foldersResp = await http.get<KunFolderListResponse>(
					`https://www.kungal.com/api/v1/users/${resolvedUid}/collections`,
					{
						params: { include_nsfw: true, limit: 50 },
						signal,
					},
				);

				const folders = foldersResp.data?.items ?? [];
				for (const folder of folders) {
					signal?.throwIfAborted();
					const folderStatus = mapFolderTitleToPlayStatus(folder.title);
					try {
						const worksResp = await http.get<KunFolderWorksResponse>(
							`https://www.kungal.com/api/v1/collections/${folder.id}/works`,
							{
								params: { limit: 100 },
								signal,
							},
						);

						for (const work of worksResp.data?.items ?? []) {
							const externalId = String(work.id);
							if (!externalId) continue;
							const nameCn = pickKunWorkChineseTitle(work.localized);
							const displayName =
								work.display_name?.trim() || `KunGal #${externalId}`;

							const existing = itemsMap.get(externalId);
							if (!existing) {
								itemsMap.set(externalId, {
									key: createItemKey("kun", externalId),
									source: "kun",
									externalId,
									name: displayName,
									nameCn,
									originalName: work.display_name?.trim() || undefined,
									image: work.cover?.url || work.banner?.url || undefined,
									playStatus: folderStatus,
									releaseDate: work.release_date ?? undefined,
									developer: work.maker?.display_name?.trim() || undefined,
									folderId: String(folder.id),
									folderName: folder.title?.trim() || "默认收藏夹",
								});
								continue;
							}
							// 若已存在，按更高优先级更新状态
							if (
								existing.playStatus === PlayStatus.WISH &&
								folderStatus !== PlayStatus.WISH
							) {
								existing.playStatus = folderStatus;
							}
						}
					} catch (folderError) {
						if (isAbortError(folderError)) throw folderError;
						console.warn(
							`[KunGal Import] 加载收藏夹 ${folder.id} (${folder.title}) 失败:`,
							folderError,
						);
					}
				}
			} catch (foldersListError) {
				if (isAbortError(foldersListError)) throw foldersListError;
				console.warn(
					"[KunGal Import] 加载用户收藏夹列表失败:",
					foldersListError,
				);
			}
		}

		// 2. NextMoe 个人记录只补充上面已取得的收藏作品。
		let collectionItems = [...itemsMap.values()];
		try {
			signal?.throwIfAborted();
			const nextMoeRecords = await collectCursorPages(
				(cursor) =>
					fetchKunUserWorkRecordsPage(
						token,
						{ cursor, limit: 100 },
						{ signal },
					),
				signal,
			);

			collectionItems = mergeKungalCollectionRecords(
				collectionItems,
				nextMoeRecords,
				(record) => {
					const state = record.work_state?.state;
					return {
						hasPlayStatus: Boolean(state),
						playStatus: state ? mapKungalStatusToPlayStatus(state) : undefined,
						userRating: normalizeRating(record.rating?.overall),
						userReview: normalizeReview(record.rating?.short_summary),
					};
				},
			);
		} catch (nextMoeError) {
			if (isAbortError(nextMoeError)) throw nextMoeError;
			console.warn(
				"[KunGal Import] 读取 NextMoe 个人记录失败（已保留收藏夹数据）:",
				nextMoeError,
			);
		}

		return collectionItems;
	});
}

export function fetchKungalCollectionItemMetadata(
	item: CloudCollectionItem,
	signal?: AbortSignal,
) {
	return fetchGalgameById(
		item.externalId,
		getMetadataRequestContext({ signal, spoilerLevel: 0 }),
	);
}
