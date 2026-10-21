import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const adapterModules = [
	["./adapters/bgmAdapter", "bgmAdapter", "bgm"],
	["./adapters/vndbAdapter", "vndbAdapter", "vndb"],
	["./adapters/ymgalAdapter", "ymgalAdapter", "ymgal"],
	["./adapters/kunAdapter", "kunAdapter", "kun"],
	["./adapters/dlsiteAdapter", "dlsiteAdapter", "dlsite"],
	["./adapters/erogamescapeAdapter", "erogamescapeAdapter", "erogamescape"],
	["./adapters/hikarinagiAdapter", "hikarinagiAdapter", "hikarinagi"],
];

const moduleContext = vm.createContext({});
const adapterFixtures = new Map(
	adapterModules.map(([, , key]) => [
		key,
		{
			key,
			label: `${key} fixture`,
			iconUrl: "",
			validateId: () => true,
			getExternalUrl: (id) => id,
			fetchById: async () => ({}),
			searchByName: async () => [],
			toDisplayFields: () => ({}),
		},
	]),
);
const modules = new Map();

function loadTypeScriptModule(url) {
	const identifier = url.href;
	const existing = modules.get(identifier);
	if (existing) {
		return existing;
	}

	const source = stripTypeScriptTypes(
		readFileSync(fileURLToPath(url), "utf8"),
		{
			mode: "strip",
			sourceUrl: identifier,
		},
	);
	const module = new vm.SourceTextModule(source, {
		context: moduleContext,
		identifier,
	});
	modules.set(identifier, module);
	return module;
}

function loadFixtureModule(identifier, exports) {
	const existing = modules.get(identifier);
	if (existing) {
		return existing;
	}

	const module = new vm.SyntheticModule(
		Object.keys(exports),
		function () {
			for (const [name, value] of Object.entries(exports)) {
				this.setExport(name, value);
			}
		},
		{ context: moduleContext, identifier },
	);
	modules.set(identifier, module);
	return module;
}

const sourceRegistryUrl = new URL(
	"../src/metadata/sourceRegistry.ts",
	import.meta.url,
);
const metadataDirectory = new URL("../src/metadata/", import.meta.url);
const sourceAdapterUrl = new URL("sourceAdapter.ts", metadataDirectory);
const sharedConstants = {
	DEFAULT_MIXED_SOURCE_KEYS: ["bgm", "vndb", "hikarinagi"],
	MIXED_SOURCE_KEYS: [
		"bgm",
		"vndb",
		"kun",
		"dlsite",
		"erogamescape",
		"hikarinagi",
	],
	MIXED_SOURCE_MAX_COUNT: 4,
	MIXED_SOURCE_MIN_COUNT: 2,
	REGISTERED_SOURCE_KEYS: [
		"bgm",
		"vndb",
		"ymgal",
		"kun",
		"dlsite",
		"erogamescape",
		"hikarinagi",
	],
	SEARCHABLE_SOURCE_KEYS: [
		"bgm",
		"vndb",
		"kun",
		"dlsite",
		"erogamescape",
		"hikarinagi",
	],
	isDeprecatedSource: (source) => source === "ymgal",
};
const sharedConstantsModule = loadFixtureModule(
	new URL("constants.fixture", metadataDirectory).href,
	sharedConstants,
);
const errorModule = loadFixtureModule(
	new URL("errors.fixture", metadataDirectory).href,
	{ AppError: class AppError extends Error {} },
);

const sourceRegistryModule = loadTypeScriptModule(sourceRegistryUrl);
await sourceRegistryModule.link((specifier, referencingModule) => {
	if (referencingModule.identifier === sourceRegistryUrl.href) {
		const adapter = adapterModules.find(
			([modulePath]) => modulePath === specifier,
		);
		if (adapter) {
			const [modulePath, exportName, key] = adapter;
			return loadFixtureModule(new URL(modulePath, metadataDirectory).href, {
				[exportName]: adapterFixtures.get(key),
			});
		}

		if (specifier === "./sourceAdapter") {
			return loadTypeScriptModule(sourceAdapterUrl);
		}
	}

	if (specifier === "./constants") {
		return sharedConstantsModule;
	}
	if (specifier === "@/utils/errors") {
		return errorModule;
	}
	throw new Error(`Unexpected source registry test import: ${specifier}`);
});
await sourceRegistryModule.evaluate();
const { SOURCE_ADAPTERS, bindSourceAdapters } = sourceRegistryModule.namespace;

test("every source key is bound once in registry order", () => {
	const boundAdapters = bindSourceAdapters({ spoilerLevel: 2 });
	const expectedSources = [
		"bgm",
		"vndb",
		"ymgal",
		"kun",
		"dlsite",
		"erogamescape",
		"hikarinagi",
	];

	assert.deepEqual(Object.keys(SOURCE_ADAPTERS), expectedSources);
	assert.deepEqual(Object.keys(boundAdapters), expectedSources);
	for (const source of expectedSources) {
		assert.equal(boundAdapters[source].key, source);
		assert.equal(boundAdapters[source].label, `${source} fixture`);
	}
});

test("bound provider requests retain session context and add request options", async () => {
	const adapter = SOURCE_ADAPTERS.bgm;
	const originalSearchByName = adapter.searchByName;
	const signal = new AbortController().signal;
	let receivedContext;

	adapter.searchByName = async (_name, context) => {
		receivedContext = context;
		return [];
	};

	try {
		const boundAdapter = bindSourceAdapters({
			proxyUrl: "http://127.0.0.1:7890",
			signal,
			spoilerLevel: 2,
			bgmToken: "session-token",
		}).bgm;

		await boundAdapter.searchByName("sample", {
			limit: 5,
			enrichCrossSource: true,
		});

		assert.strictEqual(receivedContext.signal, signal);
		assert.deepEqual(
			Object.fromEntries(
				Object.entries(receivedContext).filter(([key]) => key !== "signal"),
			),
			{
				proxyUrl: "http://127.0.0.1:7890",
				spoilerLevel: 2,
				bgmToken: "session-token",
				limit: 5,
				enrichCrossSource: true,
			},
		);
	} finally {
		adapter.searchByName = originalSearchByName;
	}
});
