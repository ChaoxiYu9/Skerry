import type { LogLevel } from "@/types";

export const logLevelOptions: readonly { value: LogLevel; label: string }[] = [
	{ value: "error", label: "Error" },
	{ value: "warn", label: "Warn" },
	{ value: "info", label: "Info" },
	{ value: "debug", label: "Debug" },
];

export function parseSelectableLogLevel(value: string): LogLevel | undefined {
	return logLevelOptions.find((option) => option.value === value)?.value;
}
