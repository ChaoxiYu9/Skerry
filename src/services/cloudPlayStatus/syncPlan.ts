export type CollectionSyncSource = "bgm" | "vndb" | "hikarinagi" | "kun";

export interface CollectionSyncSettings {
	syncBgmCollection: boolean;
	syncVndbCollection: boolean;
	syncHikarinagiCollection: boolean;
	syncKungalCollection: boolean;
}

export const COLLECTION_SYNC_SOURCE_SETTINGS = [
	["bgm", "syncBgmCollection"],
	["vndb", "syncVndbCollection"],
	["hikarinagi", "syncHikarinagiCollection"],
	["kun", "syncKungalCollection"],
] as const satisfies ReadonlyArray<
	readonly [CollectionSyncSource, keyof CollectionSyncSettings]
>;

export function resolveCollectionSyncSources(settings: CollectionSyncSettings) {
	return COLLECTION_SYNC_SOURCE_SETTINGS.filter(
		([, setting]) => settings[setting],
	).map(([source]) => source);
}

export function resolveCloudStatusByPriority<TStatus>(
	sourceIds: Readonly<
		Partial<Record<CollectionSyncSource, string | undefined>>
	>,
	statusMaps: Readonly<
		Partial<Record<CollectionSyncSource, ReadonlyMap<string, TStatus>>>
	>,
): TStatus | undefined {
	for (const [source] of COLLECTION_SYNC_SOURCE_SETTINGS) {
		const sourceId = sourceIds[source];
		const statusMap = statusMaps[source];
		if (sourceId && statusMap?.has(sourceId)) {
			return statusMap.get(sourceId);
		}
	}

	return undefined;
}
