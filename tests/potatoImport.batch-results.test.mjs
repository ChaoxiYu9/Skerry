import assert from "node:assert/strict";
import test from "node:test";
import { mapInsertedPotatoRecords } from "../src/pages/PotatoImport/potatoImport.ts";

test("aligns compact database results with non-failed, non-duplicate records", () => {
	const records = [
		{ name: "first" },
		{ name: "duplicate" },
		{ name: "failed" },
		{ name: "last" },
	];
	const insertedGames = [
		{ id: 101, custom_data: { name: "first" } },
		{ id: 404, custom_data: { name: "last" } },
	];

	const mapped = mapInsertedPotatoRecords(records, {
		errors: [{ index: 2, message: "write failed" }],
		duplicate_indices: [1],
		games: insertedGames,
	});

	assert.deepEqual(mapped, [
		{ record: records[0], game: insertedGames[0] },
		{ record: records[3], game: insertedGames[1] },
	]);
});
