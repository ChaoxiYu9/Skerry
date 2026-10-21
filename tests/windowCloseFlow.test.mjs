import assert from "node:assert/strict";
import test from "node:test";
import {
	resolveTrayExitIntent,
	resolveWindowCloseIntent,
} from "../src/services/windowCloseFlow.ts";

const preferences = (skipCloseRemind, defaultCloseAction) => ({
	skipCloseRemind,
	defaultCloseAction,
});

test("requests ask for a choice until the user has opted out", () => {
	assert.deepEqual(
		resolveWindowCloseIntent({
			type: "requested",
			preferences: preferences(false, "close"),
			runningGameCount: 0,
		}),
		{ kind: "show-choice" },
	);
});

test("a remembered hide action keeps the app open even with running games", () => {
	assert.deepEqual(
		resolveWindowCloseIntent({
			type: "requested",
			preferences: preferences(true, "hide"),
			runningGameCount: 3,
		}),
		{ kind: "hide-window" },
	);
});

test("a remembered close action exits when no tracked games are running", () => {
	assert.deepEqual(
		resolveWindowCloseIntent({
			type: "requested",
			preferences: preferences(true, "close"),
			runningGameCount: 0,
		}),
		{ kind: "destroy-window" },
	);
});

test("a remembered close action asks before losing active tracking", () => {
	assert.deepEqual(
		resolveWindowCloseIntent({
			type: "requested",
			preferences: preferences(true, "close"),
			runningGameCount: 1,
		}),
		{ kind: "confirm-running-exit" },
	);
});

test("choosing hide records that default and hides immediately", () => {
	assert.deepEqual(
		resolveWindowCloseIntent({
			type: "selected",
			action: "hide",
			runningGameCount: 2,
		}),
		{ kind: "hide-window", rememberDefaultAction: "hide" },
	);
});

test("choosing close records that default before asking about active games", () => {
	assert.deepEqual(
		resolveWindowCloseIntent({
			type: "selected",
			action: "close",
			runningGameCount: 1,
		}),
		{ kind: "confirm-running-exit", rememberDefaultAction: "close" },
	);
});

test("choosing close records that default and exits when no games are running", () => {
	assert.deepEqual(
		resolveWindowCloseIntent({
			type: "selected",
			action: "close",
			runningGameCount: 0,
		}),
		{ kind: "destroy-window", rememberDefaultAction: "close" },
	);
});

test("explicit running-game confirmation exits without rechecking the count", () => {
	assert.deepEqual(
		resolveWindowCloseIntent({ type: "running-exit-confirmed" }),
		{ kind: "destroy-window" },
	);
});

test("tray exit asks only when a tracked game is running", () => {
	assert.deepEqual(resolveTrayExitIntent(0), { kind: "destroy-window" });
	assert.deepEqual(resolveTrayExitIntent(2), {
		kind: "confirm-running-exit",
	});
});
