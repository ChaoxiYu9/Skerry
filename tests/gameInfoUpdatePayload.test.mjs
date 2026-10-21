import assert from "node:assert/strict";
import path from "node:path";
import { after, test } from "node:test";
import { createServer } from "vite";

const vite = await createServer({
	configFile: false,
	root: process.cwd(),
	appType: "custom",
	logLevel: "error",
	optimizeDeps: { noDiscovery: true },
	resolve: {
		alias: [
			{ find: "@", replacement: path.resolve("src") },
			{ find: "@pkg", replacement: path.resolve("package.json") },
		],
	},
	server: { middlewareMode: true, hmr: false },
});
const { buildGameInfoUpdatePayload } = await vite.ssrLoadModule(
	"/src/metadata/data/metadata.ts",
);

after(async () => {
	await vite.close();
});

function game(overrides = {}) {
	return {
		id: 7,
		name: "Display name",
		localpath: "C:/Games/Title",
		executable: "title.exe",
		launch_type: "local",
		steam_launch_id: undefined,
		date: "2020-01-02",
		summary: "Summary",
		developer: "Studio",
		tags: [],
		nsfw: false,
		custom_data: {
			name: "Original name",
			name_cn: "中文名",
			translated_name: "Translated",
			aliases: ["Alias"],
			tags: ["Tag"],
			user_rating: 7.5,
			user_review: "Review",
			unrelated: "preserve me",
		},
		...overrides,
	};
}

test("unchanged fields are omitted and untouched custom data is preserved", () => {
	assert.deepEqual(
		buildGameInfoUpdatePayload(game(), {
			newLocalPath: " C:/Games/Title ",
			newName: " Original name ",
			newAliases: ["Alias"],
			newTags: ["Tag"],
			newUserRating: 7.54,
		}),
		{},
	);

	const payload = buildGameInfoUpdatePayload(game(), {
		newLocalPath: "C:/Games/Title",
		newName: "Renamed",
	});
	assert.deepEqual(payload.custom_data, {
		...game().custom_data,
		name: "Renamed",
	});
});

test("blank text and empty lists clear fields with the existing null patch form", () => {
	assert.deepEqual(
		buildGameInfoUpdatePayload(game(), {
			newLocalPath: "   ",
			newName: " ",
			newAliases: [],
			newTags: [],
			newSummary: "",
			newDeveloper: "",
			newDate: "",
			newUserReview: "",
		}),
		{
			localpath: null,
			date: null,
			custom_data: {
				...game().custom_data,
				name: null,
				aliases: null,
				tags: null,
				summary: null,
				developer: null,
				user_review: null,
			},
		},
	);
});

test("boolean false remains a value and rating keeps one-decimal zero-clear semantics", () => {
	const payload = buildGameInfoUpdatePayload(
		game({
			nsfw: true,
			custom_data: { ...game().custom_data, user_rating: 0 },
		}),
		{
			newLocalPath: "C:/Games/Title",
			newName: "Original name",
			newNsfw: false,
			newUserRating: 0,
		},
	);
	assert.deepEqual(payload.custom_data, {
		...game().custom_data,
		nsfw: false,
		user_rating: null,
	});

	const rounded = buildGameInfoUpdatePayload(game(), {
		newLocalPath: "C:/Games/Title",
		newName: "Original name",
		newUserRating: 8.26,
	});
	assert.equal(rounded.custom_data.user_rating, 8.3);
});
