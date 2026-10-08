/**
 * @file LaunchModal 组件
 * @description 游戏启动弹窗组件，负责判断游戏是否可启动、是否正在运行，并提供启动按钮，支持国际化。
 * @module src/components/LaunchModal/index
 * @author Skerry contributors (based on ReinaManager)
 * @copyright AGPL-3.0
 *
 * 主要导出：
 * - LaunchModal：游戏启动弹窗组件
 */

import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import StopIcon from "@mui/icons-material/Stop";
import SyncIcon from "@mui/icons-material/Sync";
import { Button } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { SelectedGameGuard } from "@/components/SelectedGameGuard";
import { useGameLaunchFlow } from "@/hooks/features/games/useGameLaunchFlow";
import { snackbar } from "@/providers/snackBar";
import { useGamePlayStore } from "@/store/gamePlayStore";
import type { GameData } from "@/types";
import { getUserErrorMessage } from "@/utils/errors";
import { RunningGameTimer } from "@/pages/Home/RunningGameTimer";

/**
 * LaunchModal 组件
 * 判断游戏是否可启动、是否正在运行，并渲染启动按钮。
 * 仅本地游戏且未运行时可启动。
 * 运行时显示实时游戏时长。
 * 支持两种计时模式：
 * - playtime: 真实游戏时间（仅活跃时间，通过后端事件更新）
 * - elapsed: 游戏启动时间（从启动到现在的总时间，前端计时器计算）
 *
 * @returns {JSX.Element} 启动按钮或运行中提示
 */
export const LaunchModal = () => {
	const { t } = useTranslation();
	const disabledFallback = (
		<Button
			className="skerry-launch-action-button skerry-launch-start"
			startIcon={<PlayArrowIcon />}
			disabled
		>
			{t("components.LaunchModal.launchGame", "启动游戏")}
		</Button>
	);

	return (
		<SelectedGameGuard
			fallback={disabledFallback}
			loadingFallback={disabledFallback}
			notFoundFallback={disabledFallback}
		>
			{(selectedGame) => <LaunchModalContent selectedGame={selectedGame} />}
		</SelectedGameGuard>
	);
};

interface LaunchModalContentProps {
	selectedGame: GameData;
}

function LaunchModalContent({ selectedGame }: LaunchModalContentProps) {
	const { t } = useTranslation();
	const selectedGameId = selectedGame.id;
	const { launchGame, syncLocalPath } = useGameLaunchFlow();
	const { stopGame, isThisGameRunning, realTimeState } = useGamePlayStore(
		useShallow((s) => ({
			stopGame: s.stopGame,
			isThisGameRunning: s.runningGameIds.has(selectedGameId),
			realTimeState: s.gameRealTimeStates[selectedGameId] ?? null,
		})),
	);
	const hasLocalPath = Boolean(selectedGame.localpath);
	const hideSyncLocalFallback = false;
	const [stopping, setStopping] = useState(false);

	const handleStartGame = () => {
		void launchGame(selectedGame);
	};

	const handleSyncLocalPath = () => {
		void syncLocalPath(selectedGame);
	};

	const handleStopGame = async () => {
		setStopping(true);
		try {
			const res = await stopGame(selectedGameId);
			if (!res.success) {
				snackbar.error(
					res.message ||
						t("components.LaunchModal.stopFailed", "游戏停止失败:"),
				);
			}
		} catch (error) {
			snackbar.error(
				`${t("components.LaunchModal.stopFailed", "游戏停止失败:")}: ${getUserErrorMessage(error, t)}`,
			);
		} finally {
			setStopping(false);
		}
	};

	const content = (() => {
		if (stopping) {
			return (
				<Button
					className="skerry-launch-action-button skerry-launch-running"
					startIcon={<StopIcon />}
					disabled
				>
					{t("components.LaunchModal.stoppingGame", "停止游戏中...")}
				</Button>
			);
		}

		if (isThisGameRunning && realTimeState) {
			return (
				<Button
					startIcon={<StopIcon />}
					onClick={handleStopGame}
					className="skerry-launch-action-button skerry-launch-running rounded-2xl"
					color="error"
					variant="outlined"
				>
					<span className="skerry-launch-timer-value">
						<RunningGameTimer {...realTimeState} compact />
					</span>
				</Button>
			);
		}

		switch (selectedGame.launch_type ?? "local") {
			case "steam":
				return hasLocalPath ? (
					<Button
						className="skerry-launch-action-button skerry-launch-start"
						startIcon={<PlayArrowIcon />}
						onClick={handleStartGame}
						variant="contained"
					>
						{t("components.LaunchModal.launchWithSteam", "通过 Steam 启动")}
					</Button>
				) : (
					<Button
						className="skerry-launch-action-button skerry-launch-start"
						startIcon={<PlayArrowIcon />}
						disabled
					>
						{t(
							"components.LaunchModal.steamMonitorPathMissing",
							"Steam 游戏监控目录缺失，请重新关联",
						)}
					</Button>
				);
			case "local":
				return hasLocalPath ? (
					<Button
						className="skerry-launch-action-button skerry-launch-start"
						startIcon={<PlayArrowIcon />}
						onClick={handleStartGame}
						variant="contained"
					>
						{t("components.LaunchModal.launchGame", "启动游戏")}
					</Button>
				) : hideSyncLocalFallback ? (
					<Button
						className="skerry-launch-action-button skerry-launch-start"
						startIcon={<PlayArrowIcon />}
						disabled
					>
						{t("components.LaunchModal.launchGame", "鍚姩娓告垙")}
					</Button>
				) : (
					<Button
						className="skerry-launch-action-button skerry-launch-sync"
						startIcon={<SyncIcon />}
						onClick={handleSyncLocalPath}
						variant="contained"
					>
						{t("components.LaunchModal.syncLocalPath", "同步本地")}
					</Button>
				);
		}
	})();

	return content;
}
