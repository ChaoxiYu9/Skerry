import assert from "node:assert/strict";
import test from "node:test";
import {
	resolveCloudStatusByPriority,
	resolveCollectionSyncSources,
} from "../src/services/cloudPlayStatus/syncPlan.ts";

test("enabled cloud status sources retain provider order and include KunGal", () => {
	assert.deepEqual(
		resolveCollectionSyncSources({
			syncBgmCollection: true,
			syncVndbCollection: true,
			syncHikarinagiCollection: true,
			syncKungalCollection: true,
		}),
		["bgm", "vndb", "hikarinagi", "kun"],
	);
});

test("disabled cloud status sources do not enter the sync plan", () => {
	assert.deepEqual(
		resolveCollectionSyncSources({
			syncBgmCollection: false,
			syncVndbCollection: true,
			syncHikarinagiCollection: false,
			syncKungalCollection: true,
		}),
		["vndb", "kun"],
	);
});

test("cloud status lookup uses BGM, VNDB, Hikarinagi, then KunGal priority", () => {
	const sourceIds = {
		bgm: "bgm-1",
		vndb: "vndb-1",
		hikarinagi: "hikarinagi-1",
		kun: "kun-1",
	};
	const statusMaps = {
		bgm: new Map([["bgm-1", "bgm"]]),
		vndb: new Map([["vndb-1", "vndb"]]),
		hikarinagi: new Map([["hikarinagi-1", "hikarinagi"]]),
		kun: new Map([["kun-1", "kun"]]),
	};

	assert.equal(resolveCloudStatusByPriority(sourceIds, statusMaps), "bgm");
});

test("cloud status lookup skips absent IDs and maps before selecting VNDB", () => {
	assert.equal(
		resolveCloudStatusByPriority(
			{ bgm: "unlisted", vndb: "vndb-1", kun: "kun-1" },
			{
				bgm: new Map([["bgm-1", "bgm"]]),
				vndb: new Map([["vndb-1", "vndb"]]),
				kun: new Map([["kun-1", "kun"]]),
			},
		),
		"vndb",
	);
});

test("cloud status lookup can fall through to a matched KunGal record", () => {
	assert.equal(
		resolveCloudStatusByPriority(
			{
				bgm: "bgm-1",
				vndb: "vndb-1",
				hikarinagi: "hikarinagi-1",
				kun: "kun-1",
			},
			{
				bgm: new Map([["different-bgm", "bgm"]]),
				vndb: new Map(),
				hikarinagi: new Map(),
				kun: new Map([["kun-1", "kun"]]),
			},
		),
		"kun",
	);
});
