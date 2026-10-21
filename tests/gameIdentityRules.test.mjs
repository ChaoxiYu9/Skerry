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
const {
	createGameIdentityIndex,
	hasGameIdentityCollision,
	planUniqueGameCandidates,
} = await vite.ssrLoadModule("/src/metadata/data/gameIdentityRules.ts");
const { normalizeSteamLaunchId } = await vite.ssrLoadModule(
	"/src/utils/steam.ts",
);

after(async () => {
	await vite.close();
});

test("identity index uses registered source slots and source records take precedence", () => {
	const identities = createGameIdentityIndex([
		{
			sourceIds: { bgm: "old", vndb: "v17" },
			sources: [
				{ source: "bgm", external_id: "new", data: null },
				{ source: "unknown", external_id: "ignored", data: null },
			],
		},
	]);
	assert.equal(identities.hasSourceId("bgm", "new"), true);
	assert.equal(identities.hasSourceId("bgm", "old"), false);
	assert.equal(identities.hasSourceId("vndb", "v17"), true);
});

test("Steam launch identity is normalized and invalid identifiers are ignored", () => {
	assert.equal(normalizeSteamLaunchId("+42"), undefined);
	const identities = createGameIdentityIndex([
		{ sourceIds: {}, steam_launch_id: " 00042 " },
	]);
	assert.equal(
		hasGameIdentityCollision(
			{ sourceIds: {}, steam_launch_id: "42" },
			identities,
		),
		true,
	);
	assert.equal(
		hasGameIdentityCollision(
			{ sourceIds: {}, steam_launch_id: "0" },
			identities,
		),
		false,
	);
	assert.equal(
		hasGameIdentityCollision(
			{ sourceIds: {}, steam_launch_id: "18446744073709551616" },
			identities,
		),
		false,
	);
});

test("identity collision requires the same source slot or normalized Steam ID", () => {
	const existing = createGameIdentityIndex([
		{ sourceIds: { bgm: "42" }, steam_launch_id: "000730" },
	]);

	assert.equal(
		hasGameIdentityCollision({ sourceIds: { vndb: "42" } }, existing),
		false,
	);
	assert.equal(
		hasGameIdentityCollision({ sourceIds: { bgm: "42" } }, existing),
		true,
	);
	assert.equal(
		hasGameIdentityCollision(
			{ sourceIds: {}, steam_launch_id: "730" },
			existing,
		),
		true,
	);
});

test("batch planning keeps the first identity and does not claim IDs from a skipped candidate", () => {
	const candidates = [
		{ sourceIds: {} },
		{ sourceIds: { vndb: "42" } },
		{ sourceIds: { bgm: "42" } },
		{ sourceIds: { vndb: "v17", kun: "k3" } },
		{ sourceIds: { vndb: "v17", bgm: "9" } },
		{ sourceIds: { bgm: "9" } },
		{ sourceIds: { kun: "k3" } },
	];
	const plan = planUniqueGameCandidates(
		candidates,
		createGameIdentityIndex([{ sourceIds: { bgm: "42" } }]),
	);

	assert.deepEqual(
		plan.accepted.map(({ candidateIndex }) => candidateIndex),
		[0, 1, 3, 5],
	);
	assert.deepEqual(plan.duplicateIndices, [2, 4, 6]);
});

test("identity-free candidates remain importable in input order", () => {
	const first = { sourceIds: {} };
	const second = { sourceIds: {} };
	const plan = planUniqueGameCandidates(
		[first, second],
		createGameIdentityIndex([]),
	);

	assert.deepEqual(plan.accepted, [
		{ candidateIndex: 0, candidate: first },
		{ candidateIndex: 1, candidate: second },
	]);
	assert.deepEqual(plan.duplicateIndices, []);
});

test("batch planning probes typed identity slots without enumerating them", () => {
	const queriedIdentities = [];
	const existingIdentities = {
		hasSourceId(source, externalId) {
			queriedIdentities.push(`${source}:${externalId}`);
			return source === "bgm" && externalId === "existing";
		},
		hasNormalizedSteamLaunchId(launchId) {
			queriedIdentities.push(`steam-launch:${launchId}`);
			return false;
		},
	};
	const candidates = [
		{ sourceIds: { bgm: "existing" } },
		{ sourceIds: { bgm: "new" } },
		{ sourceIds: { bgm: "new" } },
	];

	const plan = planUniqueGameCandidates(candidates, existingIdentities);

	assert.deepEqual(
		plan.accepted.map(({ candidateIndex }) => candidateIndex),
		[1],
	);
	assert.deepEqual(plan.duplicateIndices, [0, 2]);
	assert.deepEqual(queriedIdentities, ["bgm:existing", "bgm:new", "bgm:new"]);
});
