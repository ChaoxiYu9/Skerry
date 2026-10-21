import assert from "node:assert/strict";
import test from "node:test";
import {
	createSearchIndex,
	getSearchSuggestionsFromData,
	preprocessSuggestionData,
	searchWithIndex,
} from "../src/utils/game/enhancedSearch.ts";

function game(id, fields = {}) {
	return {
		id,
		name: "",
		name_cn: "",
		custom_data: null,
		all_titles: [],
		aliases: [],
		...fields,
	};
}

test("direct results rank exact, prefix, and contains matches in that order", () => {
	const index = createSearchIndex([
		game(3, { name: "Alpha" }),
		game(2, { name: "Alpha Beta" }),
		game(1, { name: "Prelude Alpha" }),
	]);

	const results = searchWithIndex(index, " ALPHA ", { enableFuzzy: false });

	assert.deepEqual(
		results.map(({ item, score }) => [item.id, score]),
		[
			[3, 100],
			[2, 80],
			[1, 60],
		],
	);
});

test("text matches stay ahead of pinyin matches while ids break score ties", () => {
	const index = createSearchIndex([
		game(9, { name: "Prelude nihao" }),
		game(7, { name_cn: "你好" }),
		game(5, { name: "Another nihao" }),
	]);

	const results = searchWithIndex(index, "nihao", { enableFuzzy: false });

	assert.deepEqual(
		results.map(({ item, score }) => [item.id, score]),
		[
			[5, 60],
			[9, 60],
			[7, 95],
		],
	);
});

test("a direct match suppresses a pinyin match with the same game id", () => {
	const pinyinCopy = game(4, { name_cn: "你" });
	const directCopy = game(4, { name: "ni" });
	const index = createSearchIndex([pinyinCopy, directCopy]);

	const results = searchWithIndex(index, "ni", { enableFuzzy: false });

	assert.deepEqual(results.map(({ item }) => item), [directCopy]);
});

test("fuzzy fallback remains available and suggestions keep pinyin support", () => {
	const index = createSearchIndex([game(1, { name: "Morrowind" })]);
	const fuzzyResults = searchWithIndex(index, "morowind");
	const suggestions = getSearchSuggestionsFromData(
		preprocessSuggestionData([game(2, { name_cn: "你好" })]),
		"nihao",
	);

	assert.deepEqual(fuzzyResults.map(({ item }) => item.id), [1]);
	assert.deepEqual(suggestions, ["你好"]);
});

test("suggestions preserve text priority and pinyin match tiers", () => {
	const entries = preprocessSuggestionData([
		game(1, { name_cn: "你好" }),
		game(2, { name_cn: "你好吗" }),
		game(3, { name_cn: "好你" }),
		game(4, { name: "Nirvana" }),
	]);

	assert.deepEqual(getSearchSuggestionsFromData(entries, "ni"), [
		"Nirvana",
		"你好",
		"你好吗",
		"好你",
	]);
	assert.deepEqual(getSearchSuggestionsFromData(entries, "hao"), [
		"好你",
		"你好",
		"你好吗",
	]);
	assert.deepEqual(getSearchSuggestionsFromData(entries, "nh"), ["你好", "你好吗"]);
});

test("suggestions normalize punctuation out of precomputed spaced pinyin", () => {
	const entries = preprocessSuggestionData([game(1, { name_cn: "你-A好" })]);

	assert.deepEqual(getSearchSuggestionsFromData(entries, "niahao"), ["你-A好"]);
	assert.deepEqual(
		getSearchSuggestionsFromData(
			preprocessSuggestionData([game(2, { name: "Morrowind" })]),
			"xyz",
		),
		[],
	);
});
