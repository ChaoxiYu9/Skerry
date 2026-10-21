type MotionTraceEntry = {
	t: number;
	type: string;
	data?: Record<string, unknown>;
};

declare global {
	interface Window {
		__SKERRY_MOTION_TRACE?: MotionTraceEntry[];
		__SKERRY_MOTION_TRACE_ENABLED?: boolean;
		__SKERRY_MOTION_LAST_LONG_FRAME?: number;
		__SKERRY_EXPORT_MOTION_TRACE?: () => string;
	}
}

const MAX_TRACE_ENTRIES = 240;

export function isMotionTraceEnabled() {
	if (typeof window === "undefined") return false;
	if (!import.meta.env.DEV) return false;
	return (
		window.__SKERRY_MOTION_TRACE_ENABLED === true ||
		window.localStorage.getItem("skerry-motion-trace") === "1"
	);
}

export function traceMotion(type: string, data?: Record<string, unknown>) {
	if (!isMotionTraceEnabled()) return;
	const entry: MotionTraceEntry = {
		t: Math.round(performance.now() * 10) / 10,
		type,
		data,
	};
	const trace = (window.__SKERRY_MOTION_TRACE ??= []);
	trace.push(entry);
	if (trace.length > MAX_TRACE_ENTRIES) {
		trace.splice(0, trace.length - MAX_TRACE_ENTRIES);
	}
	window.__SKERRY_EXPORT_MOTION_TRACE ??= () =>
		JSON.stringify(window.__SKERRY_MOTION_TRACE ?? [], null, 2);
	window.localStorage.setItem(
		"skerry-motion-trace-last",
		JSON.stringify(trace.slice(-80)),
	);
	console.debug("[skerry-motion]", entry.type, entry.data ?? "", entry.t);
}

export function traceDuration<T>(
	type: string,
	data: Record<string, unknown>,
	work: () => T,
): T {
	if (!isMotionTraceEnabled()) return work();
	const start = performance.now();
	try {
		return work();
	} finally {
		const duration = performance.now() - start;
		traceMotion(type, {
			...data,
			duration: Math.round(duration * 10) / 10,
		});
	}
}

export function traceFrames(label: string, frameCount = 36) {
	if (!isMotionTraceEnabled()) return () => {};
	let previous = performance.now();
	let count = 0;
	let stopped = false;
	let frameId = 0;
	const tick = (now: number) => {
		if (stopped) return;
		const gap = now - previous;
		previous = now;
		count += 1;
		if (gap > 34) {
			window.__SKERRY_MOTION_LAST_LONG_FRAME = gap;
			traceMotion("long-frame", {
				label,
				frame: count,
				gap: Math.round(gap * 10) / 10,
			});
		}
		if (count < frameCount) {
			frameId = window.requestAnimationFrame(tick);
		}
	};
	frameId = window.requestAnimationFrame(tick);
	return () => {
		stopped = true;
		window.cancelAnimationFrame(frameId);
	};
}
