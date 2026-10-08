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
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { destroyCurrentWindow, getRunningGameCount } from "@/services/appExit";
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

	useEffect(() => {
		const window = getCurrentWindow();
		let unlisten = () => {};

		window
			.onCloseRequested(async (event) => {
				event.preventDefault();
				const state = useStore.getState();

				if (!state.skipCloseRemind) {
					setCloseDialogOpen(true);
					return;
				}

				if (state.defaultCloseAction === "hide") {
					await window.hide();
					return;
				}

				if (getRunningGameCount() > 0) {
					setRunningExitOpen(true);
					return;
				}

				await destroyCurrentWindow();
			})
			.then((dispose) => {
				unlisten = dispose;
			});

		return () => unlisten();
	}, []);

	const handleCancel = () => {
		setSkipCloseRemind(false);
		setCloseDialogOpen(false);
	};

	const handleHide = async () => {
		setDefaultCloseAction("hide");
		setCloseDialogOpen(false);
		await getCurrentWindow().hide();
	};

	const handleClose = async () => {
		setDefaultCloseAction("close");
		setCloseDialogOpen(false);

		if (getRunningGameCount() > 0) {
			setRunningExitOpen(true);
			return;
		}

		await destroyCurrentWindow();
	};

	const handleConfirmRunningExit = async () => {
		setRunningExitOpen(false);
		await destroyCurrentWindow();
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
