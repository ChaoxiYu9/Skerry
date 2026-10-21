export type OAuthStatusListener = (isLoading: boolean) => void;
export type OAuthEventUnlistener = () => void;

export interface OAuthAttemptLifecycle {
	readonly attemptId: number;
	readonly isRunning: boolean;
	readonly isCommitting: boolean;
	readonly sessionId: string | null;
	begin(sessionId: string): number;
	setRunning(isRunning: boolean): void;
	setCommitting(isCommitting: boolean): void;
	isCurrent(attemptId: number): boolean;
	invalidate(): number;
	finish(attemptId: number, sessionId: string | null): boolean;
	subscribe(listener: OAuthStatusListener): () => void;
	setEventListeners(unlisteners: readonly OAuthEventUnlistener[]): void;
	clearEventListeners(): void;
}

export function createOAuthAttemptLifecycle(): OAuthAttemptLifecycle {
	let attemptId = 0;
	let isRunning = false;
	let isCommitting = false;
	let sessionId: string | null = null;
	let eventUnlisteners: OAuthEventUnlistener[] = [];
	const statusListeners = new Set<OAuthStatusListener>();

	function notifyStatus() {
		for (const listener of statusListeners) {
			listener(isRunning);
		}
	}

	function clearEventListeners() {
		for (const unlisten of eventUnlisteners) {
			unlisten();
		}
		eventUnlisteners = [];
	}

	return {
		get attemptId() {
			return attemptId;
		},
		get isRunning() {
			return isRunning;
		},
		get isCommitting() {
			return isCommitting;
		},
		get sessionId() {
			return sessionId;
		},
		begin(nextSessionId) {
			attemptId += 1;
			sessionId = nextSessionId;
			return attemptId;
		},
		setRunning(nextIsRunning) {
			isRunning = nextIsRunning;
			notifyStatus();
		},
		setCommitting(nextIsCommitting) {
			isCommitting = nextIsCommitting;
		},
		isCurrent(candidateAttemptId) {
			return isRunning && candidateAttemptId === attemptId;
		},
		invalidate() {
			attemptId += 1;
			return attemptId;
		},
		finish(candidateAttemptId, finishedSessionId) {
			if (!isRunning || candidateAttemptId !== attemptId) return false;

			isRunning = false;
			if (sessionId === finishedSessionId) sessionId = null;
			attemptId += 1;
			notifyStatus();
			return true;
		},
		subscribe(listener) {
			statusListeners.add(listener);
			listener(isRunning);
			return () => {
				statusListeners.delete(listener);
			};
		},
		setEventListeners(nextUnlisteners) {
			clearEventListeners();
			eventUnlisteners = [...nextUnlisteners];
		},
		clearEventListeners,
	};
}
