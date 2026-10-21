export function createSerialTaskQueue() {
	const pendingTasks = new Map<string, Promise<unknown>>();

	return async function enqueue<T>(
		key: string,
		task: () => Promise<T>,
	): Promise<T> {
		const previous = pendingTasks.get(key) ?? Promise.resolve();
		const current = previous.then(task, task);
		pendingTasks.set(key, current);

		try {
			return await current;
		} finally {
			if (pendingTasks.get(key) === current) {
				pendingTasks.delete(key);
			}
		}
	};
}
