import assert from "node:assert/strict";
import test from "node:test";
import { resolveDraftDisplayRules } from "../src/metadata/data/draftDisplayRules.ts";

const registeredSourceOrder = [
	"bgm",
	"vndb",
	"ymgal",
	"kun",
	"dlsite",
	"erogamescape",
	"hikarinagi",
];

function resolve(displayFieldsBySource, preferredSource) {
	return resolveDraftDisplayRules({
		displayFieldsBySource,
		preferredSource,
		registeredSourceOrder,
	});
}

test("preferred original-name source moves first with the remaining order intact", () => {
	assert.equal(
		resolve({ kun: { name: "Kun title" }, bgm: { name: "BGM title" } })
			.originalName,
		"Kun title",
	);
	assert.equal(
		resolve({ kun: { name: "Kun title" }, bgm: { name: "BGM title" } }, "bgm")
			.originalName,
		"BGM title",
	);
});

test("Japanese kana wins over Latin, Han, and default-scored original names", () => {
	assert.equal(
		resolve({
			kun: { name: "A Latin title" },
			bgm: { name: "纯汉字" },
			vndb: { name: "Neutral title!" },
			hikarinagi: { name: "かなの題名" },
		}).originalName,
		"かなの題名",
	);
	assert.equal(
		resolve({ kun: { name: "纯汉字" }, bgm: { name: "—" } }).originalName,
		"—",
	);
	assert.equal(
		resolve({
			kun: { name: "纯汉字" },
			bgm: { name: "123" },
			vndb: { name: "Latin title" },
		}).originalName,
		"Latin title",
	);
});

test("known Chinese translation matches are penalized before source-order tie breaking", () => {
	assert.equal(
		resolve({
			kun: { name: "中文标题" },
			bgm: { name_cn: "中文标题", name: "123" },
		}).originalName,
		"123",
	);
	assert.equal(
		resolve({ kun: { name: "中文标题" }, bgm: { name: "中文标题" } })
			.originalName,
		"中文标题",
	);
	assert.equal(
		resolve({ kun: { name: "  First title  " }, bgm: { name: "Second title" } })
			.originalName,
		"First title",
	);
	assert.equal(
		resolve({ kun: { name: "   " }, bgm: { name: null } }).originalName,
		undefined,
	);
});

test("translated name chooses Chinese globally, then falls back in preferred-source order", () => {
	assert.equal(
		resolve({
			kun: { translated_name: "English title" },
			bgm: { translated_name: "にほんごのだいめい" },
			ymgal: { name_cn: "中文译名" },
		}).translatedName,
		"中文译名",
	);
	assert.equal(
		resolve(
			{
				kun: { translated_name: "Kun title" },
				bgm: { translated_name: "BGM title" },
			},
			"bgm",
		).translatedName,
		"BGM title",
	);
});

test("existing Han-range detection treats Japanese kanji as Chinese-containing", () => {
	assert.equal(
		resolve({
			bgm: { translated_name: "日本語の題名" },
			ymgal: { translated_name: "中文译名" },
		}).translatedName,
		"日本語の題名",
	);
});

test("Chinese name checks name_cn before translated_name for each source", () => {
	assert.equal(
		resolve({
			kun: { name_cn: "English title", translated_name: "Kun中文译名" },
			bgm: { name_cn: " 中文标题 " },
		}).chineseName,
		"中文标题",
	);
});

test("summary prefers any Chinese value before non-Chinese values", () => {
	assert.equal(
		resolve({
			kun: { summary: "English summary" },
			bgm: { summary: "にほんごのせつめい" },
			ymgal: { summary: "中文简介" },
		}).summary,
		"中文简介",
	);
});

test("summary fallback retains preferred-source and VNDB behavior", () => {
	assert.equal(
		resolve(
			{ kun: { summary: "Kun summary" }, vndb: { summary: "VNDB summary" } },
			"vndb",
		).summary,
		"VNDB summary",
	);
	assert.equal(
		resolve({ kun: { summary: "  " }, vndb: { summary: " VNDB summary " } })
			.summary,
		"VNDB summary",
	);
});

test("preferred-source dates do not fall back while mixed dates use registry order", () => {
	assert.equal(
		resolve({ vndb: { date: "  " }, kun: { date: "2024-01-01" } }, "vndb").date,
		undefined,
	);
	assert.equal(
		resolve({ kun: { date: "2024-01-01" }, bgm: { date: " 2023-05-02 " } })
			.date,
		"2023-05-02",
	);
});
