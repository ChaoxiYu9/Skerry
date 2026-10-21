import assert from "node:assert/strict";
import test from "node:test";
import { runAutoBackup } from "../src/services/fs/autoBackupFlow.ts";

const options = { auto: true, maxAutoBackups: 4 };
const result = (path) => ({ success: true, path, message: "备份成功" });

test("automatic backup invokes only the database command with retention policy", async () => {
	let receivedOptions;
	const expectedResult = result("database.db");
	const outcome = await runAutoBackup(4, async (options) => {
		receivedOptions = options;
		return expectedResult;
	});

	assert.deepEqual(receivedOptions, options);
	assert.equal(outcome, expectedResult);
});

test("database backup errors remain visible to the exit flow", async () => {
	const failure = new Error("数据库文件缺失");

	await assert.rejects(
		runAutoBackup(4, async () => {
			throw failure;
		}),
		(error) => error === failure,
	);
});
