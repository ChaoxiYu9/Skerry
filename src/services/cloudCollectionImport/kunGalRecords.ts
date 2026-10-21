import type { PlayStatus } from "@/types/collection";
import type { CloudCollectionItem } from "./types";

export interface KungalWorkRecordReference {
	work_id: string;
}

export interface KungalCollectionPersonalData {
	hasPlayStatus: boolean;
	playStatus?: PlayStatus;
	userRating?: number;
	userReview?: string;
}

/** Merge personal record facts onto the fetched collection, preserving its membership and order. */
export function mergeKungalCollectionRecords<
	TRecord extends KungalWorkRecordReference,
>(
	candidates: readonly CloudCollectionItem[],
	records: readonly TRecord[],
	readPersonalData: (record: TRecord) => KungalCollectionPersonalData,
): CloudCollectionItem[] {
	const collectionIds = new Set(
		candidates.map((candidate) => candidate.externalId),
	);
	const personalDataByWorkId = new Map<string, KungalCollectionPersonalData>();

	for (const record of records) {
		if (!collectionIds.has(record.work_id)) continue;

		const incoming = readPersonalData(record);
		const previous = personalDataByWorkId.get(record.work_id);
		if (!previous) {
			personalDataByWorkId.set(record.work_id, incoming);
			continue;
		}

		personalDataByWorkId.set(record.work_id, {
			hasPlayStatus: previous.hasPlayStatus || incoming.hasPlayStatus,
			playStatus: incoming.hasPlayStatus
				? incoming.playStatus
				: previous.playStatus,
			userRating: incoming.userRating ?? previous.userRating,
			userReview: incoming.userReview ?? previous.userReview,
		});
	}

	return candidates.map((candidate) => {
		const personalData = personalDataByWorkId.get(candidate.externalId);
		if (!personalData) return candidate;

		return {
			...candidate,
			...(personalData.hasPlayStatus
				? { playStatus: personalData.playStatus }
				: {}),
			...(personalData.userRating === undefined
				? {}
				: { userRating: personalData.userRating }),
			...(personalData.userReview === undefined
				? {}
				: { userReview: personalData.userReview }),
		};
	});
}
