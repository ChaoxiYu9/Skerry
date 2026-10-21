import assert from "node:assert/strict";
import test from "node:test";
import {
	chooseCoverImage,
	chooseMixedSummary,
	firstDisplayField,
	mergeDisplayArrays,
	mergeMixedTags,
} from "../src/metadata/data/mixedDisplayDecisions.ts";

const summarySources = ["kun", "hikarinagi", "bgm"];

test("a Chinese non-VNDB summary outranks an earlier non-Chinese summary", () => {
	assert.equal(
		chooseMixedSummary(
			{
				kun: { summary: "English summary" },
				hikarinagi: { summary: "中文简介" },
				bgm: { summary: "日本語の説明" },
				vndb: { summary: "VNDB summary" },
			},
			summarySources,
			"vndb",
		),
		"中文简介",
	);
});

test("non-VNDB summaries outrank VNDB fallback, then VNDB is used when needed", () => {
	assert.equal(
		chooseMixedSummary(
			{
				kun: { summary: "   " },
				hikarinagi: { summary: "  English from Hikarinagi  " },
				bgm: { summary: "Later BGM summary" },
				vndb: { summary: "VNDB" },
			},
			summarySources,
			"vndb",
		),
		"  English from Hikarinagi  ",
	);
	assert.equal(
		chooseMixedSummary({ vndb: { summary: "VNDB" } }, summarySources, "vndb"),
		"VNDB",
	);
	assert.equal(
		chooseMixedSummary({ vndb: { summary: "" } }, summarySources, "vndb"),
		"",
	);
});

test("non-VNDB tags are trimmed, deduplicated, and ordered Chinese first", () => {
	assert.deepEqual(
		mergeMixedTags(
			{
				kun: { tags: ["  Mystery ", "悬疑", "悬疑"] },
				bgm: { tags: ["Drama", "Mystery"] },
				vndb: { tags: ["VNDB English"] },
			},
			summarySources,
			"vndb",
		),
		["悬疑", "Mystery", "Drama"],
	);
});

test("tag partitions preserve first-seen order within Chinese and other groups", () => {
	assert.deepEqual(
		mergeMixedTags(
			{
				kun: { tags: ["alpha", "中一", "beta", "中二", "alpha", "   "] },
				bgm: { tags: [" gamma ", "中一", "ALPHA"] },
			},
			["kun", "bgm"],
			"vndb",
		),
		["中一", "中二", "alpha", "beta", "gamma", "ALPHA"],
	);
});

test("VNDB tags are returned unchanged only when every non-VNDB source is empty", () => {
	assert.deepEqual(
		mergeMixedTags(
			{ vndb: { tags: ["  fallback ", "  fallback "] } },
			summarySources,
			"vndb",
		),
		["  fallback ", "  fallback "],
	);
	assert.deepEqual(
		mergeMixedTags(
			{ kun: { tags: "malformed" }, vndb: { tags: ["VNDB"] } },
			summarySources,
			"vndb",
		),
		["VNDB"],
	);
});

test("an explicitly selected cover wins and missing images fall back by priority", () => {
	const displays = {
		bgm: { image: "bgm-cover" },
		vndb: { image: "vndb-cover" },
	};
	assert.equal(
		chooseCoverImage(displays, "vndb", ["bgm", "vndb"]),
		"vndb-cover",
	);
	assert.equal(chooseCoverImage(displays, "kun", ["bgm", "vndb"]), "bgm-cover");
});

test("field priority accepts the first defined value and array merge keeps source order", () => {
	const displays = {
		kun: { developer: "", aliases: ["shared", "kun"] },
		bgm: { developer: "BGM developer", aliases: ["shared", "bgm"] },
	};
	assert.equal(firstDisplayField(displays, ["kun", "bgm"], "developer"), "");
	assert.deepEqual(mergeDisplayArrays(displays, ["kun", "bgm"], "aliases"), [
		"shared",
		"kun",
		"bgm",
	]);
});

test("array merge keeps exact values and first occurrence across source order", () => {
	const displays = {
		kun: { screenshots: ["", "shot-a", "shot-a"] },
		bgm: { screenshots: [" shot-a ", "shot-b"] },
		vndb: { screenshots: ["shot-b", "shot-c"] },
	};

	assert.deepEqual(
		mergeDisplayArrays(displays, ["kun", "bgm", "vndb"], "screenshots"),
		["", "shot-a", " shot-a ", "shot-b", "shot-c"],
	);
	assert.deepEqual(mergeDisplayArrays({}, ["kun"], "all_titles"), []);
});

test("field priority skips null and undefined but keeps an empty string", () => {
	assert.equal(
		firstDisplayField(
			{
				kun: { developer: null },
				bgm: { developer: "" },
				vndb: { developer: "Later developer" },
			},
			["kun", "bgm", "vndb"],
			"developer",
		),
		"",
	);
	assert.equal(
		firstDisplayField(
			{ kun: { developer: null }, bgm: { developer: undefined } },
			["kun", "bgm"],
			"developer",
		),
		undefined,
	);
});
