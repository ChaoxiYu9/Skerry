import { FormControlLabel, Radio, RadioGroup, Typography } from "@mui/material";
import Box from "@mui/material/Box";
import { useTranslation } from "react-i18next";
import { useStore } from "@/store/appStore";
import { parseTimeTrackingMode } from "@/types/timeTrackingMode";
import { SettingsGroup } from "../SettingsLayout";

export const TimeTrackingModeSettings = () => {
	const { t } = useTranslation();
	const timeTrackingMode = useStore((s) => s.timeTrackingMode);
	const setTimeTrackingMode = useStore((s) => s.setTimeTrackingMode);

	return (
		<SettingsGroup
			title={t("pages.Settings.timeTrackingMode.title", "游戏计时模式")}
			description={t(
				"pages.Settings.timeTrackingMode.description",
				"选择游戏时间的计算方式，更改仅对之后启动的游戏生效。",
			)}
		>
			<Box>
				<RadioGroup
					value={timeTrackingMode}
					onChange={(event) => {
						const mode = parseTimeTrackingMode(event.target.value);
						if (mode !== undefined) setTimeTrackingMode(mode);
					}}
				>
					<FormControlLabel
						value="playtime"
						control={<Radio color="primary" />}
						className="mb-2"
						label={
							<Box>
								<Typography variant="body2">
									{t(
										"pages.Settings.timeTrackingMode.playtime",
										"真实游戏时间（默认）",
									)}
								</Typography>
								<Typography variant="caption" color="text.secondary">
									{t(
										"pages.Settings.timeTrackingMode.playtimeDesc",
										"仅计算游戏窗口在前台时的时间，切换到其他窗口时暂停计时",
									)}
								</Typography>
							</Box>
						}
					/>
					<FormControlLabel
						value="elapsed"
						control={<Radio color="primary" />}
						className="mb-1"
						label={
							<Box>
								<Typography variant="body2">
									{t("pages.Settings.timeTrackingMode.elapsed", "游戏启动时间")}
								</Typography>
								<Typography variant="caption" color="text.secondary">
									{t(
										"pages.Settings.timeTrackingMode.elapsedDesc",
										"计算从游戏启动到结束的总时间，不区分前台后台",
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
