import type { GameMetadataDraft } from "@/types";
import type { CloudCollectionItem } from "./types";

export { createItemKey } from "./candidates";

export function normalizeRating(value?: number | null) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return undefined;
	}
	return Math.min(10, Math.max(1, Math.round(value * 10) / 10));
}

export function normalizeReview(value?: string | null) {
	const review = value?.trim();
	return review || undefined;
}

export function withPersonalData(
	metadata: GameMetadataDraft,
	item: CloudCollectionItem,
): GameMetadataDraft {
	const userRating = normalizeRating(item.userRating);
	const userReview = normalizeReview(item.userReview);
	if (userRating === undefined && userReview === undefined) return metadata;

	return {
		...metadata,
		custom_data: {
			...metadata.custom_data,
			...(userRating === undefined ? {} : { user_rating: userRating }),
			...(userReview === undefined ? {} : { user_review: userReview }),
		},
	};
}
