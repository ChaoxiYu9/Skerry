import assert from "node:assert/strict";
import path from "node:path";
import { after, test } from "node:test";
import { createServer } from "vite";

const vite = await createServer({
	configFile: false,
	root: process.cwd(),
	appType: "custom",
	logLevel: "error",
	optimizeDeps: { noDiscovery: true },
	resolve: {
		alias: [{ find: "@", replacement: path.resolve("src") }],
	},
	server: { middlewareMode: true, hmr: false },
});
const { collectCursorPages } = await vite.ssrLoadModule(
	"/src/metadata/api/collectionPagination.ts",
);
const { mapFolderTitleToPlayStatus } = await vite.ssrLoadModule(
	"/src/services/cloudCollectionImport/kunGalFolderStatus.ts",
);
const { mergeKungalCollectionRecords } = await vite.ssrLoadModule(
	"/src/services/cloudCollectionImport/kunGalRecords.ts",
);
const { PlayStatus } = await vite.ssrLoadModule("/src/types/collection.ts");

after(async () => {
	await vite.close();
});

test("KunGal folder status classifier preserves every supported title keyword", () => {
	for (const title of ["在玩", "playing", "doing"]) {
		assert.equal(mapFolderTitleToPlayStatus(title), PlayStatus.PLAYING);
	}
	for (const title of ["玩过", "完成", "通关", "played", "done"]) {
		assert.equal(mapFolderTitleToPlayStatus(title), PlayStatus.PLAYED);
	}
	for (const title of ["搁置", "暂停", "on_hold", "stalled"]) {
		assert.equal(mapFolderTitleToPlayStatus(title), PlayStatus.ON_HOLD);
	}
	for (const title of ["抛弃", "弃坑", "dropped"]) {
		assert.equal(mapFolderTitleToPlayStatus(title), PlayStatus.DROPPED);
	}
});

test("KunGal folder status classifier preserves fallback and match precedence", () => {
	assert.equal(mapFolderTitleToPlayStatus(), PlayStatus.WISH);
	assert.equal(mapFolderTitleToPlayStatus("  "), PlayStatus.WISH);
	assert.equal(mapFolderTitleToPlayStatus("自定义收藏"), PlayStatus.WISH);
	assert.equal(
		mapFolderTitleToPlayStatus("played but still playing; then dropped"),
		PlayStatus.PLAYING,
	);
	assert.equal(
		mapFolderTitleToPlayStatus("done and on_hold"),
		PlayStatus.PLAYED,
	);
});

test("KunGal personal records follow opaque cursors until the last non-empty page", async () => {
	const cursors = [];
	const records = await collectCursorPages(async (cursor) => {
		cursors.push(cursor);
		if (!cursor) {
			return {
				items: [{ work_id: "favorite-1" }],
				next_cursor: "cursor-from-service",
			};
		}
		return { items: [{ work_id: "favorite-2" }] };
	});

	assert.deepEqual(cursors, [undefined, "cursor-from-service"]);
	assert.deepEqual(
		records.map((record) => record.work_id),
		["favorite-1", "favorite-2"],
	);
});

test("an empty KunGal page terminates even if it carries a cursor", async () => {
	let requestCount = 0;
	const records = await collectCursorPages(async () => {
		requestCount += 1;
		return { items: [], next_cursor: "unusable-cursor" };
	});

	assert.deepEqual(records, []);
	assert.equal(requestCount, 1);
});

test("personal records only enrich fetched collection members in collection order", () => {
	const candidates = [
		{
			externalId: "favorite-1",
			key: "kun:favorite-1",
			name: "Favorite one",
			source: "kun",
			playStatus: 1,
		},
		{
			externalId: "favorite-2",
			key: "kun:favorite-2",
			name: "Favorite two",
			source: "kun",
		},
	];
	const records = [
		{
			work_id: "favorite-1",
			personalData: {
				hasPlayStatus: true,
				playStatus: 3,
				userRating: 8,
				userReview: "  first review  ",
			},
		},
		{
			work_id: "not-favorited-3",
			personalData: {
				hasPlayStatus: true,
				playStatus: 2,
				userRating: 9,
				userReview: "must not become a candidate",
			},
		},
		{
			work_id: "favorite-1",
			personalData: {
				hasPlayStatus: true,
				playStatus: 2,
				userRating: undefined,
				userReview: undefined,
			},
		},
		{
			work_id: "favorite-2",
			personalData: {
				hasPlayStatus: false,
				userRating: 9,
				userReview: "second review",
			},
		},
	];

	const projectedWorkIds = [];
	const enriched = mergeKungalCollectionRecords(
		candidates,
		records,
		(record) => {
			projectedWorkIds.push(record.work_id);
			return record.personalData;
		},
	);

	assert.deepEqual(projectedWorkIds, [
		"favorite-1",
		"favorite-1",
		"favorite-2",
	]);
	assert.deepEqual(
		enriched.map((candidate) => candidate.externalId),
		["favorite-1", "favorite-2"],
	);
	assert.equal(enriched.length, candidates.length);
	assert.equal(enriched[0].playStatus, 2);
	assert.equal(enriched[0].userRating, 8);
	assert.equal(enriched[0].userReview, "  first review  ");
	assert.equal(enriched[1].userRating, 9);
	assert.equal(enriched[1].userReview, "second review");
	assert.equal(candidates[0].playStatus, 1);
});

test("a non-empty unknown KunGal state retains the existing clearing behavior", () => {
	const candidates = [
		{
			externalId: "favorite-1",
			key: "kun:favorite-1",
			name: "Favorite one",
			source: "kun",
			playStatus: 1,
		},
	];
	const enriched = mergeKungalCollectionRecords(
		candidates,
		[
			{
				work_id: "favorite-1",
				personalData: { hasPlayStatus: true, playStatus: undefined },
			},
		],
		(record) => record.personalData,
	);

	assert.equal(enriched[0].playStatus, undefined);
	assert.equal(Object.hasOwn(enriched[0], "playStatus"), true);
});
