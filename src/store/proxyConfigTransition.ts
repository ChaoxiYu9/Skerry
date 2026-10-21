import type { ProxyConfig } from "@/services/invoke";

let proxyTransitionQueue: Promise<void> = Promise.resolve();

export function synchronizeProxyConfig(
	config: ProxyConfig,
	updateBackend: (config: ProxyConfig) => Promise<void>,
	commitFrontendState: (config: ProxyConfig) => void,
	onBackendUpdateFailure: () => void,
): Promise<void> {
	const transition = proxyTransitionQueue.then(async () => {
		try {
			await updateBackend(config);
		} catch (error) {
			onBackendUpdateFailure();
			throw error;
		}

		commitFrontendState(config);
	});

	proxyTransitionQueue = transition.then(
		() => undefined,
		() => undefined,
	);

	return transition;
}
