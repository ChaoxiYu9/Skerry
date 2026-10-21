import assert from "node:assert/strict";
import test from "node:test";
import { prepareCloudCollectionSelection } from "../src/services/cloudCollectionImport/preparation.ts";
import { ApiRateLimitError } from "../src/utils/errors.ts";

function createItem(externalId, metadata) {
	return {
		key: `bgm:${externalId}`,
		source: "bgm",
		externalId,
		name: `Game ${externalId}`,
		...(metadata ? { metadata } : {}),
	};
}

const identityMerge = (metadata) => metadata;

test("preparation preserves selection order and isolates a single item failure", async () => {
	const items = [
		createItem("cached", { title: "Cached" }),
		createItem("failed"),
		createItem("ready"),
	];
	const fetched = [];
	const updates = [];
	const progress = [];
	const result = await prepareCloudCollectionSelection(items, {
		signal: new AbortController().signal,
		fetchDetails: async (item) => {
			fetched.push(item.externalId);
			if (item.externalId === "failed") throw new Error("detail unavailable");
			return { title: "Ready" };
		},
		mergePersonalData: identityMerge,
		onItemPrepared: (item) => updates.push(item),
		onProgress: (completed, total) => progress.push([completed, total]),
	});

	assert.deepEqual(fetched, ["failed", "ready"]);
	assert.deepEqual(
		result.map(({ item, metadata, error }) => [
			item.externalId,
			metadata?.title,
			error?.message,
		]),
		[
			["cached", "Cached", undefined],
			["failed", undefined, "detail unavailable"],
			["ready", "Ready", undefined],
		],
	);
	assert.deepEqual(updates, result);
	assert.deepEqual(progress, [
		[1, 3],
		[2, 3],
		[3, 3],
	]);
});

test("cancellation stops before preparing the next selected item", async () => {
	const controller = new AbortController();
	const fetched = [];
	const progress = [];
	const items = [createItem("first"), createItem("second")];

	await assert.rejects(
		prepareCloudCollectionSelection(items, {
			signal: controller.signal,
			fetchDetails: async (item) => {
				fetched.push(item.externalId);
				return { title: item.name };
			},
			mergePersonalData: identityMerge,
			onItemPrepared: () => undefined,
			onProgress: (completed) => {
				progress.push(completed);
				if (completed === 1) controller.abort();
			},
		}),
		{ name: "AbortError" },
	);

	assert.deepEqual(fetched, ["first"]);
	assert.deepEqual(progress, [1]);
});

test("cancellation after detail resolution does not publish that item", async () => {
	const controller = new AbortController();
	const updates = [];
	const progress = [];
	const items = [createItem("first"), createItem("second")];

	await assert.rejects(
		prepareCloudCollectionSelection(items, {
			signal: controller.signal,
			fetchDetails: async (item) => {
				if (item.externalId === "first") controller.abort();
				return { title: item.name };
			},
			mergePersonalData: identityMerge,
			onItemPrepared: (result) => updates.push(result),
			onProgress: (completed) => progress.push(completed),
		}),
		{ name: "AbortError" },
	);

	assert.deepEqual(updates, []);
	assert.deepEqual(progress, []);
});

test("a rate-limit failure is reported and stops later detail requests", async () => {
	const updates = [];
	const progress = [];
	const fetched = [];
	const items = [
		createItem("ready"),
		createItem("limited"),
		createItem("later"),
	];

	await assert.rejects(
		prepareCloudCollectionSelection(items, {
			signal: new AbortController().signal,
			fetchDetails: async (item) => {
				fetched.push(item.externalId);
				if (item.externalId === "limited") {
					throw new ApiRateLimitError({
						source: "bgm",
						message: "request rate limited",
					});
				}
				return { title: item.name };
			},
			mergePersonalData: identityMerge,
			onItemPrepared: (result) => updates.push(result),
			onProgress: (completed) => progress.push(completed),
		}),
		(error) => error instanceof ApiRateLimitError,
	);

	assert.deepEqual(fetched, ["ready", "limited"]);
	assert.deepEqual(
		updates.map((result) => [result.item.externalId, Boolean(result.error)]),
		[
			["ready", false],
			["limited", true],
		],
	);
	assert.deepEqual(progress, [1]);
});

test("observer failure propagates after successful preparation", async () => {
	const observerError = new Error("UI observer failed");
	const callbacks = [];
	const progress = [];
	const items = [createItem("first")];

	await assert.rejects(
		prepareCloudCollectionSelection(items, {
			signal: new AbortController().signal,
			fetchDetails: async () => ({ title: "Ready" }),
			mergePersonalData: identityMerge,
			onItemPrepared: (result) => {
				callbacks.push(result);
				if (result.metadata) throw observerError;
			},
			onProgress: (completed) => progress.push(completed),
		}),
		(error) => error === observerError,
	);

	assert.equal(callbacks.length, 1);
	assert.equal(callbacks[0].metadata.title, "Ready");
	assert.deepEqual(progress, []);
});
