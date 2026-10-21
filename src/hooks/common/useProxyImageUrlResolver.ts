import { isTauri } from "@tauri-apps/api/core";
import { useCallback } from "react";
import { useStore } from "@/store/appStore";
import { buildProxyImageUrl } from "@/utils/image";

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
