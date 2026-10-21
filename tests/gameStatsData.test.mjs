import assert from "node:assert/strict";
import test from "node:test";
import { buildGameTimeChartData } from "../src/pages/Detail/stats/gameStatsData.ts";

process.env.TZ = "America/New_York";

function dateKeysFromUtc(startDate, count) {
	const date = new Date(`${startDate}T00:00:00.000Z`);
	return Array.from({ length: count }, () => {
		const key = date.toISOString().slice(0, 10);
		date.setUTCDate(date.getUTCDate() + 1);
		return key;
	});
}

test("7D and 30D cover inclusive local calendar days across spring DST", () => {
	const now = new Date("2024-03-11T16:00:00.000Z");
	const stats = [{ date: "2024-03-10", playtime: 75 }];

	const sevenDays = buildGameTimeChartData(stats, "7D", "2024-03", now);
	assert.deepEqual(
		sevenDays.map(({ date }) => date),
		dateKeysFromUtc("2024-03-05", 7),
	);
	assert.equal(
		sevenDays.find(({ date }) => date === "2024-03-10")?.playtime,
		75,
	);
	assert.equal(sevenDays.length, 7);

	const thirtyDays = buildGameTimeChartData(stats, "30D", "2024-03", now);
	assert.deepEqual(
		thirtyDays.map(({ date }) => date),
		dateKeysFromUtc("2024-02-11", 30),
	);
});

test("MONTH fills every local day, including leap day", () => {
	const result = buildGameTimeChartData(
		[{ date: "2024-02-29", playtime: 42 }],
		"MONTH",
		"2024-02",
		new Date("2024-03-11T16:00:00.000Z"),
	);

	assert.deepEqual(
		result.map(({ date }) => date),
		dateKeysFromUtc("2024-02-01", 29),
	);
	assert.equal(result[28].playtime, 42);
	assert.equal(result[0].playtime, 0);
});

test("1Y returns twelve ordered month buckets and sums daily values", () => {
	const result = buildGameTimeChartData(
		[
			{ date: "2023-02-02", playtime: 11 },
			{ date: "2023-02-28", playtime: 9 },
			{ date: "2024-01-03", playtime: 20 },
		],
		"1Y",
		"2024-01",
		new Date("2024-01-15T17:00:00.000Z"),
	);

	assert.deepEqual(
		result.map(({ date }) => date),
		[
			"2023-02",
			"2023-03",
			"2023-04",
			"2023-05",
			"2023-06",
			"2023-07",
			"2023-08",
			"2023-09",
			"2023-10",
			"2023-11",
			"2023-12",
			"2024-01",
		],
	);
	assert.equal(result[0].playtime, 20);
	assert.equal(result[11].playtime, 20);
});

test("ALL keeps daily buckets at sixty points and switches to months above it", () => {
	const sixtyDays = dateKeysFromUtc("2024-01-01", 60).map((date) => ({
		date,
		playtime: 1,
	}));
	const sixtyOneDays = dateKeysFromUtc("2024-01-01", 61).map((date) => ({
		date,
		playtime: 1,
	}));

	const daily = buildGameTimeChartData(
		sixtyDays,
		"ALL",
		"2024-03",
		new Date("2024-03-11T16:00:00.000Z"),
	);
	assert.deepEqual(
		daily.map(({ date }) => date),
		dateKeysFromUtc("2024-01-01", 60),
	);

	const monthly = buildGameTimeChartData(
		sixtyOneDays,
		"ALL",
		"2024-03",
		new Date("2024-03-11T16:00:00.000Z"),
	);
	assert.deepEqual(monthly, [
		{ date: "2024-01", playtime: 31 },
		{ date: "2024-02", playtime: 29 },
		{ date: "2024-03", playtime: 1 },
	]);
});

test("ALL keeps an exactly 180-day span daily and aggregates longer spans", () => {
	const dates = dateKeysFromUtc("2024-01-01", 182);
	const atLimit = buildGameTimeChartData(
		[
			{ date: dates[0], playtime: 4 },
			{ date: dates[180], playtime: 6 },
		],
		"ALL",
		"2024-06",
		new Date("2024-06-30T16:00:00.000Z"),
	);
	assert.deepEqual(atLimit, [
		{ date: dates[0], playtime: 4 },
		{ date: dates[180], playtime: 6 },
	]);

	const beyondLimit = buildGameTimeChartData(
		[
			{ date: dates[0], playtime: 4 },
			{ date: dates[181], playtime: 6 },
		],
		"ALL",
		"2024-06",
		new Date("2024-06-30T16:00:00.000Z"),
	);
	assert.deepEqual(beyondLimit, [
		{ date: "2024-01", playtime: 4 },
		{ date: "2024-06", playtime: 6 },
	]);
});

test("ALL switches to months beyond the existing span limit and keeps last date value", () => {
	const result = buildGameTimeChartData(
		[
			{ date: "2024-01-01", playtime: 12 },
			{ date: "2024-01-02", playtime: 20 },
			{ date: "2024-01-01", playtime: 5 },
			{ date: "2024-07-02", playtime: 8 },
		],
		"ALL",
		"2024-07",
		new Date("2024-07-15T16:00:00.000Z"),
	);

	assert.deepEqual(result, [
		{ date: "2024-01", playtime: 25 },
		{ date: "2024-07", playtime: 8 },
	]);
});
