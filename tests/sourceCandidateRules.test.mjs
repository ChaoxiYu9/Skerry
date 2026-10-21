import assert from "node:assert/strict";
import test from "node:test";
import {
	deduplicateSourceCandidates,
	mergeSourceDetailPayload,
	resolveCandidateSourceRecords,
	resolveSelectedSourceRecords,
	selectDefaultSourceCandidate,
} from "../src/metadata/data/sourceCandidateRules.ts";

const sourceOrder = ["bgm", "vndb", "kun"];

test("later drafts replace provider records while output follows registered order", () => {
	const result = resolveCandidateSourceRecords(
		[
			[
				{ source: "vndb", external_id: "v17", data: { title: "search" } },
				{ source: "kun", external_id: "k9", data: { title: "kun" } },
			],
			[
				{ source: "vndb", external_id: "v18", data: { title: "detail" } },
			],
		],
		sourceOrder,
	);

	assert.deepEqual(result, [
		{ source: "vndb", external_id: "v18", data: { title: "detail" } },
		{ source: "kun", external_id: "k9", data: { title: "kun" } },
	]);
});

test("search candidates deduplicate by provider identity and retain first-seen order", () => {
	const first = { source: "bgm", externalId: "42", data: "first" };
	const distinctSource = { source: "vndb", externalId: "42", data: "other source" };
	const noIdentity = { source: "bgm", data: "unkeyed" };
	const duplicate = { source: "bgm", externalId: "42", data: "duplicate" };
	assert.deepEqual(
		deduplicateSourceCandidates([first, distinctSource, noIdentity, duplicate]),
		[first, distinctSource, noIdentity],
	);
	assert.equal(
		selectDefaultSourceCandidate(
			deduplicateSourceCandidates([first, duplicate, distinctSource]),
		),
		first,
	);
});

test("the first record for a provider within one draft is its identity", () => {
	const result = resolveCandidateSourceRecords(
		[
			[
				{ source: "bgm", external_id: "42", data: { title: "first" } },
				{ source: "bgm", external_id: "99", data: { title: "duplicate" } },
				{ source: "unknown", external_id: "x", data: {} },
			],
		],
		sourceOrder,
	);

	assert.deepEqual(result, [
		{ source: "bgm", external_id: "42", data: { title: "first" } },
	]);
});

test("detail fields replace search fields, undefined keeps search, and null clears", () => {
	assert.deepEqual(
		mergeSourceDetailPayload(
			{ title: "search title", summary: "search summary", tags: ["old"] },
			{ title: "detail title", summary: undefined, tags: null, date: "2026" },
		),
		{
			title: "detail title",
			summary: "search summary",
			tags: null,
			date: "2026",
		},
	);
});

test("selected providers are written once in registered order", () => {
	assert.deepEqual(
		resolveSelectedSourceRecords({
			selection: {
				kun: { source: "kun", externalId: "k9", data: { title: "kun" } },
				bgm: { source: "bgm", externalId: "42", data: { title: "bgm" } },
			},
			sourceOrder,
		}),
		{
			id_type: "mixed",
			sources: [
				{ source: "bgm", external_id: "42", data: { title: "bgm" } },
				{ source: "kun", external_id: "k9", data: { title: "kun" } },
			],
		},
	);
});

test("a single selected provider keeps its own id type", () => {
	assert.deepEqual(
		resolveSelectedSourceRecords({
			selection: {
				vndb: { source: "vndb", externalId: "v17", data: { title: "vndb" } },
			},
			sourceOrder,
		}),
		{
			id_type: "vndb",
			sources: [
				{ source: "vndb", external_id: "v17", data: { title: "vndb" } },
			],
		},
	);
});

test("a selected candidate cannot be persisted under another provider slot", () => {
	assert.throws(
		() =>
			resolveSelectedSourceRecords({
				selection: {
					bgm: { source: "vndb", externalId: "v17", data: {} },
				},
				sourceOrder,
			}),
		/Selected bgm candidate belongs to vndb/,
	);
});

test("selection requires at least one candidate and a provider id", () => {
	assert.throws(
		() => resolveSelectedSourceRecords({ selection: {}, sourceOrder }),
		/At least one source candidate must be selected/,
	);
	assert.throws(
		() =>
			resolveSelectedSourceRecords({
				selection: { bgm: { source: "bgm", data: {} } },
				sourceOrder,
			}),
		/Missing bgm external id in candidate/,
	);
});
