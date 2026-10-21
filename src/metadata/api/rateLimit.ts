export type ApiRateLimitSource =
	| "bgm"
	| "vndb"
	| "ymgal"
	| "kun"
	| "dlsite"
	| "erogamescape"
	| "hikarinagi";

interface ApiRateLimitPolicy {
	minIntervalMs: number;
	defaultBackoffMs: number;
	maxBackoffMs: number;
	max429Retries: number;
	stopOn429: boolean;
	manualRetryDelayMs?: number;
}

interface ApiRateLimitState {
	nextStartAt: number;
	backoffUntil: number;
	consecutive429Count: number;
	tail: Promise<void>;
}

export interface ApiRateLimitedRequestOptions {
	source: ApiRateLimitSource;
}

export interface ApiRateLimitHandling {
	retryAfterMs?: number;
	backoffUntil?: number;
	shouldRetry: boolean;
	fatal: boolean;
}

const API_RATE_LIMIT_POLICIES: Record<ApiRateLimitSource, ApiRateLimitPolicy> =
	{
		vndb: {
			minIntervalMs: 1600,
			defaultBackoffMs: 30 * 1000,
			maxBackoffMs: 5 * 60 * 1000,
			max429Retries: 2,
			stopOn429: false,
		},
		bgm: {
			minIntervalMs: 250,
			defaultBackoffMs: 0,
			maxBackoffMs: 0,
			max429Retries: 0,
			stopOn429: true,
			manualRetryDelayMs: 60 * 60 * 1000,
		},
		ymgal: {
			minIntervalMs: 500,
			defaultBackoffMs: 5 * 1000,
			maxBackoffMs: 30 * 1000,
			max429Retries: 2,
			stopOn429: false,
		},
		kun: {
			minIntervalMs: 500,
			defaultBackoffMs: 0,
			maxBackoffMs: 0,
			max429Retries: 0,
			stopOn429: true,
		},
		dlsite: {
			minIntervalMs: 2000,
			defaultBackoffMs: 0,
			maxBackoffMs: 0,
			max429Retries: 0,
			stopOn429: true,
		},
		erogamescape: {
			minIntervalMs: 3000,
			defaultBackoffMs: 0,
			maxBackoffMs: 0,
			max429Retries: 0,
			stopOn429: true,
		},
		hikarinagi: {
			minIntervalMs: 500,
			defaultBackoffMs: 0,
			maxBackoffMs: 0,
			max429Retries: 0,
			stopOn429: true,
		},
	};

const rateLimitStates: Record<ApiRateLimitSource, ApiRateLimitState> = {
	vndb: createInitialState(),
	bgm: createInitialState(),
	ymgal: createInitialState(),
	kun: createInitialState(),
	dlsite: createInitialState(),
	erogamescape: createInitialState(),
	hikarinagi: createInitialState(),
};

function createInitialState(): ApiRateLimitState {
	return {
		nextStartAt: 0,
		backoffUntil: 0,
		consecutive429Count: 0,
		tail: Promise.resolve(),
	};
}

function createAbortError() {
	return new DOMException("Aborted", "AbortError");
}

function getRetryAfterMs(headers: Headers): number | undefined {
	const retryAfter = headers.get("Retry-After");
	if (!retryAfter) return undefined;

	const seconds = Number(retryAfter);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return seconds * 1000;
	}

	const retryAt = Date.parse(retryAfter);
	if (Number.isNaN(retryAt)) return undefined;

	return Math.max(0, retryAt - Date.now());
}

async function waitFor(ms: number, signal?: AbortSignal) {
	if (ms <= 0) return;
	if (signal?.aborted) throw createAbortError();

	await new Promise<void>((resolve, reject) => {
		const timer = globalThis.setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);

		const onAbort = () => {
			globalThis.clearTimeout(timer);
			reject(createAbortError());
		};

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function waitUntil(timestamp: number, signal?: AbortSignal) {
	await waitFor(Math.max(0, timestamp - Date.now()), signal);
}

async function runWhenAvailable<T>(
	source: ApiRateLimitSource,
	task: () => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (signal?.aborted) throw createAbortError();

	const state = rateLimitStates[source];
	const policy = API_RATE_LIMIT_POLICIES[source];
	await waitUntil(state.backoffUntil, signal);
	await waitUntil(state.nextStartAt, signal);

	if (signal?.aborted) throw createAbortError();
	state.nextStartAt = Date.now() + policy.minIntervalMs;

	return task();
}

export async function scheduleApiRequest<T>(
	source: ApiRateLimitSource,
	task: () => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	const state = rateLimitStates[source];
	const result = state.tail.then(() => runWhenAvailable(source, task, signal));

	state.tail = result.then(
		() => undefined,
		() => undefined,
	);

	return result;
}

export function handleApiRateLimited(
	source: ApiRateLimitSource,
	headers: Headers,
	attempt: number,
): ApiRateLimitHandling {
	const state = rateLimitStates[source];
	const policy = API_RATE_LIMIT_POLICIES[source];
	const now = Date.now();
	state.consecutive429Count += 1;
	const serverRetryAfterMs = getRetryAfterMs(headers);
	const fallbackDelayMs = Math.min(
		policy.defaultBackoffMs * 2 ** Math.max(0, state.consecutive429Count - 1),
		policy.maxBackoffMs,
	);
	const retryAfterMs = policy.stopOn429
		? serverRetryAfterMs === undefined
			? policy.manualRetryDelayMs
			: Math.max(serverRetryAfterMs, policy.manualRetryDelayMs ?? 0)
		: (serverRetryAfterMs ?? fallbackDelayMs);

	if (retryAfterMs !== undefined) {
		state.backoffUntil = now + retryAfterMs;
	}
	const backoffUntil =
		retryAfterMs === undefined ? undefined : state.backoffUntil;

	return {
		...(retryAfterMs === undefined ? {} : { retryAfterMs, backoffUntil }),
		shouldRetry: !policy.stopOn429 && attempt < policy.max429Retries,
		fatal: policy.stopOn429,
	};
}

export function markApiRequestSucceeded(source: ApiRateLimitSource) {
	const state = rateLimitStates[source];
	state.consecutive429Count = 0;
}
