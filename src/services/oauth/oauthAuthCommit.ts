type CompleteAndPersistOAuthAuthOptions<Auth> = {
	/** The attempt identity check used by the active provider controller. */
	isCurrentAttempt: () => boolean;
	auth: Auth;
	/** Optional provider profile completion; token exchange stays provider-owned. */
	completeAuth?: (auth: Auth) => Promise<Auth>;
	/** The single settings write for this authorization attempt. */
	persistAuth: (auth: Auth) => Promise<void>;
	/** Prevents cancellation after the settings write has started. */
	setCommitting: (committing: boolean) => void;
};

/**
 * Completes one active OAuth attempt and sends exactly one settings write.
 * If profile completion fails, the original exchanged credentials are saved
 * before the completion error is rethrown, preserving the existing fallback.
 */
export async function completeAndPersistOAuthAuth<Auth>({
	isCurrentAttempt,
	auth,
	completeAuth,
	persistAuth,
	setCommitting,
}: CompleteAndPersistOAuthAuthOptions<Auth>): Promise<boolean> {
	if (!isCurrentAttempt()) return false;

	let authToPersist = auth;
	let completionFailed = false;
	let completionError: unknown;

	if (completeAuth) {
		try {
			authToPersist = await completeAuth(auth);
		} catch (error) {
			if (!isCurrentAttempt()) return false;
			completionFailed = true;
			completionError = error;
		}
	}

	if (!isCurrentAttempt()) return false;

	setCommitting(true);
	try {
		await persistAuth(authToPersist);
	} finally {
		setCommitting(false);
	}

	if (completionFailed) throw completionError;
	return true;
}
