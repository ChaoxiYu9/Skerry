import type { CloudCollectionSource, GameMetadataDraft } from "@/types";
import { AppError } from "@/utils/errors";
import {
	loadBgmCollection,
	prepareBgmCollectionMetadata,
} from "./cloudCollectionImport/bgm";
import { normalizeCloudCollectionCandidates } from "./cloudCollectionImport/candidates";
import {
	loadHikarinagiCollection,
	prepareHikarinagiCollectionMetadata,
} from "./cloudCollectionImport/hikarinagi";
import {
	fetchKungalCollectionItemMetadata,
	loadKungalCollection,
} from "./cloudCollectionImport/kunGal";
import { prepareCloudCollectionSelection } from "./cloudCollectionImport/preparation";
import { withPersonalData } from "./cloudCollectionImport/shared";
import type {
	CloudCollectionItem,
	PreparedCloudCollectionItem,
} from "./cloudCollectionImport/types";
import { loadVndbCollection } from "./cloudCollectionImport/vndb";

export type {
	CloudCollectionItem,
	PreparedCloudCollectionItem,
} from "./cloudCollectionImport/types";

const collectionLoaders: Record<
	CloudCollectionSource,
	(signal?: AbortSignal) => Promise<CloudCollectionItem[]>
> = {
	bgm: loadBgmCollection,
	vndb: loadVndbCollection,
	hikarinagi: loadHikarinagiCollection,
	kun: loadKungalCollection,
};

export async function loadCloudCollection(
	source: CloudCollectionSource,
	signal?: AbortSignal,
): Promise<CloudCollectionItem[]> {
	const items = await collectionLoaders[source](signal);
	return normalizeCloudCollectionCandidates(items);
}

export async function prepareCloudCollectionItems(
	items: CloudCollectionItem[],
	signal: AbortSignal,
	onItemPrepared: (result: PreparedCloudCollectionItem) => void,
	onProgress: (completed: number, total: number) => void,
): Promise<PreparedCloudCollectionItem[]> {
	if (items.length === 0) return [];
	const source = items[0].source;
	let prepared: PreparedCloudCollectionItem[] = [];
	const prepare = async (
		fetchDetails: (item: CloudCollectionItem) => Promise<GameMetadataDraft>,
	) => {
		prepared = await prepareCloudCollectionSelection(items, {
			signal,
			fetchDetails,
			mergePersonalData: withPersonalData,
			onItemPrepared,
			onProgress,
		});
	};

	if (items.every((item) => item.metadata)) {
		await prepare(async (item) => {
			const metadata = item.metadata;
			if (!metadata) {
				throw new AppError({
					code: "metadata_not_found",
					message: `云端收藏项缓存元数据缺失: ${item.externalId}`,
				});
			}
			return metadata;
		});
		return prepared;
	}

	const prepareBySource: Record<
		CloudCollectionSource,
		(
			prepareItems: (
				fetchDetails: (item: CloudCollectionItem) => Promise<GameMetadataDraft>,
			) => Promise<void>,
		) => Promise<void>
	> = {
		bgm: (prepareItems) => prepareBgmCollectionMetadata(signal, prepareItems),
		vndb: (prepareItems) =>
			prepareItems(async (item) => {
				if (!item.metadata) {
					throw new AppError({
						code: "vndb_import_metadata_missing",
						message: `VNDB 元数据缺失: ${item.externalId}`,
					});
				}
				return item.metadata;
			}),
		hikarinagi: (prepareItems) =>
			prepareHikarinagiCollectionMetadata(signal, prepareItems),
		kun: (prepareItems) =>
			prepareItems((item) => fetchKungalCollectionItemMetadata(item, signal)),
	};

	await prepareBySource[source](prepare);
	return prepared;
}
