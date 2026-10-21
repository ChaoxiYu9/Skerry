import assert from "node:assert/strict";
import test from "node:test";
import { importUserDataAndRestoreStore } from "../src/services/fs/userDataImportFlow.ts";

const importResult = (overrides = {}) => ({
	success: true,
	message: "导入成功，应用将自动重启",
	backupPath: "backup.db",
	storeJson: '{"state":{}}',
	restartRequired: true,
	...overrides,
});

test("successful backend import restores the archived WebView store", async () => {
	const writes = [];
	const result = importResult();
	const outcome = await importUserDataAndRestoreStore(
		"profile.7z",
		async (path) => {
			assert.equal(path, "profile.7z");
			return result;
		},
		(storeJson) => writes.push(storeJson),
	);

	assert.deepEqual(writes, [result.storeJson]);
	assert.deepEqual(outcome, { importResult: result, storeRestoreError: null });
});

test("storage failure preserves the committed result and restart requirement", async () => {
	const outcome = await importUserDataAndRestoreStore(
		"profile.7z",
		async () => importResult(),
		() => {
			throw new Error("存储空间不足");
		},
	);

	assert.equal(outcome.importResult.success, true);
	assert.equal(outcome.importResult.restartRequired, true);
	assert.equal(outcome.storeRestoreError, "存储空间不足");
});

test("failed backend import does not replace the current WebView store", async () => {
	let restoreCalled = false;
	const result = importResult({ success: false, storeJson: "replacement" });
	const outcome = await importUserDataAndRestoreStore(
		"profile.7z",
		async () => result,
		() => {
			restoreCalled = true;
		},
	);

	assert.equal(restoreCalled, false);
	assert.deepEqual(outcome, { importResult: result, storeRestoreError: null });
});

test("package without persisted store leaves WebView storage unchanged", async () => {
	let restoreCalled = false;
	const result = importResult({ storeJson: null });
	const outcome = await importUserDataAndRestoreStore(
		"profile.7z",
		async () => result,
		() => {
			restoreCalled = true;
		},
	);

	assert.equal(restoreCalled, false);
	assert.equal(outcome.importResult, result);
	assert.equal(outcome.storeRestoreError, null);
});
