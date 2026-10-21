import type { CustomData, GameData } from "@/types";
export type CustomDataApplicationMode = "base" | "override";

export function applyCustomData(
	target: GameData,
	customData: CustomData,
	mode: CustomDataApplicationMode,
): void {
	if (mode === "base") {
		if (customData.name != null) target.name = customData.name;
		if (customData.name_cn != null) target.name_cn = customData.name_cn;
		if (customData.summary != null) target.summary = customData.summary;
		if (customData.developer != null) target.developer = customData.developer;
		if (customData.nsfw != null) target.nsfw = customData.nsfw;
		target.aliases = Array.from(new Set(customData.aliases ?? []));
		target.tags = customData.tags_curated
			? (customData.tags ?? [])
			: Array.from(new Set(customData.tags ?? []));
		return;
	}

	if (customData.name != null) {
		target.name = customData.name;
	}
	if (customData.name_cn != null) {
		target.name_cn = customData.name_cn;
	}
	if (customData.summary) {
		target.summary = customData.summary;
	}
	if (customData.developer) {
		target.developer = customData.developer;
	}
	if (customData.nsfw != null) {
		target.nsfw = customData.nsfw;
	}

	if (customData.aliases) {
		target.aliases = Array.from(
			new Set([...(target.aliases || []), ...customData.aliases]),
		);
	}
	if (customData.tags_curated) {
		target.tags = customData.tags ?? [];
	} else if (customData.tags) {
		target.tags = Array.from(
			new Set([...(target.tags || []), ...customData.tags]),
		);
	}
}
