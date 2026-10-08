import { isTauri } from "@tauri-apps/api/core";
import { useCallback } from "react";
import { useStore } from "@/store/appStore";
import { buildTauriProtocolUrl } from "@/utils/tauriProtocol";

function getProxyCacheKey(proxyUrl: string): string {
	let hash = 2166136261;
	for (let index = 0; index < proxyUrl.length; index += 1) {
		hash ^= proxyUrl.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}

function buildProxyImageUrl(imageUrl: string, proxyUrl: string): string {
	const params = new URLSearchParams({
		url: imageUrl,
		proxy: getProxyCacheKey(proxyUrl),
	});
	return buildTauriProtocolUrl("reina-image", "/", params);
}

export function useProxyImageUrlResolver() {
	const proxyUrl = useStore((state) => state.proxyConfig.url);

	return useCallback(
		(imageUrl: string | null | undefined): string | undefined => {
			if (!imageUrl || !proxyUrl.trim() || !isTauri()) {
				return imageUrl ?? undefined;
			}

			try {
				const parsed = new URL(imageUrl);
				if (
					!["http:", "https:"].includes(parsed.protocol) ||
					parsed.hostname === "localhost" ||
					parsed.hostname.endsWith(".localhost")
				) {
					return imageUrl;
				}
			} catch {
				return imageUrl;
			}

			return buildProxyImageUrl(imageUrl, proxyUrl);
		},
		[proxyUrl],
	);
}
