interface OffsetPage<T> {
	data: T[];
	offset: number;
	limit: number;
	total: number;
}

interface MorePage<T> {
	results: T[];
	more: boolean;
}

interface NumberedPage<T> {
	items: T[];
	page: number;
	totalPages: number;
}

interface CursorPage<T> {
	items?: T[] | null;
	next_cursor?: string | null;
}

export async function collectOffsetPages<T>(
	fetchPage: (offset: number) => Promise<OffsetPage<T>>,
	signal?: AbortSignal,
): Promise<T[]> {
	const items: T[] = [];
	let pageOffset = 0;
	let page = await fetchOffsetPage(fetchPage, pageOffset, signal);

	while (true) {
		items.push(...page.data);
		const nextOffset = page.offset + page.limit;
		if (page.data.length === 0 || nextOffset >= page.total) break;
		if (nextOffset <= pageOffset) {
			throw new Error("Collection offset pagination did not advance");
		}
		pageOffset = nextOffset;
		page = await fetchOffsetPage(fetchPage, pageOffset, signal);
	}

	return items;
}

export async function collectMorePages<T>(
	fetchPage: (pageNumber: number) => Promise<MorePage<T>>,
	signal?: AbortSignal,
): Promise<T[]> {
	const items: T[] = [];
	let pageNumber = 1;

	while (true) {
		signal?.throwIfAborted();
		const page = await fetchPage(pageNumber);
		items.push(...page.results);
		if (!page.more || page.results.length === 0) break;
		pageNumber += 1;
	}

	return items;
}

export async function collectNumberedPages<T>(
	fetchPage: (pageNumber: number) => Promise<NumberedPage<T>>,
	signal?: AbortSignal,
): Promise<T[]> {
	const items: T[] = [];
	let pageNumber = 1;

	while (true) {
		signal?.throwIfAborted();
		const page = await fetchPage(pageNumber);
		items.push(...page.items);
		if (page.items.length === 0 || page.page >= page.totalPages) break;
		pageNumber += 1;
	}

	return items;
}

export async function collectCursorPages<T>(
	fetchPage: (cursor?: string) => Promise<CursorPage<T>>,
	signal?: AbortSignal,
	stopAfterPage?: (
		pageItems: readonly T[],
		collectedItems: readonly T[],
	) => boolean,
): Promise<T[]> {
	const items: T[] = [];
	const seenCursors = new Set<string>();
	let cursor: string | undefined;

	while (true) {
		signal?.throwIfAborted();
		const page = await fetchPage(cursor);
		const pageItems = Array.isArray(page.items) ? page.items : [];
		items.push(...pageItems);
		if (stopAfterPage?.(pageItems, items)) break;
		const nextCursor = page.next_cursor;
		if (!nextCursor || pageItems.length === 0) break;
		if (seenCursors.has(nextCursor)) {
			throw new Error("Collection cursor repeated before pagination ended");
		}
		seenCursors.add(nextCursor);
		cursor = nextCursor;
	}

	return items;
}

async function fetchOffsetPage<T>(
	fetchPage: (offset: number) => Promise<OffsetPage<T>>,
	offset: number,
	signal?: AbortSignal,
) {
	signal?.throwIfAborted();
	return fetchPage(offset);
}
