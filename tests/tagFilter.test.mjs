import assert from "node:assert/strict";
import test from "node:test";
import { matchesAllNormalizedTagFilters } from "../src/utils/game/tagFilter.ts";

test("all selected tags must match after trimming and case normalization", () => {
	assert.equal(
		matchesAllNormalizedTagFilters(
			["Action", "ADV"],
			new Set(["action", "adv"]),
		),
		true,
	);
	assert.equal(
		matchesAllNormalizedTagFilters(["Action"], new Set(["action", "adv"])),
		false,
	);
});

test("an empty filter accepts an untagged game and active filters reject it", () => {
	assert.equal(matchesAllNormalizedTagFilters([], new Set()), true);
	assert.equal(matchesAllNormalizedTagFilters([], new Set(["action"])), false);
});

test("repeated game tags cannot satisfy a different selected tag", () => {
	assert.equal(
		matchesAllNormalizedTagFilters(
			["Action", "action", "ACTION"],
			new Set(["action", "adv"]),
		),
		false,
	);
});

test("matching does not mutate the caller's selected tag set", () => {
	const selectedTags = new Set(["action", "adv"]);

	assert.equal(
		matchesAllNormalizedTagFilters(["Action", "ADV"], selectedTags),
		true,
	);
	assert.deepEqual([...selectedTags], ["action", "adv"]);
});
