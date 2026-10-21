interface AbortableRunner {
	controller: AbortController;
	withAbort: <T>(promise: Promise<T>) => Promise<T>;
}

export const createAbortableRunner = (): AbortableRunner => {
	const controller = new AbortController();
	const abortPromise = new Promise<never>((_, reject) => {
		controller.signal.addEventListener(
			"abort",
			() => {
				reject(new DOMException("Aborted", "AbortError"));
			},
			{ once: true },
		);
	});

	const withAbort = <T>(promise: Promise<T>) =>
		Promise.race([promise, abortPromise]) as Promise<T>;

	return {
		controller,
		withAbort,
	};
};

export const isAbortError = (error: unknown): boolean => {
	return error instanceof DOMException && error.name === "AbortError";
};
