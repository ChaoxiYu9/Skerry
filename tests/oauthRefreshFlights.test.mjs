import assert from "node:assert/strict";
import test from "node:test";
import { createOAuthRefreshFlights } from "../src/services/oauth/oauthRefresh.ts";

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

test("concurrent refreshes with the same credential pair share one request", async () => {
	const response = deferred();
	let calls = 0;
	const refresh = createOAuthRefreshFlights(async () => {
		calls += 1;
		return response.promise;
	});
	const credentials = { access_token: "access-a", refresh_token: "refresh-a" };

	const first = refresh(credentials);
	const concurrent = refresh({ ...credentials });
	assert.strictEqual(concurrent, first);
	await Promise.resolve();
	assert.equal(calls, 1);

	response.resolve("updated-a");
	assert.equal(await first, "updated-a");
});

test("a changed access or refresh token gets an independent request", async () => {
	const responses = [deferred(), deferred(), deferred()];
	const calls = [];
	const refresh = createOAuthRefreshFlights((credentials) => {
		calls.push([credentials.access_token, credentials.refresh_token]);
		return responses[calls.length - 1].promise;
	});

	const original = refresh({
		access_token: "access-a",
		refresh_token: "refresh-a",
	});
	const newAccessToken = refresh({
		access_token: "access-b",
		refresh_token: "refresh-a",
	});
	const rotatedRefreshToken = refresh({
		access_token: "access-a",
		refresh_token: "refresh-b",
	});
	await Promise.resolve();

	assert.deepEqual(calls, [
		["access-a", "refresh-a"],
		["access-b", "refresh-a"],
		["access-a", "refresh-b"],
	]);
	responses[0].resolve("original");
	responses[1].resolve("new-access");
	responses[2].resolve("rotated-refresh");
	assert.deepEqual(
		await Promise.all([original, newAccessToken, rotatedRefreshToken]),
		["original", "new-access", "rotated-refresh"],
	);
});

test("a rejected request leaves no stale flight for the same credential pair", async () => {
	const failedResponse = deferred();
	const retryResponse = deferred();
	let calls = 0;
	const refresh = createOAuthRefreshFlights(() => {
		calls += 1;
		return calls === 1 ? failedResponse.promise : retryResponse.promise;
	});
	const credentials = { access_token: "access-a", refresh_token: "refresh-a" };

	const failedRequest = refresh(credentials);
	await Promise.resolve();
	failedResponse.reject(new Error("provider unavailable"));
	await assert.rejects(failedRequest, /provider unavailable/);

	const retry = refresh(credentials);
	await Promise.resolve();
	assert.equal(calls, 2);
	retryResponse.resolve("updated-a");
	assert.equal(await retry, "updated-a");
});
