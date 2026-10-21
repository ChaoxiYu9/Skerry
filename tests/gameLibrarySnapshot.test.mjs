import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { QueryClient } from "@tanstack/react-query";

// Load the production TypeScript modules directly. Metadata projection and
// source parsing are explicit offline boundaries; the index/cache algorithms
// under test are the actual application implementations.
const testContext = vm.createContext({});
const loadedModules = new Map();
const indexUrl = new URL("../src/utils/game/gameIndex.ts", import.meta.url);
const cacheUrl = new URL(
	"../src/hooks/queries/gameCachePatch.ts",
	import.meta.url,
);
const sourceKeys = [
	"bgm",
	"vndb",
	"ymgal",
	"kun",
	"dlsite",
	"erogamescape",
	"hikarinagi",
];

function sourceModule(identifier, exports) {
	const existing = loadedModules.get(identifier);
	if (existing) return existing;
	const module = new vm.SyntheticModule(
		Object.keys(exports),
		function () {
			for (const [name, value] of Object.entries(exports))
				this.setExport(name, value);
		},
		{ context: testContext, identifier },
	);
	loadedModules.set(identifier, module);
	return module;
}

function typescriptModule(url) {
	const existing = loadedModules.get(url.href);
	if (existing) return existing;
	const source = stripTypeScriptTypes(
		readFileSync(fileURLToPath(url), "utf8"),
		{
			mode: "strip",
			sourceUrl: url.href,
		},
	);
	const module = new vm.SourceTextModule(source, {
		context: testContext,
		identifier: url.href,
	});
	loadedModules.set(url.href, module);
	return module;
}

const indexModule = typescriptModule(indexUrl);
const cacheModule = typescriptModule(cacheUrl);
await Promise.all(
	[indexModule, cacheModule].map((module) =>
		module.link((specifier) => {
			if (specifier === "@/metadata/constants") {
				return sourceModule("fixture:metadata-constants", {
					REGISTERED_SOURCE_KEYS: sourceKeys,
				});
			}
			if (specifier === "@/metadata/data/dataTransform") {
				return sourceModule("fixture:data-transform", {
					getDisplayGameData: (game) => ({
						id: game.id,
						...(game.custom_data ?? {}),
					}),
				});
			}
			if (specifier === "@/metadata/sourceRecord") {
				return sourceModule("fixture:source-record", {
					getSourceRecordMap: (game) =>
						new Map(
							(game.sources ?? []).map((record) => [record.source, record]),
						),
				});
			}
			if (specifier === "@/utils/game/gameIndex") return indexModule;
			throw new Error(`Unexpected game library test import: ${specifier}`);
		}),
	),
);
await Promise.all(
	[indexModule, cacheModule].map((module) => module.evaluate()),
);
const { getGameIndex } = indexModule.namespace;
const {
	patchGameCaches,
	patchManyGameCaches,
	appendGamesToCaches,
	removeGamesFromCaches,
} = cacheModule.namespace;

const keys = { all: ["library-snapshot"], index: () => ["library-index"] };
function game(id, developer = "Studio") {
	return {
		id,
		id_type: "custom",
		sources: [],
		custom_data: { name: `Game ${id}`, developer },
	};
}
function library(games) {
	const client = new QueryClient({
		defaultOptions: { queries: { gcTime: Infinity } },
	});
	client.setQueryData(keys.all, games);
	client.setQueryData(
		keys.index(),
		getGameIndex(client.getQueryData(keys.all)),
	);
	return client;
}
function assertSnapshot(client, expectedIds) {
	const raw = client.getQueryData(keys.all);
	const index = client.getQueryData(keys.index());
	assert.strictEqual(index.rawList, raw);
	assert.deepEqual(
		raw.map((entry) => entry.id),
		expectedIds,
	);
	assert.deepEqual(Array.from(index.ids), expectedIds);
	assert.deepEqual([...index.rawById.keys()], expectedIds);
	assert.deepEqual([...index.displayById.keys()], expectedIds);
	assert.deepEqual(
		Array.from(index.displayList, (entry) => entry.id),
		expectedIds,
	);
	assert.deepEqual([...index.sourceAvailabilityById.keys()], expectedIds);
	for (const entry of raw)
		assert.strictEqual(index.rawById.get(entry.id), entry);
	return index;
}

