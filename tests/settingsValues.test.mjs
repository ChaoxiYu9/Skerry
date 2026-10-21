import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_CARD_CLICK_MODE,
	DEFAULT_CLOSE_ACTION,
	DEFAULT_STARTUP_PAGE,
	parseCardClickMode,
	parseDefaultCloseAction,
	parseSpoilerLevelOption,
	parseStartupPage,
} from "../src/types/settingsValues.ts";

test("settings defaults preserve the current user choices", () => {
	assert.equal(DEFAULT_STARTUP_PAGE, "home");
	assert.equal(DEFAULT_CARD_CLICK_MODE, "navigate");
	assert.equal(DEFAULT_CLOSE_ACTION, "hide");
});

test("startup page, card click mode, and close action accept only visible choices", () => {
	assert.deepEqual(["home", "libraries", "collection"].map(parseStartupPage), [
		"home",
		"libraries",
		"collection",
	]);
	assert.deepEqual(["navigate", "select"].map(parseCardClickMode), [
		"navigate",
		"select",
	]);
	assert.deepEqual(["hide", "close"].map(parseDefaultCloseAction), [
		"hide",
		"close",
	]);
	assert.equal(parseStartupPage("settings"), undefined);
	assert.equal(parseCardClickMode("launch"), undefined);
	assert.equal(parseDefaultCloseAction("minimize"), undefined);
});

test("spoiler level input becomes a bounded integer before it reaches the store", () => {
	assert.deepEqual(["0", "1", "2"].map(parseSpoilerLevelOption), [0, 1, 2]);
	assert.deepEqual([0, 1, 2].map(parseSpoilerLevelOption), [0, 1, 2]);
	for (const invalidValue of ["", "   ", "word", "1.5", "-1", "3", null]) {
		assert.equal(parseSpoilerLevelOption(invalidValue), undefined);
	}
});
