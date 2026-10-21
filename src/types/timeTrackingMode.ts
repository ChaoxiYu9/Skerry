export type TimeTrackingMode = "playtime" | "elapsed";

export const DEFAULT_TIME_TRACKING_MODE: TimeTrackingMode = "playtime";

export function parseTimeTrackingMode(
	value: unknown,
): TimeTrackingMode | undefined {
	if (value === "playtime" || value === "elapsed") {
		return value;
	}

	return undefined;
}

export function normalizeTimeTrackingMode(value: unknown): TimeTrackingMode {
	return parseTimeTrackingMode(value) ?? DEFAULT_TIME_TRACKING_MODE;
}
