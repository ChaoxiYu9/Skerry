import type { CloudCollectionSource, GameMetadataDraft } from "@/types";
import type { PlayStatus } from "@/types/collection";

export interface CloudCollectionItem {
	developer?: string;
	externalId: string;
	folderId?: string;
	folderName?: string;
	image?: string;
	key: string;
	metadata?: GameMetadataDraft;
	name: string;
	nameCn?: string;
	originalName?: string;
	playStatus?: PlayStatus;
	releaseDate?: string;
	source: CloudCollectionSource;
	userRating?: number;
	userReview?: string;
}

export interface PreparedCloudCollectionItem {
	error?: unknown;
	item: CloudCollectionItem;
	metadata?: GameMetadataDraft;
}
