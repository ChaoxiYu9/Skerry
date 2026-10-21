import assert from "node:assert/strict";
import test from "node:test";
import { completeAndPersistOAuthAuth } from "../src/services/oauth/oauthAuthCommit.ts";

test("a current attempt persists the completed auth once", async () => {
	const baseAuth = { access_token: "access", username: null };
	const completedAuth = { ...baseAuth, username: "reader" };
	const persisted = [];
	const commitStates = [];
	const didPersist = await completeAndPersistOAuthAuth({
		auth: baseAuth,
		isCurrentAttempt: () => true,
		completeAuth: async () => completedAuth,
		persistAuth: async (auth) => {
			persisted.push(auth);
			assert.deepEqual(commitStates, [true]);
		},
		setCommitting: (committing) => commitStates.push(committing),
	});

	assert.equal(didPersist, true);
	assert.deepEqual(persisted, [completedAuth]);
	assert.deepEqual(commitStates, [true, false]);
});

test("cancellation during profile completion prevents a settings write", async () => {
	let isCurrent = true;
	let resolveCompletion;
	const persisted = [];
	const commitStates = [];
	const completion = new Promise((resolve) => {
		resolveCompletion = resolve;
	});
	const pending = completeAndPersistOAuthAuth({
		auth: { access_token: "access" },
		isCurrentAttempt: () => isCurrent,
		completeAuth: () => completion,
		persistAuth: async (auth) => persisted.push(auth),
		setCommitting: (committing) => commitStates.push(committing),
	});

	isCurrent = false;
	resolveCompletion({ access_token: "access", name: "reader" });

	assert.equal(await pending, false);
	assert.deepEqual(persisted, []);
	assert.deepEqual(commitStates, []);
});

test("profile failure saves the exchanged auth once and then preserves the error", async () => {
	const baseAuth = { access_token: "access", name: null };
	const profileError = new Error("profile unavailable");
	const persisted = [];
	const commitStates = [];
	await assert.rejects(
		completeAndPersistOAuthAuth({
			auth: baseAuth,
			isCurrentAttempt: () => true,
			completeAuth: async () => {
				throw profileError;
			},
			persistAuth: async (auth) => persisted.push(auth),
			setCommitting: (committing) => commitStates.push(committing),
		}),
		(error) => error === profileError,
	);

	assert.deepEqual(persisted, [baseAuth]);
	assert.deepEqual(commitStates, [true, false]);
});
