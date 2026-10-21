import type { BatchOperationResult } from "../../types/types.ts";

export type BulkImportItemOutcome =
	| { kind: "duplicate" }
	| { kind: "preparation-error"; message: string }
	| { kind: "request-error"; message: string }
	| { kind: "insertion-error"; message: string }
	| { kind: "imported" };

export interface BulkImportPayloadPosition {
	itemIndex: number;
	payloadIndex: number;
}

export interface BulkImportPreparationFailure {
	itemIndex: number;
	message: string;
}

export interface BulkImportOutcomeInput {
	itemCount: number;
	preparationErrors: readonly BulkImportPreparationFailure[];
	duplicateItemIndices: readonly number[];
	pendingPayloads: readonly BulkImportPayloadPosition[];
	batchResult?: BatchOperationResult;
	mutationError?: string;
}

/**
 * Resolve internal item indices and the Tauri payload indices into one result
 * slot per submitted item. Only pending payloads may become inserted or failed.
 */
export function reconcileBulkImportOutcomes({
	itemCount,
	preparationErrors,
	duplicateItemIndices,
	pendingPayloads,
	batchResult,
	mutationError,
}: BulkImportOutcomeInput): Array<BulkImportItemOutcome | undefined> {
	const outcomes: Array<BulkImportItemOutcome | undefined> = Array.from(
		{ length: itemCount },
		() => undefined,
	);
	const isItemIndex = (index: number) =>
		Number.isInteger(index) && index >= 0 && index < itemCount;
	const assignIfUnresolved = (
		itemIndex: number,
		outcome: BulkImportItemOutcome,
	) => {
		if (isItemIndex(itemIndex) && outcomes[itemIndex] === undefined) {
			outcomes[itemIndex] = outcome;
		}
	};

	for (const error of preparationErrors) {
		assignIfUnresolved(error.itemIndex, {
			kind: "preparation-error",
			message: error.message,
		});
	}

	for (const itemIndex of duplicateItemIndices) {
		assignIfUnresolved(itemIndex, { kind: "duplicate" });
	}

	const duplicatePayloadIndices = new Set(batchResult?.duplicate_indices ?? []);
	const insertionErrors = new Map(
		batchResult?.errors.map(({ index, message }) => [index, message]) ?? [],
	);

	for (const { itemIndex, payloadIndex } of pendingPayloads) {
		if (!isItemIndex(itemIndex) || outcomes[itemIndex] !== undefined) continue;

		if (duplicatePayloadIndices.has(payloadIndex)) {
			assignIfUnresolved(itemIndex, { kind: "duplicate" });
		} else if (mutationError !== undefined) {
			assignIfUnresolved(itemIndex, {
				kind: "request-error",
				message: mutationError,
			});
		} else if (insertionErrors.has(payloadIndex)) {
			assignIfUnresolved(itemIndex, {
				kind: "insertion-error",
				message: insertionErrors.get(payloadIndex) ?? "",
			});
		} else if (batchResult) {
			assignIfUnresolved(itemIndex, { kind: "imported" });
		}
	}

	return outcomes;
}
