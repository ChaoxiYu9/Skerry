import assert from "node:assert/strict";
import test from "node:test";
import {
	buildSessionEntries,
	readPotatoFiles,
} from "../src/pages/PotatoImport/potatoImport.ts";

function readPreview(playedTime) {
	const exportData = new TextEncoder().encode(
		JSON.stringify([{ Name: "Imported game", PlayedTime: playedTime }]),
	);
	return readPotatoFiles("sample.pvnExport", {
		"data.galgames.json": exportData,
	});
}

test("imports real PotatoVN slash dates as local play sessions", () => {
	const preview = readPreview({ "2026/3/19": 3 });
	const record = preview.records[0];

	assert.equal(preview.importable, 1);
	assert.equal(preview.withPlayHistory, 1);
	assert.ok(record);
	assert.deepEqual(record.playedTime, { "2026-03-19": 3 });
	const [session] = buildSessionEntries(73, record);
	assert.ok(session);
	assert.equal(session.gameId, 73);
	assert.equal(session.duration, 3);

	const localStart = new Date(session.startTime * 1000);
	assert.equal(localStart.getFullYear(), 2026);
	assert.equal(localStart.getMonth(), 2);
	assert.equal(localStart.getDate(), 19);
	assert.equal(localStart.getHours(), 0);
	assert.equal(localStart.getMinutes(), 1);
});

test("skips impossible calendar dates without dropping the game record", () => {
	const preview = readPreview({ "2026/2/31": 20 });
	const record = preview.records[0];

	assert.equal(preview.importable, 1);
	assert.equal(preview.withPlayHistory, 0);
	assert.ok(record);
	assert.deepEqual(record.playedTime, {});
	assert.deepEqual(buildSessionEntries(73, record), []);
});

test("accepts a valid leap-day history entry", () => {
	const preview = readPreview({ "2024/2/29": 90 });

	assert.deepEqual(preview.records[0]?.playedTime, { "2024-02-29": 90 });
});
