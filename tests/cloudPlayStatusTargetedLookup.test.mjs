import assert from "node:assert/strict";
import test from "node:test";
import {
	loadRequestedStatusMap,
	shouldUseTargetedStatusLookup,
	uniqueStatusLookupIds,
} from "../src/services/cloudPlayStatus/targetedStatusLookup.ts";

test("status lookup IDs keep first-seen order and discard empty duplicates", () => {
	assert.deepEqual(uniqueStatusLookupIds(["vn-2", "", "vn-1", "vn-2", ""]), [
		"vn-2",
		"vn-1",
	]);
});

test("targeted lookups compare missing IDs with the remaining collection pages", () => {
	const requestedIds = ["vn-1", "vn-2", "vn-3"];
	const firstPageStatuses = new Map([
		["vn-1", "played"],
		["vn-2", "wish"],
	]);

	assert.equal(
		shouldUseTargetedStatusLookup(requestedIds, firstPageStatuses, 2),
		true,
	);
	assert.equal(
		shouldUseTargetedStatusLookup(
			requestedIds,
			new Map([["vn-1", "played"]]),
			2,
		),
		false,
	);
	assert.equal(
		shouldUseTargetedStatusLookup(requestedIds, firstPageStatuses, 1),
		false,
	);
	assert.equal(
		shouldUseTargetedStatusLookup(
			requestedIds,
			new Map([
				["vn-1", "played"],
				["vn-2", "wish"],
				["vn-3", "playing"],
			]),
			1,
		),
		true,
	);
});

test("known page statuses satisfy requests and only missing IDs use direct lookups", async () => {
	const directRequests = [];
	const result = await loadRequestedStatusMap(
		["vn-3", "vn-1", "vn-2"],
		new Map([
			["vn-1", "played"],
			["vn-2", "wish"],
		]),
		async (id) => {
			directRequests.push(id);
			return id === "vn-3" ? "playing" : undefined;
		},
	);

	assert.deepEqual(directRequests, ["vn-3"]);
	assert.deepEqual(
		[...result],
		[
			["vn-3", "playing"],
			["vn-1", "played"],
			["vn-2", "wish"],
		],
	);
});

test("an absent page status still gets the direct lookup and missing results stay omitted", async () => {
	const directRequests = [];
	const result = await loadRequestedStatusMap(
		["vn-1", "vn-2"],
		new Map(),
		async (id) => {
			directRequests.push(id);
			return id === "vn-1" ? undefined : "dropped";
		},
	);

	assert.deepEqual(directRequests, ["vn-1", "vn-2"]);
	assert.deepEqual([...result], [["vn-2", "dropped"]]);
});
