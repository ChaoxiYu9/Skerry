import assert from "node:assert/strict";
import test from "node:test";
import {
	handleApiRateLimited,
	scheduleApiRequest,
} from "../src/metadata/api/rateLimit.ts";

test("server Retry-After is honored even when it exceeds the local retry fallback cap", (t) => {
	t.mock.timers.enable({
		apis: ["Date"],
		now: new Date("2026-10-19T00:00:00Z"),
	});
	const now = Date.now();
	const handling = handleApiRateLimited(
		"vndb",
		new Headers({ "Retry-After": "600" }),
		0,
	);

	assert.equal(handling.shouldRetry, true);
	assert.equal(handling.fatal, false);
	assert.equal(handling.retryAfterMs, 600_000);
	assert.equal(handling.backoffUntil, now + 600_000);
});

test("HTTP-date Retry-After is preserved for a provider that stops on 429", () => {
	const retryAt = Date.now() + 120_000;
	const handling = handleApiRateLimited(
		"kun",
		new Headers({ "Retry-After": new Date(retryAt).toUTCString() }),
		0,
	);

	assert.equal(handling.shouldRetry, false);
	assert.equal(handling.fatal, true);
	assert.ok(handling.retryAfterMs && handling.retryAfterMs > 0);
	assert.ok(handling.backoffUntil && handling.backoffUntil >= retryAt - 1000);
});

test("BGM 429 stops the request and holds subsequent requests for the stated hour", async (t) => {
	t.mock.timers.enable({
		apis: ["Date", "setTimeout"],
		now: new Date("2026-10-19T00:00:00Z"),
	});
	const handling = handleApiRateLimited("bgm", new Headers(), 0);

	assert.equal(handling.shouldRetry, false);
	assert.equal(handling.fatal, true);
	assert.equal(handling.retryAfterMs, 60 * 60 * 1000);
	assert.equal(handling.backoffUntil, Date.now() + 60 * 60 * 1000);

	let requestStarted = false;
	const request = scheduleApiRequest("bgm", async () => {
		requestStarted = true;
		return "completed";
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(requestStarted, false);

	t.mock.timers.tick(60 * 60 * 1000);
	assert.equal(await request, "completed");
	assert.equal(requestStarted, true);
});
