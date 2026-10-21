import type { CloudCollectionSource } from "@/types";
import type { CloudCollectionItem } from "./types";

export function createItemKey(
	source: CloudCollectionSource,
	externalId: string,
) {
	return `${source}:${externalId}`;
}

function mergeDuplicateCandidate(
	first: CloudCollectionItem,
	duplicate: CloudCollectionItem,
): CloudCollectionItem {
	return {
		...duplicate,
		...first,
		key: createItemKey(first.source, first.externalId),
		name: first.name.trim() ? first.name : duplicate.name,
		developer: first.developer ?? duplicate.developer,
		folderId: first.folderId ?? duplicate.folderId,
		folderName: first.folderName ?? duplicate.folderName,
		image: first.image ?? duplicate.image,
		metadata: first.metadata ?? duplicate.metadata,
		nameCn: first.nameCn ?? duplicate.nameCn,
		originalName: first.originalName ?? duplicate.originalName,
		playStatus: first.playStatus ?? duplicate.playStatus,
		releaseDate: first.releaseDate ?? duplicate.releaseDate,
		userRating: first.userRating ?? duplicate.userRating,
		userReview: first.userReview ?? duplicate.userReview,
	};
}

/** Keep each provider item once, in first-seen order, under its source identity. */
export function normalizeCloudCollectionCandidates(
	items: readonly CloudCollectionItem[],
): CloudCollectionItem[] {
	const candidates: CloudCollectionItem[] = [];
	const candidateIndexByIdentity = new Map<string, number>();

	for (const item of items) {
		const identity = JSON.stringify([item.source, item.externalId]);
		const existingIndex = candidateIndexByIdentity.get(identity);
		if (existingIndex === undefined) {
			candidateIndexByIdentity.set(identity, candidates.length);
			candidates.push({
				...item,
				key: createItemKey(item.source, item.externalId),
			});
			continue;
		}

		candidates[existingIndex] = mergeDuplicateCandidate(
			candidates[existingIndex],
			item,
		);
	}

	return candidates;
}
