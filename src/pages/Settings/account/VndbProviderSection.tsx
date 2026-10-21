import ClearIcon from "@mui/icons-material/Clear";
import {
	CircularProgress,
	IconButton,
	InputAdornment,
	Stack,
	TextField,
	Typography,
} from "@mui/material";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import { useColorScheme } from "@mui/material/styles";
import { open as openurl } from "@tauri-apps/plugin-shell";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import {
	useAllSettings,
	useUpdateSettings,
	useVndbCurrentUserProfile,
} from "@/hooks/queries/useSettings";
import { snackbar } from "@/providers/snackBar";
import { useStore } from "@/store/appStore";
import { AccountProviderCard } from "../AccountProviderCard";

/** VNDB 官方字标 */
const VndbWordmarkSVG = () => {
	const { mode } = useColorScheme();

	return (
		<Box
			component="img"
			src="/images/vndb-wordmark.svg"
			alt="VNDB"
			sx={{
				height: 18,
				width: "auto",
				objectFit: "contain",
				filter: mode === "dark" ? "brightness(0) invert(1)" : "none",
			}}
		/>
	);
};

export const VndbProviderSection = () => {
	const { t } = useTranslation();
	const { data: settings, isLoading: isSettingsLoading } = useAllSettings();
	const vndbToken = settings?.vndb_token ?? "";
	const { data: vndbProfile, isLoading: isVndbProfileLoading } =
		useVndbCurrentUserProfile();
	const updateSettingsMutation = useUpdateSettings();
	const [inputToken, setInputToken] = useState("");

	const { syncVndbCollection, setSyncVndbCollection } = useStore(
		useShallow((s) => ({
			syncVndbCollection: s.syncVndbCollection,
			setSyncVndbCollection: s.setSyncVndbCollection,
		})),
	);

	useEffect(() => {
		setInputToken(vndbToken);
	}, [vndbToken]);

	const handleOpen = () => {
		openurl("https://vndb.org/u/tokens");
	};

	const handleSaveToken = async () => {
		const nextToken = inputToken.trim();
		if (nextToken === vndbToken || updateSettingsMutation.isPending) return;

		try {
			await updateSettingsMutation.mutateAsync({
				vndbToken: nextToken,
			});
			setInputToken(nextToken);
			snackbar.success(
				t(
					"pages.Settings.vndbTokenSettings.saveSuccess",
					"VNDB Token 保存成功",
				),
			);
		} catch (error) {
			console.error(error);
			snackbar.error(
				t("pages.Settings.vndbTokenSettings.saveError", "VNDB Token 保存失败"),
			);
		}
	};

	const handleClearToken = async () => {
		setInputToken("");
		if (!vndbToken || updateSettingsMutation.isPending) return;

		try {
			await updateSettingsMutation.mutateAsync({ vndbToken: "" });
		} catch (error) {
			console.error(error);
			setInputToken(vndbToken);
			snackbar.error(
				t("pages.Settings.vndbTokenSettings.saveError", "VNDB Token 保存失败"),
			);
		}
	};

	const hasVndbToken = Boolean(vndbToken);
	const isConnected = Boolean(hasVndbToken && vndbProfile);

	useEffect(() => {
		if (!isSettingsLoading && !hasVndbToken && syncVndbCollection) {
			setSyncVndbCollection(false);
		}
	}, [
		hasVndbToken,
		isSettingsLoading,
		setSyncVndbCollection,
		syncVndbCollection,
	]);

	return (
		<AccountProviderCard
			wordmark={<VndbWordmarkSVG />}
			connected={isConnected}
			description={t(
				"pages.Settings.vndbTokenSettings.description",
				"使用 VNDB Token 登录以读取游玩状态和推送评价。",
			)}
			sync={{
				title: t("pages.Settings.collectionSync.vndbTitle", "VNDB 收藏同步"),
				description: t(
					"pages.Settings.collectionSync.vndbDescription",
					"添加游戏时自动读取 VNDB 收藏状态，修改时实时同步回 BGM。",
				),
				checked: hasVndbToken && syncVndbCollection,
				disabled: isSettingsLoading || !hasVndbToken,
				onChange: setSyncVndbCollection,
			}}
		>
			{/* 账号 Profile 及 Token 设置 */}
			<Box className="space-y-4">
				{vndbToken && (
					<Box>
						{isVndbProfileLoading ? (
							<Typography variant="caption" color="text.secondary">
								{t(
									"pages.Settings.vndbTokenSettings.loadingProfile",
									"正在获取当前 VNDB 账号信息...",
								)}
							</Typography>
						) : vndbProfile ? (
							<Box>
								<Typography variant="body2" className="font-semibold">
									{vndbProfile.username}
								</Typography>
								<Typography variant="caption" color="text.secondary">
									{t(
										"pages.Settings.vndbTokenSettings.userId",
										"用户 ID: {{id}}",
										{ id: vndbProfile.id },
									)}
								</Typography>
								<Typography
									variant="caption"
									color="text.secondary"
									className="block"
								>
									{t(
										"pages.Settings.vndbTokenSettings.permissions",
										"权限: {{permissions}}",
										{
											permissions: vndbProfile.permissions.join(", ") || "none",
										},
									)}
								</Typography>
							</Box>
						) : (
							<Typography variant="caption" color="error">
								{t(
									"pages.Settings.vndbTokenSettings.profileUnavailable",
									"当前 VNDB Token 无法获取用户信息，请检查令牌或权限是否有效。",
								)}
							</Typography>
						)}
					</Box>
				)}

				<Stack spacing={1.5}>
					<TextField
						autoComplete="off"
						placeholder={t(
							"pages.Settings.vndbTokenPlaceholder",
							"请填写你的 VNDB Token",
						)}
						value={inputToken}
						onChange={(e) => setInputToken(e.target.value)}
						onBlur={handleSaveToken}
						onKeyDown={(event) => {
							if (event.key === "Enter" && !event.nativeEvent.isComposing) {
								event.preventDefault();
								(event.target as HTMLInputElement).blur();
							}
							if (event.key === "Escape") {
								event.preventDefault();
								setInputToken(vndbToken);
							}
						}}
						variant="outlined"
						size="small"
						fullWidth
						disabled={updateSettingsMutation.isPending}
						slotProps={{
							htmlInput: {
								style: {
									WebkitTextSecurity: "disc",
									textSecurity: "disc",
								},
							},
							input: {
								endAdornment: updateSettingsMutation.isPending ? (
									<InputAdornment position="end">
										<CircularProgress size={18} />
									</InputAdornment>
								) : inputToken ? (
									<InputAdornment position="end">
										<IconButton
											onClick={handleClearToken}
											edge="end"
											size="small"
										>
											<ClearIcon />
										</IconButton>
									</InputAdornment>
								) : null,
							},
						}}
					/>
					<Box>
						<Button
							variant="outlined"
							color="primary"
							onClick={handleOpen}
							size="small"
						>
							{t("pages.Settings.getToken", "获取令牌")}
						</Button>
					</Box>
				</Stack>
			</Box>
		</AccountProviderCard>
	);
};

export const VndbTokenSettings = VndbProviderSection;
