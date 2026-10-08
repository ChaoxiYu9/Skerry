const FILE_SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** 将字节数格式化为人类可读的二进制单位。 */
export function formatFileSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";

	const base = 1024;
	const unitIndex = Math.max(
		0,
		Math.min(
			Math.floor(Math.log(bytes) / Math.log(base)),
			FILE_SIZE_UNITS.length - 1,
		),
	);
	const value = Number.parseFloat((bytes / base ** unitIndex).toFixed(2));

	return `${value} ${FILE_SIZE_UNITS[unitIndex]}`;
}
