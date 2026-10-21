export type StartupPage = "home" | "libraries" | "collection";
export type CardClickMode = "navigate" | "select";
export type DefaultCloseAction = "hide" | "close";

export const DEFAULT_STARTUP_PAGE: StartupPage = "home";
export const DEFAULT_CARD_CLICK_MODE: CardClickMode = "navigate";
export const DEFAULT_CLOSE_ACTION: DefaultCloseAction = "hide";

export function parseStartupPage(value: unknown): StartupPage | undefined {
	if (value === "home" || value === "libraries" || value === "collection") {
		return value;
	}

	return undefined;
}

export function parseCardClickMode(value: unknown): CardClickMode | undefined {
	if (value === "navigate" || value === "select") {
		return value;
	}

	return undefined;
}

export function parseDefaultCloseAction(
	value: unknown,
): DefaultCloseAction | undefined {
	if (value === "hide" || value === "close") {
		return value;
	}

	return undefined;
}

export function parseSpoilerLevelOption(value: unknown): number | undefined {
	if (typeof value !== "number" && typeof value !== "string") {
		return undefined;
	}
	if (typeof value === "string" && value.trim() === "") {
		return undefined;
	}

	const level = typeof value === "number" ? value : Number(value);
	if (!Number.isInteger(level) || level < 0 || level > 2) {
		return undefined;
	}

	return level;
}
