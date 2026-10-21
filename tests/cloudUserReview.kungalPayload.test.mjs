import assert from "node:assert/strict";
import test from "node:test";
import { buildKunUserWorkRecordPayload } from "../src/services/cloudUserReview/kunWorkRecordPayload.ts";

test("zero rating keeps the review without inventing an overall or recommendation", () => {
	assert.deepEqual(
		buildKunUserWorkRecordPayload({
			normalizedRating: 0,
			reviewText: "值得一玩",
			workState: "doing",
			playtimeMinutes: 125,
		}),
		{
			work_state: { state: "doing" },
			rating: {
				short_summary: "值得一玩",
				spoiler_level: "none",
			},
			playtime: { minutes: 125 },
		},
	);
});

test("a zero rating without a review omits the rating while retaining status and time", () => {
	assert.deepEqual(
		buildKunUserWorkRecordPayload({
			normalizedRating: 0,
			reviewText: "",
			workState: "done",
			playtimeMinutes: 0,
		}),
		{
			work_state: { state: "done" },
			playtime: { minutes: 0 },
		},
	);
});

test("positive ratings keep KunGal overall and recommendation mappings", () => {
	for (const [normalizedRating, recommend] of [
		[1, "strong_no"],
		[3, "no"],
		[5, "neutral"],
		[7, "yes"],
		[9, "strong_yes"],
	]) {
		assert.deepEqual(
			buildKunUserWorkRecordPayload({ normalizedRating, reviewText: "" }),
			{
				rating: {
					overall: normalizedRating,
					recommend,
					spoiler_level: "none",
				},
			},
		);
	}
});

test("an empty score, review, status, and playtime keeps the existing empty update shape", () => {
	assert.deepEqual(
		buildKunUserWorkRecordPayload({ normalizedRating: 0, reviewText: "" }),
		{},
	);
});
