import assert from "node:assert/strict";
import test from "node:test";
import {
	logLevelOptions,
	parseSelectableLogLevel,
} from "../src/pages/Settings/system/logLevelOptions.ts";

test("the selectable log levels match the setting controls", () => {
	assert.deepEqual(
		logLevelOptions.map((option) => option.value),
		["error", "warn", "info", "debug"],
	);
	for (const level of ["error", "warn", "info", "debug"]) {
		assert.equal(parseSelectableLogLevel(level), level);
	}
});

test("runtime-only and unknown values are not accepted as user selections", () => {
	assert.equal(parseSelectableLogLevel("trace"), undefined);
	assert.equal(parseSelectableLogLevel("off"), undefined);
	assert.equal(parseSelectableLogLevel("unknown"), undefined);
});
