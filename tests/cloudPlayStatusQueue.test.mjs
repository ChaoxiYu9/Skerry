import assert from "node:assert/strict";
import test from "node:test";
import { createSerialTaskQueue } from "../src/services/cloudPlayStatus/serialTaskQueue.ts";

function deferred() {
	let resolve;
	const promise = new Promise((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

test("same-source status updates run in enqueue order", async () => {
	const enqueue = createSerialTaskQueue();
	const firstGate = deferred();
	const events = [];

	const first = enqueue("kun:42", async () => {
		events.push("first:start");
		await firstGate.promise;
		events.push("first:end");
		return true;
	});
	const second = enqueue("kun:42", async () => {
		events.push("second");
		return true;
	});

	await Promise.resolve();
	assert.deepEqual(events, ["first:start"]);
	firstGate.resolve();
	assert.deepEqual(await Promise.all([first, second]), [true, true]);
	assert.deepEqual(events, ["first:start", "first:end", "second"]);
});

test("failed status update does not block the next queued update", async () => {
	const enqueue = createSerialTaskQueue();
	const first = enqueue("bgm:17", async () => {
		throw new Error("network failure");
	});
	const second = enqueue("bgm:17", async () => "sent");

	await assert.rejects(first, /network failure/);
	assert.equal(await second, "sent");
});

test("different cloud identities can sync independently", async () => {
	const enqueue = createSerialTaskQueue();
	const gate = deferred();
	const first = enqueue("vndb:1", async () => gate.promise);
	const second = enqueue("vndb:2", async () => "sent");

	assert.equal(await second, "sent");
	gate.resolve("sent");
	assert.equal(await first, "sent");
});
