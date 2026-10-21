import type { SourceType } from "@/types";

const DLSITE_ID_REGEX = /\b(?:RJ|RE|VJ)\d{4,}\b/i;

export function getNumericSourceId(value: string | null | undefined): string {
	return (value ?? "").replace(/^v/i, "").replace(/\D/g, "");
}

export function formatVndbId(value: string | null | undefined): string {
	const numericId = getNumericSourceId(value);
	return numericId ? `v${numericId}` : "";
}

export function formatYmgalId(value: string | null | undefined): string {
	const numericId = (value ?? "").replace(/^ga/i, "").replace(/\D/g, "");
	return numericId ? `ga${numericId}` : "";
}

export function formatDlsiteId(value: string | null | undefined): string {
	const match = (value ?? "").match(DLSITE_ID_REGEX);
	return match?.[0]?.toUpperCase() ?? "";
}

export function normalizeEditableSourceId(
	source: SourceType,
	value: string | null | undefined,
): string {
	switch (source) {
		case "vndb":
			return formatVndbId(value);
		case "ymgal":
			return formatYmgalId(value);
		case "dlsite":
			return formatDlsiteId(value);
		default:
			return getNumericSourceId(value);
	}
}

export function getSourceIdInputValue(
	source: SourceType,
	value: string | null | undefined,
): string {
	switch (source) {
		case "vndb":
			return getNumericSourceId(value);
		case "ymgal":
			return (value ?? "").replace(/^ga/i, "").replace(/\D/g, "");
		case "dlsite":
			return formatDlsiteId(value);
		default:
			return getNumericSourceId(value);
	}
}

export function normalizeSourceIds(
	sourceIds: Partial<Record<SourceType, string>> | undefined,
): Partial<Record<SourceType, string>> {
	return {
		...sourceIds,
		bgm: normalizeEditableSourceId("bgm", sourceIds?.bgm),
		vndb: normalizeEditableSourceId("vndb", sourceIds?.vndb),
	};
}
