import assert from "node:assert/strict";
import test from "node:test";
import { createOAuthAttemptLifecycle } from "../src/services/oauth/oauthAttemptLifecycle.ts";

test("attempt lifecycle publishes status and invalidates a finished session", () => {
	const lifecycle = createOAuthAttemptLifecycle();
	const loadingStates = [];
	const unsubscribe = lifecycle.subscribe((isLoading) =>
		loadingStates.push(isLoading),
	);

	const attemptId = lifecycle.begin("session-a");
	lifecycle.setRunning(true);
	assert.equal(lifecycle.isCurrent(attemptId), true);
	assert.equal(lifecycle.isCommitting, false);
	lifecycle.setCommitting(true);
	assert.equal(lifecycle.isCommitting, true);
	lifecycle.setCommitting(false);

	const remountedLoadingStates = [];
	const unsubscribeRemounted = lifecycle.subscribe((isLoading) =>
		remountedLoadingStates.push(isLoading),
	);
	assert.deepEqual(remountedLoadingStates, [true]);
	unsubscribeRemounted();

	assert.equal(lifecycle.finish(attemptId, "session-a"), true);
	assert.equal(lifecycle.isRunning, false);
	assert.equal(lifecycle.sessionId, null);
	assert.equal(lifecycle.isCurrent(attemptId), false);
	assert.deepEqual(loadingStates, [false, true, false]);

	unsubscribe();
	lifecycle.setRunning(true);
	assert.deepEqual(loadingStates, [false, true, false]);
});

test("provider lifecycles keep their attempt state separate", () => {
	const bgm = createOAuthAttemptLifecycle();
	const hikarinagi = createOAuthAttemptLifecycle();

	const bgmAttemptId = bgm.begin("bgm-session");
	bgm.setRunning(true);

	assert.equal(bgm.isCurrent(bgmAttemptId), true);
	assert.equal(hikarinagi.isRunning, false);
	assert.equal(hikarinagi.sessionId, null);
});

test("a stale attempt cannot finish the current provider session", () => {
	const lifecycle = createOAuthAttemptLifecycle();
	const oldAttemptId = lifecycle.begin("old-session");
	lifecycle.setRunning(true);

	const cancelAttemptId = lifecycle.invalidate();
	assert.equal(lifecycle.finish(cancelAttemptId, "old-session"), true);

	const currentAttemptId = lifecycle.begin("current-session");
	lifecycle.setRunning(true);
	assert.equal(lifecycle.finish(oldAttemptId, "old-session"), false);
	assert.equal(lifecycle.isCurrent(currentAttemptId), true);
	assert.equal(lifecycle.sessionId, "current-session");
});

test("replacing and clearing event listeners releases each registration once", () => {
	const lifecycle = createOAuthAttemptLifecycle();
	const released = [];
	lifecycle.setEventListeners([
		() => released.push("old-code"),
		() => released.push("old-error"),
	]);
	lifecycle.setEventListeners([() => released.push("new-code")]);
	lifecycle.clearEventListeners();
	lifecycle.clearEventListeners();

	assert.deepEqual(released, ["old-code", "old-error", "new-code"]);
});
