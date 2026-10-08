type BrowserLockManager = {
	request: (
		name: string,
		options: { mode?: "shared" | "exclusive" },
		callback: () => Promise<void>,
	) => Promise<void>;
};

let keepAliveStarted = false;
let lastResumeAt = Number.NEGATIVE_INFINITY;
let heartbeatWorker: Worker | null = null;

const HEARTBEAT_INTERVAL_MS = 12_000;

const markResume = () => {
	lastResumeAt = typeof performance === "undefined" ? Date.now() : performance.now();
};

export function wasRecentlyResumed(windowMs = 1600) {
	const now = typeof performance === "undefined" ? Date.now() : performance.now();
	return now - lastResumeAt >= 0 && now - lastResumeAt <= windowMs;
}

function startRendererHeartbeat() {
	if (typeof window === "undefined") return;

	try {
		if (
			heartbeatWorker === null &&
			typeof Worker !== "undefined" &&
			typeof Blob !== "undefined"
		) {
			const source = [
				"let heartbeatTimer = null;",
				"const ping = () => self.postMessage(Date.now());",
				"self.onmessage = () => {",
				"  if (heartbeatTimer !== null) return;",
				"  ping();",
				"  heartbeatTimer = self.setInterval(ping, " + HEARTBEAT_INTERVAL_MS + ");",
				"};",
			].join("\n");
			const url = URL.createObjectURL(
				new Blob([source], { type: "text/javascript" }),
			);
			heartbeatWorker = new Worker(url, { name: "skerry-webview-heartbeat" });
			URL.revokeObjectURL(url);
			heartbeatWorker.onmessage = () => undefined;
			heartbeatWorker.postMessage("start");
		}
	} catch {
		heartbeatWorker?.terminate();
		heartbeatWorker = null;
	}

	window.setInterval(() => {
		void document.visibilityState;
	}, HEARTBEAT_INTERVAL_MS);
}

export function initWebviewKeepAlive() {
	if (keepAliveStarted || typeof navigator === "undefined") return;
	keepAliveStarted = true;
	startRendererHeartbeat();

	// Chromium can pause the first compositor frame after a long unfocus. The
	// resume marker lets expensive entrance effects yield that first frame.
	const handleResume = () => {
		if (document.visibilityState === "hidden") return;
		markResume();
		window.requestAnimationFrame(() => {
			window.requestAnimationFrame(() => undefined);
		});
	};
	document.addEventListener("visibilitychange", handleResume);
	window.addEventListener("focus", handleResume);
	window.addEventListener("pageshow", handleResume);

	const locks = (navigator as Navigator & { locks?: BrowserLockManager }).locks;
	if (!locks?.request) return;

	void locks
		.request("skerry-webview-keep-alive", { mode: "shared" }, () =>
			new Promise<void>(() => {
				// Chromium/WebView may suspend a hidden view after it sits idle. Holding
				// a shared WebLock keeps the document resident so focus does not pay a
				// multi-second wake-up cost.
			}),
		)
		.catch(() => {
			// Keep the foreground heartbeat alive even when WebLock is unavailable.
		});
}
