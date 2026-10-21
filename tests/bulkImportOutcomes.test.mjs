import assert from "node:assert/strict";
import test from "node:test";
import { reconcileBulkImportOutcomes } from "../src/metadata/data/bulkImportOutcomes.ts";

test("bulk import results reconcile original item and database payload positions once", () => {
	const outcomes = reconcileBulkImportOutcomes({
		itemCount: 8,
		preparationErrors: [{ itemIndex: 1, message: "invalid metadata" }],
		duplicateItemIndices: [3],
		pendingPayloads: [
			{ itemIndex: 0, payloadIndex: 0 },
			{ itemIndex: 2, payloadIndex: 1 },
			{ itemIndex: 4, payloadIndex: 2 },
			{ itemIndex: 5, payloadIndex: 3 },
			{ itemIndex: 6, payloadIndex: 4 },
		],
		batchResult: {
			total: 5,
			success: 2,
			failed: 1,
			duplicate_indices: [1, 2, 99],
			errors: [
				{ index: 2, message: "duplicate also reported as an error" },
				{ index: 3, message: "write failed" },
			],
		},
	});

	assert.deepEqual(outcomes, [
		{ kind: "imported" },
		{ kind: "preparation-error", message: "invalid metadata" },
		{ kind: "duplicate" },
		{ kind: "duplicate" },
		{ kind: "duplicate" },
		{ kind: "insertion-error", message: "write failed" },
		{ kind: "imported" },
		undefined,
	]);
});

test("a failed batch request only fails unresolved payload items", () => {
	const outcomes = reconcileBulkImportOutcomes({
		itemCount: 4,
		preparationErrors: [{ itemIndex: 1, message: "metadata unavailable" }],
		duplicateItemIndices: [0],
		pendingPayloads: [
			{ itemIndex: 2, payloadIndex: 0 },
			{ itemIndex: 3, payloadIndex: 1 },
		],
		mutationError: "database unavailable",
	});

	assert.deepEqual(outcomes, [
		{ kind: "duplicate" },
		{ kind: "preparation-error", message: "metadata unavailable" },
		{ kind: "request-error", message: "database unavailable" },
		{ kind: "request-error", message: "database unavailable" },
	]);
});

test("out-of-range backend indices cannot change an item outcome", () => {
	const outcomes = reconcileBulkImportOutcomes({
		itemCount: 2,
		preparationErrors: [{ itemIndex: 8, message: "unmapped" }],
		duplicateItemIndices: [-1],
		pendingPayloads: [
			{ itemIndex: 0, payloadIndex: 0 },
			{ itemIndex: 1, payloadIndex: 1 },
		],
		batchResult: {
			total: 2,
			success: 2,
			failed: 0,
			duplicate_indices: [99],
			errors: [{ index: -1, message: "unmapped" }],
		},
	});

	assert.deepEqual(outcomes, [{ kind: "imported" }, { kind: "imported" }]);
});
