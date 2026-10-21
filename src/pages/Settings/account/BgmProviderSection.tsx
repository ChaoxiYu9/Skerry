import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import CancelIcon from "@mui/icons-material/Cancel";
import ClearIcon from "@mui/icons-material/Clear";
import LoginIcon from "@mui/icons-material/Login";
import VpnKeyIcon from "@mui/icons-material/VpnKey";
import {
	Accordion,
	AccordionDetails,
	AccordionSummary,
	Avatar,
	Chip,
	CircularProgress,
	IconButton,
	InputAdornment,
	Stack,
	Typography,
} from "@mui/material";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { ButtonLoadingIndicator } from "@/components/ui/ButtonLoadingIndicator";
import { useProxyImageUrlResolver } from "@/hooks/common/useProxyImageUrlResolver";
import { getBgmAvatarUrl } from "@/metadata/api/bgm";
import { useStore } from "@/store/appStore";
import type { BgmAuth } from "@/types";
import { AccountProviderCard } from "../AccountProviderCard";
import { useBgmAuthController } from "../useBgmAuthController";

/** Bangumi 官方字标 */
const BgmWordmarkSVG = () => (
	<Box
		component="img"
		src="/images/bangumi-wordmark.png"
		alt="Bangumi"
		sx={{ height: 24, width: "auto", objectFit: "contain" }}
	/>
);

// ==================== BGM 账号与同步板块 ====================

type BgmAccountActionsProps = {
	showCompleteButton: boolean;
	isCompletingAuth: boolean;
	onCompleteAuth: () => void;
	onLogout: () => void;
};

const BgmAccountActions = ({
	showCompleteButton,
	isCompletingAuth,
	onCompleteAuth,
	onLogout,
}: BgmAccountActionsProps) => {
	const { t } = useTranslation();

	return (
		<Stack direction="row" spacing={1} alignItems="center">
			{showCompleteButton && (
				<Button
					variant="outlined"
					size="small"
					onClick={onCompleteAuth}
					disabled={isCompletingAuth}
				>
					{isCompletingAuth
						? t(
								"pages.Settings.bgmTokenSettings.queryingTokenStatus",
								"正在查询 Token 状态...",
							)
						: t(
								"pages.Settings.bgmTokenSettings.queryTokenStatus",
								"查询 Token 状态",
							)}
				</Button>
			)}
			<Button variant="outlined" color="error" size="small" onClick={onLogout}>
				{t("pages.Settings.bgmTokenSettings.logout", "退出登录")}
			</Button>
		</Stack>
	);
};

type BgmAccountSummaryProps = {
	bgmAuth?: BgmAuth | null;
	isCompletingAuth: boolean;
	onCompleteAuth: () => void;
	onLogout: () => void;
};

const BgmAccountSummary = ({
	bgmAuth,
	isCompletingAuth,
	onCompleteAuth,
	onLogout,
}: BgmAccountSummaryProps) => {
	const { t } = useTranslation();
	const resolveImageUrl = useProxyImageUrlResolver();
	if (!bgmAuth?.access_token) return null;

	const isOAuth = Boolean(bgmAuth.refresh_token);
	const expiresAt = bgmAuth.expires_at ?? null;
	const expiresDate = expiresAt
		? new Date(expiresAt * 1000).toLocaleString()
		: null;
	const isExpired = expiresAt ? Date.now() / 1000 >= expiresAt : false;
	const username = bgmAuth.username ?? "";
	const displayName = bgmAuth.nickname || username;
	const shouldShowCompleteButton =
		!isOAuth && (bgmAuth.expires_at == null || !bgmAuth.username);

	const actions = (
		<BgmAccountActions
			showCompleteButton={shouldShowCompleteButton}
			isCompletingAuth={isCompletingAuth}
			onCompleteAuth={onCompleteAuth}
			onLogout={onLogout}
		/>
	);

	return (
		<Box className="mb-2">
			{username ? (
				<Stack direction="row" spacing={2} alignItems="flex-start">
					<Avatar
						src={resolveImageUrl(getBgmAvatarUrl(username))}
						alt={displayName}
						sx={{ width: 44, height: 44 }}
					/>
					<Box className="min-w-0 flex-1">
						<Stack
							direction="row"
							spacing={1}
							alignItems="center"
							flexWrap="wrap"
						>
							<Typography variant="body1" className="font-semibold">
								{displayName}
							</Typography>
							<Typography variant="caption" color="text.secondary">
								@{username}
							</Typography>
							<Chip
								label={isOAuth ? "OAuth" : "Access Token"}
								size="small"
								variant="outlined"
								className={`oauth-status-badge ${isOAuth ? "oauth-status-badge--bgm" : ""}`}
							/>
						</Stack>
						<Typography
							variant="caption"
							color={isExpired ? "error.main" : "text.secondary"}
							className="block mt-1"
						>
							{expiresDate
								? t(
										"pages.Settings.bgmTokenSettings.tokenExpiresAt",
										"Token 有效期至: {{date}}",
										{ date: expiresDate },
									)
								: t(
										"pages.Settings.bgmTokenSettings.tokenExpiryUnknown",
										"Token 有效期未知",
									)}
						</Typography>
					</Box>
					{actions}
				</Stack>
			) : (
				actions
			)}
		</Box>
	);
};

