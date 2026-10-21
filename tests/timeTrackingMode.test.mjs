import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_TIME_TRACKING_MODE,
	normalizeTimeTrackingMode,
	parseTimeTrackingMode,
} from "../src/types/timeTrackingMode.ts";

test("only the supported tracking modes are accepted and normalized", () => {
	assert.equal(DEFAULT_TIME_TRACKING_MODE, "playtime");
	assert.equal(parseTimeTrackingMode("playtime"), "playtime");
	assert.equal(parseTimeTrackingMode("elapsed"), "elapsed");
	assert.equal(parseTimeTrackingMode("foreground"), undefined);
	assert.equal(parseTimeTrackingMode(null), undefined);
	assert.equal(normalizeTimeTrackingMode(undefined), "playtime");
});

test("valid persisted modes remain unchanged", () => {
	for (const mode of ["playtime", "elapsed"]) {
		assert.equal(normalizeTimeTrackingMode(mode), mode);
	}
});

test("missing or invalid persisted values use the established default", () => {
	for (const mode of ["foreground", null, 2]) {
		assert.equal(normalizeTimeTrackingMode(mode), "playtime");
	}
	assert.equal(normalizeTimeTrackingMode(undefined), "playtime");
});
