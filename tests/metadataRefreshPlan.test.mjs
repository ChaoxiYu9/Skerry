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
const { planMetadataRefreshUpdates } = await vite.ssrLoadModule(
	"/src/metadata/data/metadataRefreshPlan.ts",
);

after(async () => {
	await vite.close();
});

test("refresh planning keeps binding order, duplicate games, and last matching provider response", () => {
	const bindings = [
		[8, "shared-id"],
		[3, "missing-id"],
		[5, "shared-id"],
	];
	const results = [
		{
			sources: [
				{ source: "bgm", external_id: "shared-id", data: { title: "old" } },
			],
		},
		{
			sources: [
				{
					source: "vndb",
					external_id: "shared-id",
					data: { title: "wrong source" },
				},
			],
		},
		{
			sources: [
				{ source: "bgm", external_id: "shared-id", data: { title: "latest" } },
			],
		},
	];

	const updates = planMetadataRefreshUpdates(bindings, results, "bgm");

	assert.deepEqual(
		updates.map(([gameId]) => gameId),
		[8, 5],
	);
	assert.deepEqual(
		updates.map(([, update]) => update.upsert_sources),
		[
			[{ source: "bgm", external_id: "shared-id", data: { title: "latest" } }],
			[{ source: "bgm", external_id: "shared-id", data: { title: "latest" } }],
		],
	);
});

test("a provider source record is looked up once even when its ID is bound to many games", () => {
	let sourceLookups = 0;
	const sourceRecords = [
		{ source: "vndb", external_id: "v17", data: { title: "shared" } },
	];
	const nativeFind = Array.prototype.find;
	Object.defineProperty(sourceRecords, "find", {
		value(predicate, thisArg) {
			sourceLookups += 1;
			return nativeFind.call(this, predicate, thisArg);
		},
	});
	const updates = planMetadataRefreshUpdates(
		[
			[1, "v17"],
			[2, "v17"],
			[3, "v17"],
		],
		[{ sources: sourceRecords }],
		"vndb",
	);

	assert.equal(updates.length, 3);
	assert.equal(sourceLookups, 1);
});
