// This holds independent Image objects, never React-owned DOM/fibers. Retaining
// nearby decoded derivatives helps reverse scrolling; the browser may still
// reclaim its native decoded surfaces under system memory pressure.
const MEMORY_BUDGET_BYTES = 48 * 1024 * 1024;
const MAX_IMAGES = 160;
const MAX_IN_FLIGHT = 3;
const images = new Map<string, { image: HTMLImageElement; bytes: number }>();
const inFlight = new Set<string>();
let pending: string[] = [];
let retainedBytes = 0;

function pump() {
	while (inFlight.size < MAX_IN_FLIGHT && pending.length > 0) {
		const source = pending.shift();
		if (!source || images.has(source) || inFlight.has(source)) continue;
		inFlight.add(source);
		const image = new Image();
		image.decoding = "async";
		image.src = source;
		void image
			.decode()
			.then(() => {
				const bytes = image.naturalWidth * image.naturalHeight * 4;
				if (bytes <= 0 || bytes > MEMORY_BUDGET_BYTES) return;
				images.set(source, { image, bytes });
				retainedBytes += bytes;
				while (
					retainedBytes > MEMORY_BUDGET_BYTES ||
					images.size > MAX_IMAGES
				) {
					const oldest = images.entries().next().value;
					if (!oldest) break;
					images.delete(oldest[0]);
					retainedBytes -= oldest[1].bytes;
				}
			})
			.catch(() => {
				// The visible img owns its existing default-cover fallback.
			})
			.finally(() => {
				inFlight.delete(source);
				pump();
			});
	}
}

/** New viewport requests replace obsolete queued work after a distant jump. */
export function warmCardCovers(sources: readonly string[]) {
	pending = [];
	for (const source of new Set(sources.slice(0, MAX_IMAGES))) {
		const cached = images.get(source);
		if (cached) {
			images.delete(source);
			images.set(source, cached);
		} else if (!inFlight.has(source)) {
			pending.push(source);
		}
	}
	pump();
}

export function getCardImageCacheStats() {
	return {
		images: images.size,
		retainedBytes,
		inFlight: inFlight.size,
		queued: pending.length,
	};
}
