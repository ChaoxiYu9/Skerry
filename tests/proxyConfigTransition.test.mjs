import assert from "node:assert/strict";
import test from "node:test";
import { synchronizeProxyConfig } from "../src/store/proxyConfigTransition.ts";

test("frontend proxy state commits only after backend configuration succeeds", async () => {
	const events = [];
	let finishBackendUpdate;
	const backendUpdate = new Promise((resolve) => {
		finishBackendUpdate = resolve;
	});
	const config = { url: "http://127.0.0.1:7890" };
	const transition = synchronizeProxyConfig(
		config,
		async () => {
			events.push("backend-started");
			await backendUpdate;
			events.push("backend-succeeded");
		},
		() => events.push("frontend-committed"),
		() => events.push("backend-failed"),
	);

	await Promise.resolve();
	assert.deepEqual(events, ["backend-started"]);

	finishBackendUpdate();
	await transition;
	assert.deepEqual(events, [
		"backend-started",
		"backend-succeeded",
		"frontend-committed",
	]);
});

test("frontend proxy state stays unchanged when backend configuration fails", async () => {
	const error = new Error("proxy client could not be built");
	let committed = false;
	let failureRecorded = false;

	await assert.rejects(
		synchronizeProxyConfig(
			{ url: "http://invalid" },
			async () => {
				throw error;
			},
			() => {
				committed = true;
			},
			() => {
				failureRecorded = true;
			},
		),
		error,
	);
	assert.equal(committed, false);
	assert.equal(failureRecorded, true);
});

test("concurrent proxy updates commit in the order they were requested", async () => {
	const events = [];
	let finishFirstUpdate;
	const firstUpdate = new Promise((resolve) => {
		finishFirstUpdate = resolve;
	});
	const firstConfig = { url: "http://proxy-a" };
	const secondConfig = { url: "http://proxy-b" };

	const first = synchronizeProxyConfig(
		firstConfig,
		async () => {
			events.push("backend-a-started");
			await firstUpdate;
			events.push("backend-a-finished");
		},
		() => events.push("frontend-a-committed"),
		() => events.push("backend-a-failed"),
	);
	const second = synchronizeProxyConfig(
		secondConfig,
		async () => {
			events.push("backend-b-started");
		},
		() => events.push("frontend-b-committed"),
		() => events.push("backend-b-failed"),
	);

	await Promise.resolve();
	finishFirstUpdate();
	await Promise.all([first, second]);

	assert.deepEqual(events, [
		"backend-a-started",
		"backend-a-finished",
		"frontend-a-committed",
		"backend-b-started",
		"frontend-b-committed",
	]);
});

test("a failed proxy update does not block the next requested update", async () => {
	const events = [];
	const failure = new Error("backend proxy update failed");
	const first = synchronizeProxyConfig(
		{ url: "http://proxy-a" },
		async () => {
			events.push("backend-a-started");
			throw failure;
		},
		() => events.push("frontend-a-committed"),
		() => events.push("backend-a-failed"),
	);
	const second = synchronizeProxyConfig(
		{ url: "http://proxy-b" },
		async () => {
			events.push("backend-b-started");
		},
		() => events.push("frontend-b-committed"),
		() => events.push("backend-b-failed"),
	);

	await assert.rejects(first, failure);
	await second;

	assert.deepEqual(events, [
		"backend-a-started",
		"backend-a-failed",
		"backend-b-started",
		"frontend-b-committed",
	]);
});
