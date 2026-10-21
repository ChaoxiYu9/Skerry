export interface OAuthRefreshCredentials {
	access_token: string;
	refresh_token?: string | null;
}

interface OAuthRefreshFlight<Result> {
	promise: Promise<Result>;
}

interface OAuthAuthRefreshOperations<Auth extends OAuthRefreshCredentials> {
	requestRefresh: (auth: Auth, refreshToken: string) => Promise<Auth | null>;
	isCredentialError: (error: unknown) => boolean;
	clearAuthIfCurrent: (auth: Auth) => Promise<boolean>;
	readCurrentAuth: () => Promise<Auth | null>;
	publishRefreshedAuth: (auth: Auth) => Promise<void>;
	notifyReauthenticationRequired: () => void;
}

export async function refreshOAuthAuth<Auth extends OAuthRefreshCredentials>(
	auth: Auth,
	operations: OAuthAuthRefreshOperations<Auth>,
): Promise<Auth | null> {
	const refreshToken = auth.refresh_token;
	if (!refreshToken) return auth;

	try {
		const refreshedAuth = await operations.requestRefresh(auth, refreshToken);
		if (!refreshedAuth) return operations.readCurrentAuth();

		await operations.publishRefreshedAuth(refreshedAuth);
		return refreshedAuth;
	} catch (error) {
		if (!operations.isCredentialError(error)) throw error;

		if (await operations.clearAuthIfCurrent(auth)) {
			operations.notifyReauthenticationRequired();
			return null;
		}

		return operations.readCurrentAuth();
	}
}

export function createOAuthRefreshFlights<
	Credentials extends OAuthRefreshCredentials,
	Result,
>(refresh: (credentials: Credentials) => Promise<Result>) {
	const flightsByAccessToken = new Map<
		string,
		Map<string, OAuthRefreshFlight<Result>>
	>();

	return (credentials: Credentials): Promise<Result> => {
		const { access_token: accessToken, refresh_token: refreshToken } =
			credentials;
		if (!refreshToken) return refresh(credentials);

		const activeFlights = flightsByAccessToken.get(accessToken);
		const existingFlight = activeFlights?.get(refreshToken);
		if (existingFlight) return existingFlight.promise;

		const flightsForAccessToken = activeFlights ?? new Map();
		if (!activeFlights)
			flightsByAccessToken.set(accessToken, flightsForAccessToken);

		const flight: OAuthRefreshFlight<Result> = {
			promise: Promise.resolve().then(() => refresh(credentials)),
		};
		flight.promise = flight.promise.finally(() => {
			if (flightsForAccessToken.get(refreshToken) !== flight) return;

			flightsForAccessToken.delete(refreshToken);
			if (
				flightsForAccessToken.size === 0 &&
				flightsByAccessToken.get(accessToken) === flightsForAccessToken
			) {
				flightsByAccessToken.delete(accessToken);
			}
		});
		flightsForAccessToken.set(refreshToken, flight);

		return flight.promise;
	};
}
