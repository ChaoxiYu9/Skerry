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
		alias: [
			{ find: "@pkg", replacement: path.resolve("package.json") },
			{ find: "@", replacement: path.resolve("src") },
		],
	},
	server: { middlewareMode: true, hmr: false },
});
const { migrateAppStorePersistedState } = await vite.ssrLoadModule(
	"/src/store/appStoreMigrations.ts",
);

after(async () => {
	await vite.close();
});

test("version 0 migration preserves its contract without mutating stored input", () => {
	const persistedState = {
		mixedEnableYmgal: true,
		mixedEnableKun: true,
		selectedCategoryId: 7,
		selectedCategoryName: "Legacy category",
		currentGroupId: null,
		doubleClickLaunch: true,
		longPressLaunch: false,
		sortOption: "addtime",
		sortOrder: "asc",
		timeTrackingMode: "unsupported",
		unrecognizedPreference: "preserved",
	};
	const originalState = structuredClone(persistedState);

	assert.deepEqual(migrateAppStorePersistedState(persistedState, 0), {
		currentGroupId: null,
		sortOption: "addtime",
		sortOrder: "desc",
		timeTrackingMode: "playtime",
		unrecognizedPreference: "preserved",
		mixedEnabledSources: ["bgm", "vndb", "hikarinagi", "kun"],
		selectedCategory: { type: "real", id: 7 },
	});
	assert.deepEqual(persistedState, originalState);
});

test("legacy developer category names migrate only for the developer group", () => {
	const migrated = migrateAppStorePersistedState(
		{
			currentGroupId: "default_developer",
			selectedCategoryName: "Local category",
		},
		0,
	);

	assert.deepEqual(migrated.selectedCategory, {
		type: "developer",
		key: "Local category",
	});
});

test("an existing category selection wins over legacy category fields", () => {
	const selectedCategory = { type: "real", id: 9 };
	const migrated = migrateAppStorePersistedState(
		{
			selectedCategory,
			selectedCategoryId: 7,
			selectedCategoryName: "Legacy category",
		},
		0,
	);

	assert.equal(migrated.selectedCategory, selectedCategory);
	assert.equal("selectedCategoryId" in migrated, false);
	assert.equal("selectedCategoryName" in migrated, false);
});

test("version 2 migration corrects ascending add-time sort order", () => {
	assert.deepEqual(
		migrateAppStorePersistedState(
			{ sortOption: "addtime", sortOrder: "asc" },
			2,
		),
		{
			sortOption: "addtime",
			sortOrder: "desc",
			mixedEnabledSources: ["bgm", "vndb", "hikarinagi"],
			timeTrackingMode: "playtime",
		},
	);
});

test("version 3 migration canonicalizes the persisted Mixed source selection", () => {
	assert.deepEqual(
		migrateAppStorePersistedState(
			{ mixedEnabledSources: ["kun", "bgm", "unknown", "vndb"] },
			3,
		),
		{
			mixedEnabledSources: ["bgm", "vndb", "kun"],
			timeTrackingMode: "playtime",
		},
	);
	assert.deepEqual(
		migrateAppStorePersistedState({ mixedEnabledSources: ["bgm"] }, 3)
			.mixedEnabledSources,
		["bgm", "vndb", "hikarinagi"],
	);
});

test("version 4 migration preserves valid time tracking modes and defaults invalid values", () => {
	assert.deepEqual(
		migrateAppStorePersistedState({ timeTrackingMode: "elapsed" }, 4),
		{ timeTrackingMode: "elapsed" },
	);
	assert.deepEqual(
		migrateAppStorePersistedState({ timeTrackingMode: "foreground" }, 4),
		{ timeTrackingMode: "playtime" },
	);
});

test("version 5 migration removes the retired automatic cover-backup preference", () => {
	assert.deepEqual(
		migrateAppStorePersistedState(
			{
				autoBackupOnExit: true,
				autoBackupIncludeCovers: true,
				autoBackupRetentionCount: 7,
			},
			5,
		),
		{
			autoBackupOnExit: true,
			autoBackupRetentionCount: 7,
		},
	);
});

test("current and malformed persisted values pass through without mutation", () => {
	const currentState = { timeTrackingMode: "invalid", retained: true };
	const malformedArray = ["persisted array"];

	assert.equal(migrateAppStorePersistedState(currentState, 6), currentState);
	assert.equal(
		migrateAppStorePersistedState(malformedArray, 0),
		malformedArray,
	);
	assert.deepEqual(malformedArray, ["persisted array"]);
	assert.equal(migrateAppStorePersistedState(null, 0), null);
});
