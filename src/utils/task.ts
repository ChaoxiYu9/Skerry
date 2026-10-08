import type { TFunction } from "i18next";
import type { TaskStatus } from "@/services/invoke";

export function getTaskStateLabel(
	status: TaskStatus,
	stage: string | null | undefined,
	t: TFunction,
) {
	if (status === "running") {
		switch (stage) {
			case "downloading":
				return t("components.InstallRequest.stage.downloading", "正在下载");
			case "verifying":
				return t("components.InstallRequest.stage.verifying", "正在校验");
			case "extracting":
				return t("components.InstallRequest.stage.extracting", "正在解压");
			case "organizing":
				return t(
					"components.InstallRequest.stage.organizing",
					"正在整理游戏目录",
				);
			case "scanning":
				return t(
					"components.InstallRequest.stage.scanning",
					"正在识别启动程序",
				);
			case "matching_metadata":
				return t(
					"components.InstallRequest.stage.matching_metadata",
					"正在获取并匹配元数据",
				);
			case "importing_game":
				return t(
					"components.InstallRequest.stage.importing_game",
					"正在导入游戏",
				);
			default:
				return t("components.InstallRequest.status.running", "执行中");
		}
	}

	switch (status) {
		case "pending":
			return t("components.InstallRequest.status.pending", "等待执行");
		case "paused":
			return t("components.InstallRequest.status.paused", "已暂停");
		case "completed":
			return t("components.InstallRequest.status.completed", "已完成");
		case "failed":
			return t("components.InstallRequest.status.failed", "失败");
		case "cancelled":
			return t("components.InstallRequest.status.cancelled", "已取消");
	}
}
