import {
	Button,
	Checkbox,
	Dialog,
	DialogActions,
	DialogContent,
	DialogTitle,
	FormControlLabel,
	Typography,
} from "@mui/material";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { destroyCurrentWindow, getRunningGameCount } from "@/services/appExit";
import {
	resolveWindowCloseIntent,
	type WindowCloseDecision,
} from "@/services/windowCloseFlow";
import { useStore } from "@/store/appStore";

const WindowsHandler: React.FC = () => {
	const { skipCloseRemind, setDefaultCloseAction, setSkipCloseRemind } =
		useStore(
			useShallow((state) => ({
				skipCloseRemind: state.skipCloseRemind,
				setDefaultCloseAction: state.setDefaultCloseAction,
				setSkipCloseRemind: state.setSkipCloseRemind,
			})),
		);
	const { t } = useTranslation();
	const [closeDialogOpen, setCloseDialogOpen] = useState(false);
	const [runningExitOpen, setRunningExitOpen] = useState(false);
	const applyCloseDecision = useCallback(
		async (decision: WindowCloseDecision) => {
			if (
				"rememberDefaultAction" in decision &&
				decision.rememberDefaultAction
			) {
				setDefaultCloseAction(decision.rememberDefaultAction);
			}

			setCloseDialogOpen(decision.kind === "show-choice");
			setRunningExitOpen(decision.kind === "confirm-running-exit");

			switch (decision.kind) {
				case "show-choice":
				case "confirm-running-exit":
					return;
				case "hide-window":
					await getCurrentWindow().hide();
					return;
				case "destroy-window":
					await destroyCurrentWindow();
					return;
			}
		},
		[setDefaultCloseAction],
	);

	useEffect(() => {
		const window = getCurrentWindow();
		let unlisten = () => {};

		window
			.onCloseRequested(async (event) => {
				event.preventDefault();
				const state = useStore.getState();
				await applyCloseDecision(
					resolveWindowCloseIntent({
						type: "requested",
						preferences: {
							skipCloseRemind: state.skipCloseRemind,
							defaultCloseAction: state.defaultCloseAction,
						},
						runningGameCount: getRunningGameCount(),
					}),
				);
			})
			.then((dispose) => {
				unlisten = dispose;
			});

		return () => unlisten();
	}, [applyCloseDecision]);

	const handleCancel = () => {
		setSkipCloseRemind(false);
		setCloseDialogOpen(false);
	};

	const handleHide = async () => {
		await applyCloseDecision(
			resolveWindowCloseIntent({
				type: "selected",
				action: "hide",
				runningGameCount: getRunningGameCount(),
			}),
		);
	};

	const handleClose = async () => {
		await applyCloseDecision(
			resolveWindowCloseIntent({
				type: "selected",
				action: "close",
				runningGameCount: getRunningGameCount(),
			}),
		);
	};

	const handleConfirmRunningExit = async () => {
		await applyCloseDecision(
			resolveWindowCloseIntent({ type: "running-exit-confirmed" }),
		);
	};

	return (
		<>
			<Dialog open={closeDialogOpen} onClose={handleCancel}>
				<DialogTitle>
					{t("components.Window.closeDialog.title", "关闭应用")}
				</DialogTitle>
				<DialogContent>
					<Typography variant="body1" sx={{ mb: 2 }}>
						{t(
							"components.Window.closeDialog.message",
							"请选择操作：直接退出 或 最小化到托盘？",
						)}
					</Typography>
					<FormControlLabel
						control={
							<Checkbox
								checked={skipCloseRemind}
								onChange={(event) => setSkipCloseRemind(event.target.checked)}
							/>
						}
						label={t("components.Window.closeDialog.dontRemind", "不再提醒")}
					/>
				</DialogContent>
				<DialogActions>
					<Button onClick={handleHide}>
						{t("components.Window.closeDialog.minimizeToTray", "最小化到托盘")}
					</Button>
					<Button onClick={handleClose}>
						{t("components.Window.closeDialog.exitApp", "退出应用")}
					</Button>
				</DialogActions>
			</Dialog>

			<Dialog open={runningExitOpen} onClose={() => setRunningExitOpen(false)}>
				<DialogTitle>
					{t("components.Window.runningExitDialog.title", "退出提醒")}
				</DialogTitle>
				<DialogContent>
					<Typography variant="body1">
						{t(
							"components.Window.runningExitDialog.message",
							"当前仍有 {{count}} 个游戏正在运行。退出应用后不会关闭这些游戏，但会丢失游戏时长记录。确定要退出应用吗？",
							{ count: getRunningGameCount() },
						)}
					</Typography>
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setRunningExitOpen(false)}>
						{t("common.cancel", "取消")}
					</Button>
					<Button onClick={handleConfirmRunningExit} color="warning">
						{t("components.Window.runningExitDialog.exitApp", "仍然退出")}
					</Button>
				</DialogActions>
			</Dialog>
		</>
	);
};

export default WindowsHandler;
