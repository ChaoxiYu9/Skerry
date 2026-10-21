import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCloudCollectionCandidates } from "../src/services/cloudCollectionImport/candidates.ts";

test("empty cloud collection responses stay empty", () => {
	assert.deepEqual(normalizeCloudCollectionCandidates([]), []);
});

test("cloud collection candidates deduplicate by source identity in first-seen order", () => {
	const items = [
		{
			key: "stale-key",
			source: "bgm",
			externalId: "17",
			name: "Title",
		},
		{
			key: "another-stale-key",
			source: "bgm",
			externalId: "17",
			name: "Duplicate title",
			image: "https://example.invalid/cover.jpg",
			playStatus: 3,
		},
		{
			key: "vndb:17",
			source: "vndb",
			externalId: "17",
			name: "Different source identity",
		},
	];

	const candidates = normalizeCloudCollectionCandidates(items);

	assert.deepEqual(
		candidates.map(({ source, externalId }) => [source, externalId]),
		[
			["bgm", "17"],
			["vndb", "17"],
		],
	);
	assert.equal(candidates[0].key, "bgm:17");
	assert.equal(candidates[0].name, "Title");
	assert.equal(candidates[0].image, "https://example.invalid/cover.jpg");
	assert.equal(candidates[0].playStatus, 3);
});
