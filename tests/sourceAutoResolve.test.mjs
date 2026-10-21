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
	resolve: { alias: { "@": path.resolve("src") } },
	server: { middlewareMode: true, hmr: false },
});
const { resolveAutoSelectedGameDraft, resolveSourceCandidateDraft } =
	await vite.ssrLoadModule(
	"/src/metadata/sourceAutoResolve.ts",
);
const { getSourceCandidateFromGame } = await vite.ssrLoadModule(
	"/src/metadata/sourceCandidate.ts",
);

after(async () => {
	await vite.close();
});

function createCandidate(overrides = {}) {
	return {
		source: "hikarinagi",
		externalId: "17",
		data: { name: "Search result" },
		display: { name: "Search result" },
		...overrides,
	};
}

function createAdapter(overrides = {}) {
	return {
		key: "hikarinagi",
		searchByName: async () => [],
		toDisplayFields: (data) => ({ name: data.name }),
		...overrides,
	};
}

test("draft resolution keeps the provider-ranked first result and requests one", async () => {
	const first = createCandidate();
	const adapter = createAdapter({
		searchByName: async (_query, options) => {
			assert.deepEqual(options, { limit: 1 });
			return [first, createCandidate({ data: { name: "Lower result" } })];
		},
	});

	assert.deepEqual(
		await resolveAutoSelectedGameDraft({ query: "title", adapter }),
		{
			id_type: "hikarinagi",
			sources: [
				{ source: "hikarinagi", external_id: "17", data: first.data },
			],
			custom_data: undefined,
		},
	);
});

test("a candidate without an external ID cannot become an import draft", async () => {
	const candidate = createCandidate({ externalId: undefined });
	let enrichCalls = 0;
	const adapter = createAdapter({
		searchByName: async () => [candidate],
		enrichOnSelect: async () => {
			enrichCalls += 1;
			throw new Error("must not request details without an ID");
		},
	});

	await assert.rejects(
		resolveAutoSelectedGameDraft({ query: "title", adapter }),
		/Missing hikarinagi external id/,
	);
	assert.equal(enrichCalls, 0);
});

test("draft resolution preserves enrichment and cross-source options", async () => {
	const candidate = createCandidate();
	let passedOptions;
	const expectedDraft = {
		id_type: "hikarinagi",
		sources: [
			{
				source: "hikarinagi",
				external_id: "17",
				data: { name: "Enriched draft" },
			},
		],
	};
	const adapter = createAdapter({
		searchByName: async () => [candidate],
		enrichOnSelect: async (_candidate, options) => {
			passedOptions = options;
			return expectedDraft;
		},
	});

	assert.equal(
		await resolveAutoSelectedGameDraft({ query: "title", adapter }),
		expectedDraft,
	);
	assert.deepEqual(passedOptions, { enrichCrossSource: true });

	await resolveAutoSelectedGameDraft({
		query: "title",
		adapter,
		enrichCrossSource: false,
	});
	assert.deepEqual(passedOptions, { enrichCrossSource: false });
});

test("candidate resolution shares the ID guard and defaults cross-source enrichment", async () => {
	const candidate = createCandidate();
	let passedOptions;
	const expectedDraft = { id_type: "hikarinagi", sources: [] };
	const adapter = createAdapter({
		enrichOnSelect: async (_candidate, options) => {
			passedOptions = options;
			return expectedDraft;
		},
	});

	assert.equal(
		await resolveSourceCandidateDraft(candidate, adapter),
		expectedDraft,
	);
	assert.deepEqual(passedOptions, { enrichCrossSource: true });

	const missingIdCandidate = createCandidate({ externalId: undefined });
	let enrichCalls = 0;
	const missingIdAdapter = createAdapter({
		enrichOnSelect: async () => {
			enrichCalls += 1;
			return expectedDraft;
		},
	});
	await assert.rejects(
		resolveSourceCandidateDraft(missingIdCandidate, missingIdAdapter),
		/Missing hikarinagi external id/,
	);
	assert.equal(enrichCalls, 0);
});

test("empty provider results resolve to null without enrichment", async () => {
	let enrichCalls = 0;
	const adapter = createAdapter({
		searchByName: async () => [],
		enrichOnSelect: async () => {
			enrichCalls += 1;
			return {};
		},
	});

	assert.equal(await resolveAutoSelectedGameDraft({ query: "missing", adapter }), null);
	assert.equal(enrichCalls, 0);
});

function createGameCandidate() {
	return {
		id_type: "mixed",
		sources: [
			{
				source: "bgm",
				external_id: "42",
				data: { name: "Original title", score: 8.1 },
			},
		],
	};
}

test("source adapter conversion keeps identity, raw data, and mapped display fields", () => {
	const game = createGameCandidate();
	let displayCalls = 0;
	const adapter = {
		key: "bgm",
		toDisplayFields: (data) => {
			displayCalls += 1;
			return { name: data.name, score: data.score };
		},
	};

	assert.deepEqual(getSourceCandidateFromGame(game, adapter), {
		source: "bgm",
		externalId: "42",
		data: { name: "Original title", score: 8.1 },
		display: { name: "Original title", score: 8.1 },
	});
	assert.equal(displayCalls, 1);
});

test("an explicit display mapping is retained without remapping source data", () => {
	const game = createGameCandidate();
	let displayCalls = 0;
	const adapter = {
		key: "bgm",
		toDisplayFields: () => {
			displayCalls += 1;
			return { name: "adapter display" };
		},
	};
	const display = { name: "caller display" };

	assert.deepEqual(getSourceCandidateFromGame(game, adapter, display), {
		source: "bgm",
		externalId: "42",
		data: { name: "Original title", score: 8.1 },
		display,
	});
	assert.equal(displayCalls, 0);
});

test("conversion reports a missing record for the requested source", () => {
	assert.throws(
		() =>
			getSourceCandidateFromGame(createGameCandidate(), {
				key: "vndb",
				toDisplayFields: () => ({}),
			}),
		/Missing vndb data in vndb candidate/,
	);
});
