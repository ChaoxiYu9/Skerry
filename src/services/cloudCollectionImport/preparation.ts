import type { GameMetadataDraft } from "@/types";
import { isApiRateLimitError } from "../../utils/errors.ts";
import type { CloudCollectionItem, PreparedCloudCollectionItem } from "./types";

interface PrepareCloudCollectionSelectionOptions {
	signal: AbortSignal;
	fetchDetails: (item: CloudCollectionItem) => Promise<GameMetadataDraft>;
	mergePersonalData: (
		metadata: GameMetadataDraft,
		item: CloudCollectionItem,
	) => GameMetadataDraft;
	onItemPrepared: (result: PreparedCloudCollectionItem) => void;
	onProgress: (completed: number, total: number) => void;
}

/** Prepare selected candidates in display order and retain failures per item. */
export async function prepareCloudCollectionSelection(
	items: readonly CloudCollectionItem[],
	options: PrepareCloudCollectionSelectionOptions,
): Promise<PreparedCloudCollectionItem[]> {
	if (items.length === 0) return [];

	const prepared: PreparedCloudCollectionItem[] = [];
	for (let index = 0; index < items.length; index++) {
		options.signal.throwIfAborted();
		const item = items[index];
		let result: PreparedCloudCollectionItem;
		try {
			const metadata = item.metadata ?? (await options.fetchDetails(item));
			options.signal.throwIfAborted();
			result = {
				item,
				metadata: options.mergePersonalData(metadata, item),
			};
		} catch (error) {
			if (options.signal.aborted || isAbortError(error)) throw error;
			result = { item, error };
		}

		prepared.push(result);
		options.onItemPrepared(result);
		// The request layer already applied this source's retry policy; stop before another request.
		if (isApiRateLimitError(result.error)) throw result.error;
		options.onProgress(index + 1, items.length);
	}

	return prepared;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}
