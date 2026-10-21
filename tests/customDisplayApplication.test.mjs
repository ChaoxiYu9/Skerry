import assert from "node:assert/strict";
import test from "node:test";
import { applyCustomData } from "../src/metadata/data/customDisplayOverrides.ts";

const createDisplay = (overrides = {}) => ({
	id: 1,
	id_type: "custom",
	sourceIds: {},
	name: "source name",
	name_cn: "source Chinese name",
	summary: "source summary",
	developer: "source developer",
	aliases: ["source alias"],
	tags: ["source tag"],
	...overrides,
});

test("base custom data preserves empty text and normalizes aliases and tags", () => {
	const display = createDisplay();
	applyCustomData(
		display,
		{
			name: "",
			name_cn: "",
			summary: "",
			developer: "",
			nsfw: false,
			aliases: ["alias", "alias", "other"],
			tags: ["tag", "tag", "other"],
		},
		"base",
	);

	assert.equal(display.name, "");
	assert.equal(display.name_cn, "");
	assert.equal(display.summary, "");
	assert.equal(display.developer, "");
	assert.equal(display.nsfw, false);
	assert.deepEqual(display.aliases, ["alias", "other"]);
	assert.deepEqual(display.tags, ["tag", "other"]);
});

test("curated base tags replace without deduplicating and missing arrays become empty", () => {
	const display = createDisplay();
	applyCustomData(
		display,
		{ aliases: null, tags: ["tag", "tag"], tags_curated: true },
		"base",
	);
	assert.deepEqual(display.aliases, []);
	assert.deepEqual(display.tags, ["tag", "tag"]);

	const emptyDisplay = createDisplay();
	applyCustomData(emptyDisplay, {}, "base");
	assert.deepEqual(emptyDisplay.aliases, []);
	assert.deepEqual(emptyDisplay.tags, []);
});

test("override mode keeps source fallback for empty summary and developer", () => {
	const display = createDisplay({ id_type: "mixed" });
	applyCustomData(
		display,
		{ name: "", summary: "", developer: "", aliases: ["new"], tags: ["new"] },
		"override",
	);

	assert.equal(display.name, "");
	assert.equal(display.summary, "source summary");
	assert.equal(display.developer, "source developer");
	assert.deepEqual(display.aliases, ["source alias", "new"]);
	assert.deepEqual(display.tags, ["source tag", "new"]);
});

test("curated override can clear tags while leaving unrelated source values", () => {
	const display = createDisplay({ id_type: "mixed" });
	applyCustomData(display, { tags_curated: true }, "override");
	assert.deepEqual(display.tags, []);
	assert.deepEqual(display.aliases, ["source alias"]);
	assert.equal(display.summary, "source summary");
});
