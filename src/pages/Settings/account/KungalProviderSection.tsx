import CancelIcon from "@mui/icons-material/Cancel";
import LoginIcon from "@mui/icons-material/Login";
import { Avatar, Chip, Stack, Typography } from "@mui/material";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import { useColorScheme } from "@mui/material/styles";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { ButtonLoadingIndicator } from "@/components/ui/ButtonLoadingIndicator";
import { useProxyImageUrlResolver } from "@/hooks/common/useProxyImageUrlResolver";
import { useStore } from "@/store/appStore";
import type { KungalAuth } from "@/types";
import { AccountProviderCard } from "../AccountProviderCard";
import { useKungalAuthController } from "../useKungalAuthController";

/** KunGal 官方字标组合 */
const KungalWordmarkSVG = () => {
	const { mode } = useColorScheme();
	const isDark = mode === "dark";

	return (
		<Stack direction="row" spacing={1.2} alignItems="center">
			{/* 圆形裁切吉祥物头像 */}
			<Box
				component="img"
				src="/images/kungal-icon.webp"
				alt="Kungal Logo"
				sx={{
					height: 28,
					width: 28,
					borderRadius: "50%",
					overflow: "hidden",
					objectFit: "cover",
					display: "block",
					boxShadow: "0 1px 3px rgba(0,0,0,0.12)",
				}}
			/>
			{/* 纯净 KunGal 现代品牌字标 */}
			<svg
				xmlns="http://www.w3.org/2000/svg"
				viewBox="0 0 102 32"
				style={{
					height: 24,
					width: "auto",
					display: "block",
					color: isDark ? "#f1f5f9" : "#0f172a",
				}}
			>
				<title>KunGal</title>
				<text
					x="0"
					y="24"
					fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
					fontSize="24"
					fontWeight="800"
					letterSpacing="-0.4"
					fill="currentColor"
				>
					Kun
					<tspan fontWeight="700" fill="currentColor" opacity="0.9">
						Gal
					</tspan>
				</text>
			</svg>
		</Stack>
	);
};

// ==================== KunGal 账号与同步板块 ====================

type KungalAccountSummaryProps = {
	auth?: KungalAuth | null;
	onLogout: () => void;
};

const KungalAccountSummary = ({
	auth,
	onLogout,
}: KungalAccountSummaryProps) => {
	const { t } = useTranslation();
	const resolveImageUrl = useProxyImageUrlResolver();
	if (!auth?.access_token) return null;

	const expiresAt = auth.expires_at ?? null;
	const expiresDate = expiresAt
		? new Date(expiresAt * 1000).toLocaleString()
		: null;
	const isExpired = Boolean(
		expiresAt && Date.now() / 1000 >= expiresAt && !auth.refresh_token,
	);
	const displayName =
		auth.nickname || auth.username || `#${auth.uid ?? "KunGal User"}`;
	const avatarUrl = auth.avatar
		? resolveImageUrl(auth.avatar)
		: "/images/kungal-icon.png";

	return (
		<Stack direction="row" spacing={2} alignItems="flex-start" className="mb-2">
			<Avatar src={avatarUrl} alt={displayName} sx={{ width: 44, height: 44 }}>
				{displayName.slice(0, 1).toUpperCase()}
			</Avatar>
			<Box className="min-w-0 flex-1">
				<Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
					<Typography variant="body1" className="font-semibold">
						{displayName}
					</Typography>
					<Chip
						label="OAuth"
						size="small"
						variant="outlined"
						className="oauth-status-badge oauth-status-badge--kungal"
					/>
				</Stack>
				{auth.uid != null && (
					<Typography
						variant="caption"
						color="text.secondary"
						className="block"
					>
						UID: {auth.uid}
					</Typography>
				)}
				<Typography
					variant="caption"
					color={isExpired ? "error.main" : "text.secondary"}
					className="block mt-1"
				>
					{expiresDate
						? t(
								"pages.Settings.kungalAuth.tokenExpiresAt",
								"Token 有效期至: {{date}}",
								{ date: expiresDate },
							)
						: t(
								"pages.Settings.kungalAuth.tokenExpiryUnknown",
								"Token 有效期未知",
							)}
				</Typography>
			</Box>
			<Button variant="outlined" color="error" size="small" onClick={onLogout}>
				{t("pages.Settings.kungalTokenSettings.logout", "退出登录")}
			</Button>
		</Stack>
	);
};

export const KungalProviderSection = () => {
	const { t } = useTranslation();
	const {
		kungalAuth,
		isSettingsLoading,
		isOAuthLoading,
		isSaving,
		handleOAuthLogin,
		handleCancelOAuth,
		handleLogout,
	} = useKungalAuthController();

	const { syncKungalCollection, setSyncKungalCollection } = useStore(
		useShallow((s) => ({
			syncKungalCollection: s.syncKungalCollection,
			setSyncKungalCollection: s.setSyncKungalCollection,
		})),
	);

	const isConnected = Boolean(kungalAuth?.access_token);

	useEffect(() => {
		if (!isSettingsLoading && !isConnected && syncKungalCollection) {
			setSyncKungalCollection(false);
		}
	}, [
		isConnected,
		isSettingsLoading,
		setSyncKungalCollection,
		syncKungalCollection,
	]);

	return (
		<AccountProviderCard
			wordmark={<KungalWordmarkSVG />}
			connected={isConnected}
			description={t(
				"pages.Settings.kungalAuth.description",
				"使用 鲲Galgame (NextMoe) 账号登录以同步收藏状态和元数据评价。",
			)}
			className="account-provider-card p-4"
			paperSx={{
				borderRadius: "12px",
				borderColor: "divider",
				bgcolor: "background.paper",
			}}
			sync={{
				title: t(
					"pages.Settings.collectionSync.kungalTitle",
					"启用 KunGal 收藏同步",
				),
				description: t(
					"pages.Settings.collectionSync.kungalDescription",
					"添加游戏时尝试读取 KunGal 收藏状态，本地修改状态时同步回 KunGal。",
				),
				checked: isConnected && syncKungalCollection,
				disabled: isSettingsLoading || !isConnected,
				onChange: setSyncKungalCollection,
			}}
		>
			{/* 账号及授权操作 */}
			<Box className="space-y-4">
				{isConnected ? (
					<KungalAccountSummary auth={kungalAuth} onLogout={handleLogout} />
				) : (
					<Stack spacing={2} alignItems="flex-start">
						<Button
							variant="contained"
							color="primary"
							startIcon={
								isSaving ? (
									<ButtonLoadingIndicator />
								) : isOAuthLoading ? (
									<CancelIcon />
								) : (
									<LoginIcon />
								)
							}
							onClick={isOAuthLoading ? handleCancelOAuth : handleOAuthLogin}
							disabled={isSaving}
							className="oauth-provider-button skerry-button-level-a skerry-button-level-a-gradient"
						>
							{isOAuthLoading
								? t("pages.Settings.kungalAuth.oauthCancel", "取消 KunGal 登录")
								: t("pages.Settings.kungalAuth.oauthLogin", "OAuth 快捷登录")}
						</Button>
					</Stack>
				)}
			</Box>
		</AccountProviderCard>
	);
};

export const KungalTokenSettings = KungalProviderSection;
