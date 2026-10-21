import type { NetworkRequestContext } from "@/metadata/api/http";
import { GameMetadataSession } from "@/metadata/data/gameMetadataService";
import type { MetadataRequestContext } from "@/metadata/sourceAdapter";
import { useStore } from "@/store/appStore";
import type { SourceType } from "@/types";

export function getNetworkRequestContext(
	signal?: AbortSignal,
): NetworkRequestContext {
	const proxyUrl = useStore.getState().proxyConfig.url.trim();
	return {
		proxyUrl: proxyUrl || undefined,
		signal,
	};
}

export function getMetadataRequestContext(
	options: {
		bgmToken?: string;
		hikarinagiToken?: string;
		signal?: AbortSignal;
		spoilerLevel?: number;
	} = {},
): MetadataRequestContext {
	const state = useStore.getState();
	const proxyUrl = state.proxyConfig.url.trim();
	const linkedSourceEnrichmentOrigins: SourceType[] = [];
	if (state.enhanceKunLinkedSources) linkedSourceEnrichmentOrigins.push("kun");
	if (state.enhanceHikarinagiLinkedSources) {
		linkedSourceEnrichmentOrigins.push("hikarinagi");
	}
	return {
		proxyUrl: proxyUrl || undefined,
		signal: options.signal,
		spoilerLevel: options.spoilerLevel ?? state.spoilerLevel,
		bgmToken: options.bgmToken,
		hikarinagiToken: options.hikarinagiToken,
		mixedEnabledSources: state.mixedEnabledSources,
		linkedSourceEnrichmentOrigins,
	};
}

export function createMetadataSession(
	options: {
		bgmToken?: string;
		hikarinagiToken?: string;
		signal?: AbortSignal;
	} = {},
): GameMetadataSession {
	return new GameMetadataSession(getMetadataRequestContext(options));
}
