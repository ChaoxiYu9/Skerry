import assert from "node:assert/strict";
import test from "node:test";
import { refreshOAuthAuth } from "../src/services/oauth/oauthRefresh.ts";

function createOperations(overrides = {}) {
	const calls = [];
	return {
		calls,
		operations: {
			requestRefresh: async () => {
				calls.push("request");
				return { access_token: "access-new", refresh_token: "refresh-new" };
			},
			isCredentialError: (error) => error?.code === "invalid_grant",
			clearAuthIfCurrent: async () => {
				calls.push("clear");
				return true;
			},
			readCurrentAuth: async () => {
				calls.push("read-current");
				return { access_token: "access-current" };
			},
			publishRefreshedAuth: async () => calls.push("publish"),
			notifyReauthenticationRequired: () => calls.push("notify"),
			...overrides,
		},
	};
}

test("missing refresh credentials leave the saved auth unchanged", async () => {
	const { calls, operations } = createOperations();
	const auth = { access_token: "access-old" };

	assert.strictEqual(await refreshOAuthAuth(auth, operations), auth);
	assert.deepEqual(calls, []);
});

test("successful refresh publishes and returns the provider response", async () => {
	const refreshedAuth = {
		access_token: "access-new",
		refresh_token: "refresh-new",
	};
	const { calls, operations } = createOperations({
		requestRefresh: async () => refreshedAuth,
	});

	assert.strictEqual(
		await refreshOAuthAuth(
			{ access_token: "access-old", refresh_token: "refresh-old" },
			operations,
		),
		refreshedAuth,
	);
	assert.deepEqual(calls, ["publish"]);
});

test("an empty provider response rereads the persisted auth", async () => {
	const currentAuth = { access_token: "access-current" };
	const { calls, operations } = createOperations({
		requestRefresh: async () => {
			calls.push("request");
			return null;
		},
		readCurrentAuth: async () => {
			calls.push("read-current");
			return currentAuth;
		},
	});

	assert.strictEqual(
		await refreshOAuthAuth(
			{ access_token: "access-old", refresh_token: "refresh-old" },
			operations,
		),
		currentAuth,
	);
	assert.deepEqual(calls, ["request", "read-current"]);
});

test("invalid credentials clear the matching auth and notify the user", async () => {
	const invalidGrant = Object.assign(new Error("invalid_grant"), {
		code: "invalid_grant",
	});
	const { calls, operations } = createOperations({
		requestRefresh: async () => {
			calls.push("request");
			throw invalidGrant;
		},
	});

	assert.equal(
		await refreshOAuthAuth(
			{ access_token: "access-old", refresh_token: "refresh-old" },
			operations,
		),
		null,
	);
	assert.deepEqual(calls, ["request", "clear", "notify"]);
});

test("invalid credentials reread settings when the saved auth has changed", async () => {
	const currentAuth = { access_token: "access-new" };
	const invalidGrant = Object.assign(new Error("invalid_grant"), {
		code: "invalid_grant",
	});
	const { calls, operations } = createOperations({
		requestRefresh: async () => {
			calls.push("request");
			throw invalidGrant;
		},
		clearAuthIfCurrent: async () => {
			calls.push("clear");
			return false;
		},
		readCurrentAuth: async () => {
			calls.push("read-current");
			return currentAuth;
		},
	});

	assert.strictEqual(
		await refreshOAuthAuth(
			{ access_token: "access-old", refresh_token: "refresh-old" },
			operations,
		),
		currentAuth,
	);
	assert.deepEqual(calls, ["request", "clear", "read-current"]);
});

test("non-credential failures propagate without clearing the saved auth", async () => {
	const failure = new Error("provider unavailable");
	const { calls, operations } = createOperations({
		requestRefresh: async () => {
			calls.push("request");
			throw failure;
		},
	});

	await assert.rejects(
		refreshOAuthAuth(
			{ access_token: "access-old", refresh_token: "refresh-old" },
			operations,
		),
		(error) => error === failure,
	);
	assert.deepEqual(calls, ["request"]);
});
