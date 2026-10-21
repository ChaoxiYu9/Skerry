import {
	FormControlLabel,
	Radio,
	RadioGroup,
	Switch,
	Typography,
} from "@mui/material";
import Box from "@mui/material/Box";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "@/store/appStore";
import { parseDefaultCloseAction } from "@/types/settingsValues";
import { SettingsGroup, SettingsItem } from "../SettingsLayout";

export const CloseBtnSettings = () => {
	const { t } = useTranslation();
	const {
		skipCloseRemind,
		defaultCloseAction,
		setSkipCloseRemind,
		setDefaultCloseAction,
	} = useStore(
		useShallow((s) => ({
			skipCloseRemind: s.skipCloseRemind,
			defaultCloseAction: s.defaultCloseAction,
			setSkipCloseRemind: s.setSkipCloseRemind,
			setDefaultCloseAction: s.setDefaultCloseAction,
		})),
	);
	return (
		<SettingsGroup
			title={t("pages.Settings.closeSettings", "关闭设置")}
			description={t(
				"pages.Settings.closeSettingsDescription",
				"点击关闭按钮是否显示关闭确认弹窗，并选择跳过确认弹窗后的默认行为。",
			)}
		>
			<SettingsItem
				title={t("pages.Settings.skipCloseRemind", "不再提醒")}
				description={t(
					"pages.Settings.skipCloseRemindDescription",
					"开启后不再显示关闭确认弹窗，直接执行下方选择的默认行为。",
				)}
			>
				<Switch
					checked={skipCloseRemind}
					onChange={(e) => setSkipCloseRemind(e.target.checked)}
					color="primary"
				/>
			</SettingsItem>
			<Box>
				<RadioGroup
					value={defaultCloseAction}
					onChange={(_event, selectedAction) => {
						const nextAction = parseDefaultCloseAction(selectedAction);
						if (nextAction) {
							setDefaultCloseAction(nextAction);
						}
					}}
				>
					<FormControlLabel
						value="hide"
						control={<Radio color="primary" />}
						disabled={!skipCloseRemind}
						sx={{ alignItems: "flex-start" }}
						className={
							!skipCloseRemind
								? "mb-2 opacity-50 transition-opacity duration-200"
								: "mb-2"
						}
						label={
							<Box>
								<Typography variant="body2">
									{t("pages.Settings.closeToTray", "最小化到托盘")}
								</Typography>
								<Typography variant="caption" color="text.secondary">
									{t(
										"pages.Settings.closeToTrayDescription",
										"关闭窗口后应用继续在系统托盘中运行。",
									)}
								</Typography>
							</Box>
						}
					/>
					<FormControlLabel
						value="close"
						control={<Radio color="primary" />}
						disabled={!skipCloseRemind}
						sx={{ alignItems: "flex-start" }}
						className={
							!skipCloseRemind
								? "mb-1 opacity-50 transition-opacity duration-200"
								: "mb-1"
						}
						label={
							<Box>
								<Typography variant="body2">
									{t("pages.Settings.closeApp", "直接退出应用")}
								</Typography>
								<Typography variant="caption" color="text.secondary">
									{t(
										"pages.Settings.closeAppDescription",
										"关闭窗口后结束应用进程。",
									)}
								</Typography>
							</Box>
						}
					/>
				</RadioGroup>
			</Box>
		</SettingsGroup>
	);
};
