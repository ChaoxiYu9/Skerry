import { PlayStatus } from "../../types/collection.ts";

interface FolderStatusRule {
	status: PlayStatus;
	keywords: readonly string[];
}

// Rule order preserves the existing result when a custom title matches multiple statuses.
const FOLDER_STATUS_RULES: readonly FolderStatusRule[] = [
	{ status: PlayStatus.PLAYING, keywords: ["在玩", "playing", "doing"] },
	{
		status: PlayStatus.PLAYED,
		keywords: ["玩过", "完成", "通关", "played", "done"],
	},
	{
		status: PlayStatus.ON_HOLD,
		keywords: ["搁置", "暂停", "on_hold", "stalled"],
	},
	{ status: PlayStatus.DROPPED, keywords: ["抛弃", "弃坑", "dropped"] },
];

/** Infer the library status from a user-created KunGal collection title. */
export function mapFolderTitleToPlayStatus(title?: string): PlayStatus {
	const normalizedTitle = title?.toLowerCase();
	if (!normalizedTitle) return PlayStatus.WISH;

	for (const rule of FOLDER_STATUS_RULES) {
		if (rule.keywords.some((keyword) => normalizedTitle.includes(keyword))) {
			return rule.status;
		}
	}

	return PlayStatus.WISH;
}
