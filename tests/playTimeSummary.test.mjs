import assert from "node:assert/strict";
import test from "node:test";
import { buildPlayTimeSummary } from "../src/services/game/playTimeSummary.ts";

test("play time summary keeps total, week, month, and daily buckets", () => {
	const now = new Date(2026, 9, 18, 12);
	const result = buildPlayTimeSummary(
		[
			{
				game_id: 1,
				total_time: 80,
				session_count: 5,
				daily_stats: [
					{ date: "2026-10-12", playtime: 10 },
					{ date: "2026-10-11", playtime: 5 },
					{ date: "2026-10-01", playtime: 6 },
					{ date: "2026-09-30", playtime: 20 },
					{ date: "2026-10-18", playtime: 12 },
				],
			},
			{
				game_id: 2,
				total_time: 35,
				session_count: 3,
				daily_stats: [
					{ date: "2026-10-18", playtime: 3 },
					{ date: "2026-10-12", playtime: 2 },
				],
			},
		],
		now,
	);

	assert.deepEqual(result, {
		totalPlayTime: 115,
		weekPlayTime: 27,
		monthPlayTime: 38,
		todayPlayTime: 15,
		monthlyDailyPlayTime: {
			"2026-10-12": 12,
			"2026-10-11": 5,
			"2026-10-01": 6,
			"2026-10-18": 15,
		},
		dailyPlayTime: {
			"2026-10-12": 12,
			"2026-10-11": 5,
			"2026-10-01": 6,
			"2026-09-30": 20,
			"2026-10-18": 15,
		},
	});
});

test("non-array daily stats do not break the summary or discard total time", () => {
	const result = buildPlayTimeSummary(
		[
			{
				game_id: 1,
				total_time: 30,
				session_count: 1,
				daily_stats: { "2026-10-18": 500 },
			},
		],
		new Date(2026, 9, 18, 12),
	);

	assert.equal(result.totalPlayTime, 30);
	assert.equal(result.weekPlayTime, 0);
	assert.equal(result.monthPlayTime, 0);
	assert.equal(result.todayPlayTime, 0);
	assert.deepEqual(result.monthlyDailyPlayTime, {});
	assert.deepEqual(result.dailyPlayTime, {});
});
