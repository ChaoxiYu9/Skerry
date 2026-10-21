export function uniqueStatusLookupIds(ids: Iterable<string>): string[] {
	return [...new Set(ids)].filter(Boolean);
}

export function shouldUseTargetedStatusLookup<Status>(
	ids: readonly string[],
	knownStatuses: ReadonlyMap<string, Status>,
	totalPageRequests: number,
): boolean {
	let missingStatusCount = 0;
	for (const id of ids) {
		if (!knownStatuses.has(id)) missingStatusCount += 1;
	}

	const remainingPageRequests = Math.max(totalPageRequests - 1, 0);
	return missingStatusCount <= remainingPageRequests;
}

export async function loadRequestedStatusMap<Status>(
	ids: readonly string[],
	knownStatuses: ReadonlyMap<string, Status>,
	fetchStatus: (id: string) => Promise<Status | undefined>,
): Promise<Map<string, Status>> {
	const requestedStatuses = new Map<string, Status>();

	for (const id of ids) {
		const knownStatus = knownStatuses.get(id);
		const status =
			knownStatus === undefined ? await fetchStatus(id) : knownStatus;
		if (status !== undefined) requestedStatuses.set(id, status);
	}

	return requestedStatuses;
}
