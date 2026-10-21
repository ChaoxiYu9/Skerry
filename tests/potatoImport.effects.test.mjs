import assert from "node:assert/strict";
import test from "node:test";
import { executePotatoImportEffects } from "../src/pages/PotatoImport/potatoImportEffects.ts";

function target(id) {
	return {
		record: {
			name: `game-${id}`,
			tags: [],
			ids: {},
			playedTime: { "2026-03-19": 12 },
		},
		game: { id, custom_data: {} },
	};
}

test("post-import failures stay with one effect and do not stop later games", async () => {
	const imageAttempts = [];
	const sessionAttempts = [];
	const failures = await executePotatoImportEffects([target(11), target(22)], {
		async saveImages(gameId) {
			imageAttempts.push(gameId);
			if (gameId === 11) throw new Error("asset write failed");
		},
		async saveSession(entry) {
			sessionAttempts.push(entry.gameId);
			if (entry.gameId === 11) throw new Error("session write failed");
		},
	});

	assert.deepEqual(imageAttempts, [11, 22]);
	assert.deepEqual(sessionAttempts, [11, 22]);
	assert.deepEqual(
		failures.map(({ gameId, stage }) => ({ gameId, stage })),
		[
			{ gameId: 11, stage: "images" },
			{ gameId: 11, stage: "session" },
		],
	);
});
