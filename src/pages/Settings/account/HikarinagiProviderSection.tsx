import CancelIcon from "@mui/icons-material/Cancel";
import LoginIcon from "@mui/icons-material/Login";
import { Avatar, Chip, Stack, Typography } from "@mui/material";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { ButtonLoadingIndicator } from "@/components/ui/ButtonLoadingIndicator";
import { useProxyImageUrlResolver } from "@/hooks/common/useProxyImageUrlResolver";
import type { HikarinagiUserProfile } from "@/metadata/api/hikarinagi";
import { useStore } from "@/store/appStore";
import type { HikarinagiAuth } from "@/types";
import { AccountProviderCard } from "../AccountProviderCard";
import { useHikarinagiAuthController } from "../useHikarinagiAuthController";

/** Hikarinagi 官方字标 */
const HikarinagiWordmarkSVG = () => (
	<Box
		component="img"
		src="/images/hikarinagi-wordmark.svg"
		alt="Hikarinagi"
		sx={{ height: 22, width: "auto", objectFit: "contain" }}
	/>
);

// ==================== Hikarinagi 账号与同步板块 ====================

type HikarinagiAccountSummaryProps = {
	auth?: HikarinagiAuth | null;
	profile?: HikarinagiUserProfile | null;
	onLogout: () => void;
};

const HikarinagiAccountSummary = ({
	auth,
	profile,
	onLogout,
}: HikarinagiAccountSummaryProps) => {
	const { t } = useTranslation();
	const resolveImageUrl = useProxyImageUrlResolver();
	if (!auth?.access_token) return null;

	const expiresAt = auth.expires_at ?? null;
	const expiresDate = expiresAt
		? new Date(expiresAt * 1000).toLocaleString()
		: null;
	const isExpired = expiresAt ? Date.now() / 1000 >= expiresAt : false;
	const displayName = auth.name || `#${auth.user_id ?? "?"}`;

	return (
		<Stack direction="row" spacing={2} alignItems="flex-start" className="mb-2">
			<Avatar
				src={resolveImageUrl(profile?.avatar?.src)}
				alt={displayName}
				sx={{ width: 44, height: 44 }}
			>
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
						className="oauth-status-badge oauth-status-badge--hikarinagi"
					/>
				</Stack>
				{auth.user_id != null && (
					<Typography
						variant="caption"
						color="text.secondary"
						className="block"
					>
						{t("pages.Settings.hikarinagiAuth.userId", "用户 ID: {{id}}", {
							id: auth.user_id,
						})}
					</Typography>
				)}
				<Typography
					variant="caption"
					color={isExpired ? "error.main" : "text.secondary"}
					className="block mt-1"
				>
					{expiresDate
						? t(
								"pages.Settings.hikarinagiAuth.tokenExpiresAt",
								"Token 有效期至: {{date}}",
								{ date: expiresDate },
							)
						: t(
								"pages.Settings.hikarinagiAuth.tokenExpiryUnknown",
								"Token 有效期未知",
							)}
				</Typography>
			</Box>
			<Button variant="outlined" color="error" size="small" onClick={onLogout}>
				{t("pages.Settings.hikarinagiAuth.logout", "退出登录")}
			</Button>
		</Stack>
	);
};

export const HikarinagiProviderSection = () => {
	const { t } = useTranslation();
	const {
		hikarinagiAuth,
		hikarinagiProfile,
		isSettingsLoading,
		isOAuthLoading,
		isSaving,
		handleOAuthLogin,
		handleCancelOAuth,
		handleLogout,
	} = useHikarinagiAuthController();

	const { syncHikarinagiCollection, setSyncHikarinagiCollection } = useStore(
		useShallow((s) => ({
			syncHikarinagiCollection: s.syncHikarinagiCollection,
			setSyncHikarinagiCollection: s.setSyncHikarinagiCollection,
		})),
	);

	const isConnected = Boolean(hikarinagiAuth?.access_token);

	useEffect(() => {
		if (!isSettingsLoading && !isConnected && syncHikarinagiCollection) {
			setSyncHikarinagiCollection(false);
		}
	}, [
		isConnected,
		isSettingsLoading,
		setSyncHikarinagiCollection,
		syncHikarinagiCollection,
	]);

	return (
		<AccountProviderCard
			wordmark={<HikarinagiWordmarkSVG />}
			connected={isConnected}
			description={t(
				"pages.Settings.hikarinagiAuth.description",
				"使用 Hikarinagi OAuth 登录以读取元数据、游玩状态和推送评价。",
			)}
			sync={{
				title: t(
					"pages.Settings.collectionSync.hikarinagiTitle",
					"Hikarinagi 游玩状态同步",
				),
				description: t(
					"pages.Settings.collectionSync.hikarinagiDescription",
					"添加游戏时自动读取 Hikarinagi 游玩状态，本地修改状态实时同步。",
				),
				checked: isConnected && syncHikarinagiCollection,
				disabled: isSettingsLoading || !isConnected,
				onChange: setSyncHikarinagiCollection,
			}}
		>
			{/* 账号及授权操作 */}
			<Box className="space-y-4">
				{isConnected ? (
					<HikarinagiAccountSummary
						auth={hikarinagiAuth}
						profile={hikarinagiProfile}
						onLogout={handleLogout}
					/>
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
								? t(
										"pages.Settings.hikarinagiAuth.oauthCancel",
										"取消 Hikarinagi OAuth 登录",
									)
								: t(
										"pages.Settings.hikarinagiAuth.oauthLogin",
										"OAuth 快捷登录",
									)}
						</Button>
					</Stack>
				)}
			</Box>
		</AccountProviderCard>
	);
};

export const HikarinagiAuthSettings = HikarinagiProviderSection;