export const BgmProviderSection = () => {
	const { t } = useTranslation();
	const {
		bgmAuth,
		isSettingsLoading,
		inputToken,
		isOAuthLoading,
		isCompletingAuth,
		isSavingToken,
		setInputToken,
		handleOpenTokenPage,
		handleSaveToken,
		handleClearToken,
		handleOAuthLogin,
		handleCancelOAuth,
		handleCompleteAuth,
		handleLogout,
	} = useBgmAuthController();

	const { syncBgmCollection, setSyncBgmCollection } = useStore(
		useShallow((s) => ({
			syncBgmCollection: s.syncBgmCollection,
			setSyncBgmCollection: s.setSyncBgmCollection,
		})),
	);

	const isConnected = Boolean(bgmAuth?.access_token);

	useEffect(() => {
		if (!isSettingsLoading && !isConnected && syncBgmCollection) {
			setSyncBgmCollection(false);
		}
	}, [isConnected, isSettingsLoading, setSyncBgmCollection, syncBgmCollection]);

	return (
		<AccountProviderCard
			wordmark={<BgmWordmarkSVG />}
			connected={isConnected}
			description={t(
				"pages.Settings.bgmTokenSettings.description",
				"使用 Bangumi 账号登录以读取元数据、游玩状态和推送评价。",
			)}
			sync={{
				title: t("pages.Settings.collectionSync.bgmTitle", "Bangumi 收藏同步"),
				description: t(
					"pages.Settings.collectionSync.bgmDescription",
					"添加游戏时自动读取 BGM 状态，修改时实时同步回 BGM。",
				),
				checked: isConnected && syncBgmCollection,
				disabled: isSettingsLoading || !isConnected,
				onChange: setSyncBgmCollection,
			}}
		>
			{/* 登录与账号状态 */}
			<Box className="space-y-4">
				{isConnected ? (
					<BgmAccountSummary
						bgmAuth={bgmAuth}
						isCompletingAuth={isCompletingAuth}
						onCompleteAuth={handleCompleteAuth}
						onLogout={handleLogout}
					/>
				) : (
					<Stack spacing={2} alignItems="flex-start">
						<Button
							variant="contained"
							color="primary"
							startIcon={
								isSavingToken ? (
									<ButtonLoadingIndicator />
								) : isOAuthLoading ? (
									<CancelIcon />
								) : (
									<LoginIcon />
								)
							}
							onClick={isOAuthLoading ? handleCancelOAuth : handleOAuthLogin}
							disabled={isSavingToken}
							className="oauth-provider-button skerry-button-level-a skerry-button-level-a-gradient"
						>
							{isOAuthLoading
								? t(
										"pages.Settings.bgmTokenSettings.oauthCancel",
										"取消 BGM OAuth 登录",
									)
								: t(
										"pages.Settings.bgmTokenSettings.oauthLogin",
										"OAuth 快捷登录",
									)}
						</Button>

						{/* 登录方式提示 */}
						<Typography variant="caption" color="text.secondary">
							{t(
								"pages.Settings.bgmTokenSettings.localTokenHint",
								"也可以继续使用个人 Access Token 登录。",
							)}
						</Typography>

						<Accordion
							disableGutters
							defaultExpanded={false}
							elevation={0}
							sx={{
								width: "100%",
								border: "1px solid",
								borderColor: "divider",
								"&:before": { display: "none" },
								borderRadius: 1,
								marginTop: "12px !important",
								marginBottom: "0 !important",
								"&.Mui-expanded": {
									marginTop: "12px !important",
									marginBottom: "0 !important",
								},
							}}
						>
							<AccordionSummary
								expandIcon={<ArrowDropDownIcon />}
								sx={{
									minHeight: 48,
									"&.Mui-expanded": {
										minHeight: 48,
									},
									"& .MuiAccordionSummary-content": {
										margin: "12px 0",
									},
									"& .MuiAccordionSummary-content.Mui-expanded": {
										margin: "12px 0",
									},
								}}
							>
								<Stack direction="row" spacing={1} alignItems="center">
									<VpnKeyIcon fontSize="small" color="action" />
									<Typography variant="body2">
										{t(
											"pages.Settings.bgmTokenSettings.tokenLogin",
											"使用 Access Token 登录",
										)}
									</Typography>
								</Stack>
							</AccordionSummary>
							<AccordionDetails>
								<Stack spacing={1.5}>
									<TextField
										autoComplete="off"
										placeholder={t(
											"pages.Settings.tokenPlaceholder",
											"请填写你的BGM TOKEN",
										)}
										value={inputToken}
										onChange={(e) => setInputToken(e.target.value)}
										onBlur={handleSaveToken}
										onKeyDown={(event) => {
											if (
												event.key === "Enter" &&
												!event.nativeEvent.isComposing
											) {
												event.preventDefault();
												(event.target as HTMLInputElement).blur();
											}
										}}
										variant="outlined"
										size="small"
										fullWidth
										disabled={isSavingToken}
										slotProps={{
											htmlInput: {
												style: {
													WebkitTextSecurity: "disc",
													textSecurity: "disc",
												},
											},
											input: {
												endAdornment: isSavingToken ? (
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
											onClick={handleOpenTokenPage}
											size="small"
										>
											{t("pages.Settings.getToken", "获取令牌")}
										</Button>
									</Box>
								</Stack>
							</AccordionDetails>
						</Accordion>
					</Stack>
				)}
			</Box>
		</AccountProviderCard>
	);
};

export const BgmTokenSettings = BgmProviderSection;
