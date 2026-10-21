import assert from "node:assert/strict";
import test from "node:test";
import {
	collectCursorPages,
	collectMorePages,
	collectNumberedPages,
	collectOffsetPages,
} from "../src/metadata/api/collectionPagination.ts";

test("offset pagination uses response offset and limit until total is reached", async () => {
	const requestedOffsets = [];
	const items = await collectOffsetPages(async (offset) => {
		requestedOffsets.push(offset);
		if (offset === 0) {
			return { data: ["first"], offset: 0, limit: 1, total: 2 };
		}
		return { data: ["second"], offset: 1, limit: 1, total: 2 };
	});

	assert.deepEqual(requestedOffsets, [0, 1]);
	assert.deepEqual(items, ["first", "second"]);
});

test("offset pagination stops if a response cannot advance the requested offset", async () => {
	await assert.rejects(
		collectOffsetPages(async () => ({
			data: ["stale-page"],
			offset: 0,
			limit: 0,
			total: 2,
		})),
		/did not advance/,
	);
});

test("more pagination stops on an empty page even when the service says more", async () => {
	const requestedPages = [];
	const items = await collectMorePages(async (page) => {
		requestedPages.push(page);
		return page === 1
			? { results: ["first"], more: true }
			: { results: [], more: true };
	});

	assert.deepEqual(requestedPages, [1, 2]);
	assert.deepEqual(items, ["first"]);
});

test("numbered pagination follows returned page metadata", async () => {
	const requestedPages = [];
	const items = await collectNumberedPages(async (page) => {
		requestedPages.push(page);
		return {
			items: [`page-${page}`],
			page,
			totalPages: 3,
		};
	});

	assert.deepEqual(requestedPages, [1, 2, 3]);
	assert.deepEqual(items, ["page-1", "page-2", "page-3"]);
});

test("cursor pagination passes opaque cursors through unchanged", async () => {
	const requestedCursors = [];
	const items = await collectCursorPages(async (cursor) => {
		requestedCursors.push(cursor);
		if (!cursor) {
			return { items: ["first"], next_cursor: "opaque/service cursor?x=1" };
		}
		return { items: ["second"] };
	});

	assert.deepEqual(requestedCursors, [undefined, "opaque/service cursor?x=1"]);
	assert.deepEqual(items, ["first", "second"]);
});

test("cursor pagination rejects a repeated continuation cursor", async () => {
	await assert.rejects(
		collectCursorPages(async () => ({
			items: ["still-present"],
			next_cursor: "same-cursor",
		})),
		/repeated/,
	);
});

test("cursor pagination can stop after the page containing all requested records", async () => {
	const requestedCursors = [];
	const items = await collectCursorPages(
		async (cursor) => {
			requestedCursors.push(cursor);
			return cursor
				? { items: ["later-page"] }
				: { items: ["requested-a", "requested-b"], next_cursor: "next" };
		},
		undefined,
		(pageItems) =>
			pageItems.includes("requested-a") &&
			pageItems.includes("requested-b"),
	);

	assert.deepEqual(items, ["requested-a", "requested-b"]);
	assert.deepEqual(requestedCursors, [undefined]);
});

test("pagination checks cancellation before issuing the next request", async () => {
	const controller = new AbortController();
	const requestedPages = [];
	await assert.rejects(
		collectMorePages(async (page) => {
			requestedPages.push(page);
			controller.abort();
			return { results: ["first"], more: true };
		}, controller.signal),
		{ name: "AbortError" },
	);
	assert.deepEqual(requestedPages, [1]);
});