test("update never creates an index-only game absent from the stored library", () => {
	const client = library([game(1)]);
	patchGameCaches(client, keys, game(99));
	assertSnapshot(client, [1]);
	patchManyGameCaches(client, keys, [game(1, "Changed"), game(99)]);
	const index = assertSnapshot(client, [1]);
	assert.deepEqual(
		Array.from(index.developerGameIdsByName.get("Changed")),
		[1],
	);
	assert.equal(index.developerGameIdsByName.has("Studio"), false);
});

test("a stale derived index cannot resurrect a game removed by a full refresh", () => {
	const client = library([game(1), game(2)]);
	client.setQueryData(keys.all, [game(2), game(3)]);
	patchGameCaches(client, keys, game(2, "Updated"));
	assertSnapshot(client, [2, 3]);
});

test("new rows are prepended once in response order while current rows keep their place", () => {
	const client = library([game(1), game(2)]);
	assert.equal(
		appendGamesToCaches(client, keys, [game(3), game(3), game(1), game(4)]),
		true,
	);
	assertSnapshot(client, [3, 4, 1, 2]);
});

test("batch updates use the final response per ID consistently in every view", () => {
	const client = library([game(1), game(2)]);
	patchManyGameCaches(client, keys, [game(1, "First"), game(1, "Final")]);
	const index = assertSnapshot(client, [1, 2]);
	assert.equal(index.displayById.get(1).developer, "Final");
	assert.equal(index.rawById.get(1).custom_data.developer, "Final");
});

test("structurally identical responses reuse the stored records and display projections", () => {
	const client = library([game(1), game(2)]);
	const before = client.getQueryData(keys.index());
	patchGameCaches(client, keys, game(1));
	const unchanged = assertSnapshot(client, [1, 2]);
	assert.strictEqual(unchanged.displayById.get(1), before.displayById.get(1));
	patchGameCaches(client, keys, game(1, "Changed"));
	const changed = assertSnapshot(client, [1, 2]);
	assert.strictEqual(changed.displayById.get(2), before.displayById.get(2));
	assert.notStrictEqual(changed.displayById.get(1), before.displayById.get(1));
});

test("delete and empty-library transitions remove all derived identities", () => {
	const client = library([game(1, "A"), game(2, "B")]);
	removeGamesFromCaches(client, keys, [1, 99]);
	const index = assertSnapshot(client, [2]);
	assert.equal(index.developerGameIdsByName.has("A"), false);
	removeGamesFromCaches(client, keys, [2]);
	assert.equal(assertSnapshot(client, []).developerCategories.length, 0);
});

test("developer category counts and tied order follow the final library order", () => {
	const rows = [game(1, "A/B"), game(2, "B"), game(3, "")];
	const original = getGameIndex(rows);
	assert.deepEqual(
		Array.from(original.developerCategories, (category) => category.name),
		["B", "A", "__unknown_developer__"],
	);
	const reordered = getGameIndex([rows[2], rows[1]], original);
	assert.deepEqual(
		Array.from(reordered.developerCategories, (category) => category.name),
		["__unknown_developer__", "B"],
	);
});

test("mutations preserve the existing not-loaded cache contract", () => {
	const client = new QueryClient();
	patchGameCaches(client, keys, game(1));
	patchManyGameCaches(client, keys, [game(1)]);
	removeGamesFromCaches(client, keys, [1]);
	assert.equal(appendGamesToCaches(client, keys, [game(1)]), false);
	assert.equal(client.getQueryData(keys.all), undefined);
	assert.equal(client.getQueryData(keys.index()), undefined);
});
