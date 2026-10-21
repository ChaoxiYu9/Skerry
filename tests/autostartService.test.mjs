import assert from "node:assert/strict";
import test from "node:test";
import { setAutostartEnabled } from "../src/services/plugins/autoStartService.ts";

test("setting the current startup state does not call the OS plugin again", async () => {
	const calls = [];
	const enabled = await setAutostartEnabled(true, {
		isEnabled: async () => {
			calls.push("read");
			return true;
		},
		enable: async () => calls.push("enable"),
		disable: async () => calls.push("disable"),
	});

	assert.equal(enabled, true);
	assert.deepEqual(calls, ["read"]);
});

test("setting startup on uses the requested state instead of reversing system state", async () => {
	let systemEnabled = false;
	const calls = [];
	const enabled = await setAutostartEnabled(true, {
		isEnabled: async () => {
			calls.push("read");
			return systemEnabled;
		},
		enable: async () => {
			calls.push("enable");
			systemEnabled = true;
		},
		disable: async () => calls.push("disable"),
	});

	assert.equal(enabled, true);
	assert.equal(systemEnabled, true);
	assert.deepEqual(calls, ["read", "enable"]);
});

test("setting startup off waits for the OS plugin operation", async () => {
	let finishDisable;
	let settled = false;
	const calls = [];
	const pendingDisable = new Promise((resolve) => {
		finishDisable = resolve;
	});
	const operation = setAutostartEnabled(false, {
		isEnabled: async () => {
			calls.push("read");
			return true;
		},
		enable: async () => calls.push("enable"),
		disable: async () => {
			calls.push("disable");
			await pendingDisable;
		},
	}).then((enabled) => {
		settled = true;
		return enabled;
	});

	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(calls, ["read", "disable"]);
	assert.equal(settled, false);

	finishDisable();
	assert.equal(await operation, false);
});

test("OS plugin failures reach the caller for state reconciliation", async () => {
	const failure = new Error("autostart update failed");
	await assert.rejects(
		setAutostartEnabled(true, {
			isEnabled: async () => false,
			enable: async () => {
				throw failure;
			},
			disable: async () => {},
		}),
		failure,
	);
});
