import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const sourceTypes = [
	"bgm",
	"vndb",
	"hikarinagi",
	"ymgal",
	"kun",
	"dlsite",
	"erogamescape",
];
const moduleContext = vm.createContext({});
const sourceTypesModule = new vm.SyntheticModule(
	["SOURCE_TYPES", "isSourceType"],
	function () {
		this.setExport("SOURCE_TYPES", sourceTypes);
		this.setExport("isSourceType", (value) => sourceTypes.includes(value));
	},
	{ context: moduleContext, identifier: "source-types.fixture" },
);
const sourceRecordUrl = new URL(
	"../src/metadata/sourceRecord.ts",
	import.meta.url,
);
const sourceRecordModule = new vm.SourceTextModule(
	stripTypeScriptTypes(readFileSync(fileURLToPath(sourceRecordUrl), "utf8"), {
		mode: "strip",
		sourceUrl: sourceRecordUrl.href,
	}),
	{ context: moduleContext, identifier: sourceRecordUrl.href },
);

await sourceRecordModule.link((specifier) => {
	if (specifier === "@/types" || specifier === "../types/types.ts") {
		return sourceTypesModule;
	}
	throw new Error(`Unexpected source record test import: ${specifier}`);
});
await sourceRecordModule.evaluate();

const {
	getAnySourceId,
	getAnySourceIdMap,
	getSourceData,
	getSourceIdMap,
	getSourceRecord,
	getSourceRecordMap,
} = sourceRecordModule.namespace;
const toHostValue = (value) => JSON.parse(JSON.stringify(value));

test("source record lookup keeps the last usable record without indexing all records", () => {
	const visited = [];
	const payload = {
		sources: new Proxy(
			[
				{ source: "bgm", external_id: "old", data: { title: "old" } },
				{ source: "unknown", external_id: "ignored", data: {} },
				{ source: "bgm", external_id: null, data: null },
				{ source: "bgm", external_id: "new", data: { title: "new" } },
			],
			{
				get(target, property, receiver) {
					if (typeof property === "string" && /^\d+$/.test(property)) {
						visited.push(Number(property));
					}
					return Reflect.get(target, property, receiver);
				},
			},
		),
	};
	assert.deepEqual(toHostValue(getSourceRecord(payload, "bgm")), {
		source: "bgm",
		external_id: "new",
		data: { title: "new" },
	});
	assert.deepEqual(visited, [3]);
	visited.length = 0;
	assert.deepEqual(
		toHostValue(getSourceRecordMap(payload).get("bgm")),
		toHostValue(getSourceRecord(payload, "bgm")),
	);
	assert.equal(getSourceRecord({ sources: null }, "bgm"), undefined);
});

test("source record indexes and identity maps preserve null, empty, and precedence rules", () => {
	const payload = {
		sources: [
			{ source: "bgm", external_id: "", data: null },
			{ source: "vndb", external_id: null, data: { title: "v" } },
			{ source: "kun", external_id: "record-id", data: null },
			{ source: "invalid", external_id: "ignored", data: {} },
		],
	};

	assert.deepEqual(toHostValue(getSourceIdMap(payload)), { kun: "record-id" });
	assert.deepEqual(
		toHostValue(
			getAnySourceIdMap({
				sources: payload.sources,
				sourceIds: {
					bgm: "display-bgm",
					vndb: "display-vndb",
					kun: "display-kun",
				},
			}),
		),
		{
			bgm: "display-bgm",
			vndb: "display-vndb",
			kun: "record-id",
		},
	);
	assert.equal(
		getAnySourceId(
			{
				sources: [{ source: "bgm", external_id: "", data: null }],
				sourceIds: { bgm: "display-bgm" },
			},
			"bgm",
		),
		"display-bgm",
	);
	assert.deepEqual(toHostValue(getSourceData(payload, "vndb")), { title: "v" });
});
