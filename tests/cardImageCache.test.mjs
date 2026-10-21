import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";

test("card warmup bounds decode concurrency, drops obsolete queued work and evicts decoded images by bytes", async () => {
	const requests = [];
	const active = new Map();
	const originalImage = globalThis.Image;
	globalThis.Image = class {
		naturalWidth = 768;
		naturalHeight = 1152;
		decode() {
			requests.push(this.src);
			return new Promise((resolve) =>
				active.set(this.src, () => {
					active.delete(this.src);
					resolve();
				}),
			);
		}
	};
	try {
		const { warmCardCovers, getCardImageCacheStats } = await import(
			"../src/services/game/cardImageCache.ts"
		);
		warmCardCovers(Array.from({ length: 50 }, (_, index) => `old-${index}`));
		assert.equal(active.size, 3);
		warmCardCovers(Array.from({ length: 50 }, (_, index) => `new-${index}`));
		while (active.size > 0) {
			for (const complete of [...active.values()]) complete();
			await setImmediate();
			assert.ok(active.size <= 3);
			assert.ok(getCardImageCacheStats().retainedBytes <= 48 * 1024 * 1024);
		}
		assert.equal(
			requests.filter((source) => source.startsWith("old-")).length,
			3,
		);
		assert.equal(
			requests.filter((source) => source.startsWith("new-")).length,
			50,
		);
		const before = requests.length;
		warmCardCovers(["new-49"]);
		assert.equal(
			requests.length,
			before,
			"a recently decoded cover should be reused",
		);
		warmCardCovers(["new-0"]);
		assert.equal(
			requests.length,
			before + 1,
			"an evicted image can be prepared again",
		);
		for (const complete of [...active.values()]) complete();
		await setImmediate();
	} finally {
		globalThis.Image = originalImage;
	}
});
