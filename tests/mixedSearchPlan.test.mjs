import assert from "node:assert/strict";
import test from "node:test";
import {
	createMixedSearchPlan,
	summarizeMixedSearchOutcomes,
} from "../src/metadata/data/mixedSearchPlan.ts";

const sources = ["bgm", "vndb", "hikarinagi"];

test("name search trims the query and keeps the configured source order", () => {
	assert.deepEqual(
		createMixedSearchPlan({
			query: "  Garden  ",
			sources,
			maxSources: 4,
		}),
		{ kind: "name-search", query: "Garden", sources },
	);
});

test("too many sources are rejected before selecting an operation", () => {
	assert.deepEqual(
		createMixedSearchPlan({
			query: "Garden",
			sources: [...sources, "kun", "dlsite"],
			maxSources: 4,
		}),
		{ kind: "too-many-sources" },
	);
});

test("a blank query produces an invalid plan", () => {
	assert.deepEqual(
		createMixedSearchPlan({
			query: "  ",
			sources,
			maxSources: 4,
		}),
		{ kind: "invalid-query" },
	);
});

test("failure summary retains ordered partial failures and ignores unattempted sources", () => {
	const summary = summarizeMixedSearchOutcomes(
		[
			{ source: "bgm", failed: true, attempted: true, error: "offline" },
			{ source: "vndb", failed: false, attempted: true },
			{ source: "hikarinagi", failed: false, attempted: false },
		],
		(error) => error === "missing",
	);

	assert.deepEqual(summary, {
		failedSources: ["bgm"],
		allAttemptedFailed: false,
		allAttemptedFailuresNotFound: false,
	});
});

test("all attempted missing results are distinguished from service failures", () => {
	const summary = summarizeMixedSearchOutcomes(
		[
			{ source: "bgm", failed: true, attempted: true, error: "missing" },
			{ source: "vndb", failed: true, attempted: true, error: "missing" },
		],
		(error) => error === "missing",
	);

	assert.equal(summary.allAttemptedFailed, true);
	assert.equal(summary.allAttemptedFailuresNotFound, true);
});

test("an attempted failure is not hidden by a source that was not queried", () => {
	const summary = summarizeMixedSearchOutcomes(
		[
			{ source: "bgm", failed: true, attempted: true, error: "offline" },
			{ source: "vndb", failed: false, attempted: false },
		],
		(error) => error === "missing",
	);

	assert.equal(summary.allAttemptedFailed, true);
	assert.equal(summary.allAttemptedFailuresNotFound, false);
});
