import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import SyncAltIcon from "@mui/icons-material/SyncAlt";
import {
	Alert,
	Box,
	Button,
	Checkbox,
	Chip,
	FormControlLabel,
	Stack,
	Switch,
	Slider,
	TextField,
	Typography,
} from "@mui/material";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUpdateGame } from "@/hooks/queries/useGames";
import { useUpdatePlayStatus } from "@/hooks/queries/usePlayStatus";
import {
	useAllSettings,
	useVndbCurrentUserProfile,
} from "@/hooks/queries/useSettings";
import { useGameStats } from "@/hooks/queries/useStats";
import { buildGameInfoUpdatePayload } from "@/metadata/data/metadata";
import { getSourceIdFromDisplay } from "@/metadata/sourceRecord";
import { snackbar } from "@/providers/snackBar";
import {
	pushGameUserReviewToCloud,
	type UserReviewPushResult,
} from "@/services/cloudUserReview";
import type { GameData } from "@/types";
import { PLAY_STATUS_I18N_KEYS, PlayStatus } from "@/types/collection";
import { parsePlaytimeInput } from "@/utils/dateTime";
import { getUserErrorMessage } from "@/utils/errors";
import { getGameDisplayName } from "@/utils/game";
import {
	formatRating,
	LocalReviewForm,
	parseRatingInput,
} from "./LocalReviewForm";
import { ButtonLoadingIndicator } from "@/components/ui/ButtonLoadingIndicator";

const SECTION_SX = {
	p: { xs: 1.5, md: 2.5 },
	border: 1,
	borderColor: "divider",
	borderRadius: 2,
	background:
		"color-mix(in srgb, var(--skerry-glass-surface) 76%, transparent)",
	backdropFilter: "blur(14px) saturate(120%)",
	boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.18)",
} as const;

const getTileSx = (active: boolean) => ({
	p: 2,
	borderRadius: 2,
	border: 1,
	borderColor: active ? "primary.main" : "divider",
	bgcolor: active
		? "color-mix(in srgb, var(--mui-palette-background-paper) 92%, transparent)"
		: "color-mix(in srgb, var(--mui-palette-background-paper) 45%, transparent)",
	opacity: active ? 1 : 0.72,
	transition: "all 0.2s ease",
	display: "flex",
	flexDirection: "column",
	justifyContent: "space-between",
	minHeight: 124,
	"&:hover": {
		borderColor: "primary.main",
		bgcolor:
			"color-mix(in srgb, var(--mui-palette-background-paper) 98%, transparent)",
	},
});

interface ReviewProps {
	selectedGame: GameData;
}

function getSourceLabel(source: UserReviewPushResult["source"]) {
	switch (source) {
		case "bgm":
			return "Bangumi";
		case "vndb":
			return "VNDB";
		case "hikarinagi":
			return "Hikarinagi";
		case "kun":
			return "Kungal";
		default:
			return assertNever(source);
	}
}

function assertNever(value: never): never {
	throw new Error(`不支持的评价推送来源: ${String(value)}`);
}

export const Review: React.FC<ReviewProps> = ({ selectedGame }) => {
	const { t } = useTranslation();
	const updateGameMutation = useUpdateGame();
	const updatePlayStatusMutation = useUpdatePlayStatus();
	const { data: settings, isLoading: isSettingsLoading } = useAllSettings();
	const { data: gameStats } = useGameStats(selectedGame.id);

	const bgmId = getSourceIdFromDisplay(selectedGame, "bgm");
	const vndbId = getSourceIdFromDisplay(selectedGame, "vndb");
	const hikarinagiId = getSourceIdFromDisplay(selectedGame, "hikarinagi");
	const kunId = getSourceIdFromDisplay(selectedGame, "kun");

	const hasVndbId = Boolean(vndbId);
	const { data: vndbProfile, isLoading: isVndbProfileLoading } =
		useVndbCurrentUserProfile({ enabled: hasVndbId });

	const [ratingInput, setRatingInput] = useState(() =>
		formatRating(selectedGame.custom_data?.user_rating),
	);
	const [reviewInput, setReviewInput] = useState(
		() => selectedGame.custom_data?.user_review ?? "",
	);
	const [cloudReviewInput, setCloudReviewInput] = useState("");
	const [pushReview, setPushReview] = useState(true);

	const [pushBgm, setPushBgm] = useState(Boolean(bgmId));
	const [pushVndb, setPushVndb] = useState(Boolean(vndbId));
	const [pushHikarinagi, setPushHikarinagi] = useState(Boolean(hikarinagiId));
	const [pushKun, setPushKun] = useState(Boolean(kunId));

	// 云端独立推送评分（纯整数 0-10；0 不提交评分，评语/状态/时长按各自开关推送）
	const [pushRatingInput, setPushRatingInput] = useState<string>(() => {
		const r = selectedGame.custom_data?.user_rating;
		if (typeof r === "number" && r > 0) {
			return String(Math.min(10, Math.max(1, Math.round(r))));
		}
		return "0";
	});

	// 游玩状态同步
	const [syncPlayStatus, setSyncPlayStatus] = useState(true);
	const [targetPlayStatus, setTargetPlayStatus] = useState<PlayStatus>(
		() => selectedGame.clear ?? PlayStatus.PLAYED,
	);

	const [bgmPrivate, setBgmPrivate] = useState(false);
	const [pushHikarinagiPlaytime, setPushHikarinagiPlaytime] = useState(true);
	const [pushKunPlaytime, setPushKunPlaytime] = useState(true);
	const [hikarinagiHoursInput, setHikarinagiHoursInput] = useState("0");
	const [hikarinagiMinutesInput, setHikarinagiMinutesInput] = useState("0");
	const [kunHoursInput, setKunHoursInput] = useState("0");
	const [kunMinutesInput, setKunMinutesInput] = useState("0");
	const [playtimeInitializedGameId, setPlaytimeInitializedGameId] = useState<
		number | null
	>(null);
	const [pushResults, setPushResults] = useState<UserReviewPushResult[]>([]);
	const [isPushing, setIsPushing] = useState(false);
	const [pushDefaultsApplied, setPushDefaultsApplied] = useState(false);

	const hasBgmToken = Boolean(settings?.bgm_auth?.access_token);
	const hasVndbToken = Boolean(settings?.vndb_token);
	const hasHikarinagiToken = Boolean(settings?.hikarinagi_auth?.access_token);
	const hasKungalToken = Boolean(settings?.kungal_auth?.access_token);

	const canPushBgm = Boolean(bgmId && hasBgmToken);
	const canPushVndb = Boolean(
		vndbId && hasVndbToken && vndbProfile?.permissions.includes("listwrite"),
	);
	const canPushHikarinagi = Boolean(hikarinagiId && hasHikarinagiToken);
	const canPushKun = Boolean(kunId && hasKungalToken);

	const isPushCapabilityLoading =
		isSettingsLoading ||
		Boolean(hasVndbId && hasVndbToken && isVndbProfileLoading);

	const effectivePushBgm = pushBgm && canPushBgm;
	const effectivePushVndb = pushVndb && canPushVndb;
	const effectivePushHikarinagi = pushHikarinagi && canPushHikarinagi;
	const effectivePushKun = pushKun && canPushKun;

	// 当所选游戏切换时同步游玩状态与游戏时长
	useEffect(() => {
		setTargetPlayStatus(selectedGame.clear ?? PlayStatus.PLAYED);
		const r = selectedGame.custom_data?.user_rating;
		if (typeof r === "number" && r > 0) {
			setPushRatingInput(String(Math.min(10, Math.max(1, Math.round(r)))));
		} else {
			setPushRatingInput("0");
		}
	}, [selectedGame.clear]);

	useEffect(() => {
		setCloudReviewInput("");
	}, [selectedGame.id]);

	useEffect(() => {
		if (
			gameStats === undefined ||
			playtimeInitializedGameId === selectedGame.id
		) {
			return;
		}

		const totalMinutes = Math.max(0, Math.floor(gameStats?.totalMinutes ?? 0));
		const hoursStr = String(Math.floor(totalMinutes / 60));
		const minutesStr = String(totalMinutes % 60);

		setHikarinagiHoursInput(hoursStr);
		setHikarinagiMinutesInput(minutesStr);
		setKunHoursInput(hoursStr);
		setKunMinutesInput(minutesStr);
		setPlaytimeInitializedGameId(selectedGame.id);
	}, [gameStats, playtimeInitializedGameId, selectedGame.id]);

	useEffect(() => {
		if (pushDefaultsApplied || isPushCapabilityLoading) return;

		setPushBgm(canPushBgm);
		setPushVndb(canPushVndb);
		setPushHikarinagi(canPushHikarinagi);
		setPushKun(canPushKun);
		setPushDefaultsApplied(true);
	}, [
		canPushBgm,
		canPushHikarinagi,
		canPushKun,
		canPushVndb,
		isPushCapabilityLoading,
		pushDefaultsApplied,
	]);

	const parsedRating = useMemo(
		() => parseRatingInput(ratingInput),
		[ratingInput],
	);
	const bgmRate = Math.round(parsedRating.value);
	const hikarinagiRate = Math.round(parsedRating.value);
	const kunRate = Math.round(parsedRating.value);

	const showBgmRoundNotice =
		effectivePushBgm &&
		parsedRating.value > 0 &&
		Math.abs(parsedRating.value - bgmRate) > Number.EPSILON;
	const showHikarinagiRoundNotice =
		effectivePushHikarinagi &&
		parsedRating.value > 0 &&
		Math.abs(parsedRating.value - hikarinagiRate) > Number.EPSILON;
	const showKunRoundNotice =
		effectivePushKun &&
		parsedRating.value > 0 &&
		Math.abs(parsedRating.value - kunRate) > Number.EPSILON;

	const saveReviewDraft = useCallback(
		async (nextRating: number, nextReview: string) => {
			try {
				const updates = buildGameInfoUpdatePayload(selectedGame, {
					newLocalPath: selectedGame.localpath ?? "",
					newName: getGameDisplayName(selectedGame),
					newUserRating: nextRating,
					newUserReview: nextReview,
				});
				if (Object.keys(updates).length === 0) {
					setRatingInput(formatRating(nextRating));
					return true;
				}
				await updateGameMutation.mutateAsync({
					gameId: selectedGame.id,
					updates,
				});
				setRatingInput(formatRating(nextRating));
				snackbar.success(t("pages.Detail.Review.saveSuccess", "评价已保存"));
				return true;
			} catch (error) {
				snackbar.error(getUserErrorMessage(error, t));
				return false;
			}
		},
		[selectedGame, t, updateGameMutation],
	);

	const handlePush = async () => {
		if (
			!effectivePushBgm &&
			!effectivePushVndb &&
			!effectivePushHikarinagi &&
			!effectivePushKun
		) {
			return;
		}

		// 云端推送评分：纯整数 0-10；0 不提交评分，不影响评语、状态与时长推送
		const parsedPushRating = Number.parseInt(pushRatingInput.trim(), 10);
		if (
			Number.isNaN(parsedPushRating) ||
			parsedPushRating < 0 ||
			parsedPushRating > 10
		) {
			snackbar.error(
				t(
					"pages.Detail.Review.pushRatingRangeError",
					"推送评分必须为 0 到 10 的整数",
				),
			);
			return;
		}

		const hikarinagiTimeToFinishMinutes =
			effectivePushHikarinagi && pushHikarinagiPlaytime
				? parsePlaytimeInput(hikarinagiHoursInput, hikarinagiMinutesInput)
				: undefined;
		if (
			effectivePushHikarinagi &&
			pushHikarinagiPlaytime &&
			hikarinagiTimeToFinishMinutes === null
		) {
			snackbar.error(
				t("pages.Detail.Review.playtimeInvalid", "请输入有效的小时和分钟"),
			);
			return;
		}

		const kunPlaytimeMinutes =
			effectivePushKun && pushKunPlaytime
				? parsePlaytimeInput(kunHoursInput, kunMinutesInput)
				: undefined;
		if (effectivePushKun && pushKunPlaytime && kunPlaytimeMinutes === null) {
			snackbar.error(
				t("pages.Detail.Review.playtimeInvalid", "请输入有效的小时和分钟"),
			);
			return;
		}

		setIsPushing(true);
		setPushResults([]);
		try {
			const results = await pushGameUserReviewToCloud(selectedGame, {
				rating: parsedPushRating,
				review: cloudReviewInput,
				pushReview,
				playStatus: syncPlayStatus ? targetPlayStatus : undefined,
				pushBgm: effectivePushBgm,
				pushVndb: effectivePushVndb,
				pushHikarinagi: effectivePushHikarinagi,
				pushKun: effectivePushKun,
				bgmPrivate,
				hikarinagiSpoiler: false,
				hikarinagiTimeToFinishMinutes:
					hikarinagiTimeToFinishMinutes ?? undefined,
				kunPlaytimeMinutes: kunPlaytimeMinutes ?? undefined,
			});
			setPushResults(results);

			// 如果勾选了同步游玩状态，且目标状态与本地不同，同步更新本地游戏状态
			if (syncPlayStatus && targetPlayStatus !== selectedGame.clear) {
				try {
					await updatePlayStatusMutation.mutateAsync({
						gameId: selectedGame.id,
						newStatus: targetPlayStatus,
					});
				} catch (statusError) {
					console.warn("同步更新本地游玩状态失败:", statusError);
				}
			}

			if (results.every((result) => result.success)) {
				snackbar.success(t("pages.Detail.Review.pushSuccess", "评价推送完成"));
			} else {
				snackbar.error(
					t("pages.Detail.Review.pushPartialFailed", "部分目标推送失败"),
				);
			}
		} finally {
			setIsPushing(false);
		}
	};

	return (
		<Box sx={{ p: 2 }}>
			<Stack spacing={2.5}>
				{/* 本地评价：对齐编辑页纯平无阴影规范 */}
				<Box sx={SECTION_SX}>
					<Typography variant="h6" sx={{ mb: 2 }}>
						{t("pages.Detail.Review.localReview", "本地评价")}
					</Typography>
					<Stack spacing={1}>
						<LocalReviewForm
							initialRating={selectedGame.custom_data?.user_rating}
							initialReview={selectedGame.custom_data?.user_review ?? ""}
							ratingInput={ratingInput}
							reviewInput={reviewInput}
							onRatingChange={setRatingInput}
							onReviewChange={setReviewInput}
							onSave={saveReviewDraft}
						/>
						<Box sx={{ display: "flex", justifyContent: "flex-end" }}>
							<Button
								size="small"
								startIcon={<SyncAltIcon />}
								onClick={() => setCloudReviewInput(reviewInput)}
							>
								{t(
									"pages.Detail.Review.syncLocalReviewToCloud",
									"同步到云端评价",
								)}
							</Button>
						</Box>
					</Stack>
				</Box>

				{/* 云端推送：方案 A 双列对称卡槽矩阵 */}
				<Box sx={SECTION_SX}>
					<Typography variant="h6" sx={{ mb: 0.5 }}>
						{t("pages.Detail.Review.cloudPush", "云端推送")}
					</Typography>
					<Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
						{t(
							"pages.Detail.Review.cloudPushHelperText",
							"评分、评价、游玩状态和时长分别设置；推送评价使用下方云端评价内容",
						)}
					</Typography>

					<Stack spacing={2.5}>
						{/* 顶栏：游玩状态同步行（分段胶囊选择） */}
						<Box
							sx={{
								p: 1.5,
								px: 2,
								borderRadius: 2,
								border: 1,
								borderColor: "divider",
								bgcolor:
									"color-mix(in srgb, var(--skerry-accent) 4%, transparent)",
								display: "flex",
								flexWrap: "wrap",
								alignItems: "center",
								justifyContent: "space-between",
								gap: 1.5,
							}}
						>
							<Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
								<Switch
									checked={syncPlayStatus}
									onChange={(event) => setSyncPlayStatus(event.target.checked)}
								/>
								<Box>
									<Typography variant="body2" sx={{ fontWeight: 650 }}>
										{t("pages.Detail.Review.syncPlayStatus", "推送游玩状态")}
									</Typography>
									<Typography variant="caption" color="text.secondary">
										{t(
											"pages.Detail.Review.syncPlayStatusHint",
											"推送时自动同步至所选站点与本地",
										)}
									</Typography>
								</Box>
							</Box>

							{/* 右侧：高还原微拟物拉动条（左侧标签 + 橙色轨道圆滑块 + 右侧独立分值药丸框） */}
							<Box
								sx={{
									display: "flex",
									alignItems: "center",
									gap: 1.5,
									minWidth: { xs: "100%", sm: 320 },
									flex: { xs: "1 1 100%", sm: "0 1 auto" },
								}}
							>
								{/* 1. 左侧纯净文字标签 */}
								<Typography
									variant="body2"
									sx={{
										fontSize: "0.86rem",
										fontWeight: 600,
										color: "text.primary",
										whiteSpace: "nowrap",
										userSelect: "none",
									}}
								>
									{t("pages.Detail.Review.pushRatingTitle", "推送评分 (0-10)")}
								</Typography>

								{/* 2. 中间精雕细琢的 Slider 轨道与空心带光晕圆滑块 */}
								<Slider
									value={Number(pushRatingInput) || 0}
									min={0}
									max={10}
									step={1}
									onChange={(_, val) => setPushRatingInput(String(val))}
									sx={{
										flex: 1,
										height: 3,
										mx: 1,
										py: 1.5,
										// 激活轨道：浅色模式温暖橙色，深色模式自然切换为主色调亮蓝
										"& .MuiSlider-track": {
											bgcolor: "primary.main",
											border: "none",
											height: 3,
										},
										// 未激活底轨：随当前文字色透明度自适应
										"& .MuiSlider-rail": {
											bgcolor:
												"color-mix(in srgb, currentColor 20%, transparent)",
											opacity: 1,
											height: 3,
										},
										// 滑块空心圆环：边框与光晕全部绑定 primary.main 变量，浅色为暖橙、深色为亮蓝，绝不窜色
										"& .MuiSlider-thumb": {
											width: 14,
											height: 14,
											bgcolor: "background.paper",
											border: "2.5px solid",
											borderColor: "primary.main",
											boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
											"&:hover, &.Mui-focusVisible": {
												boxShadow:
													"0 0 0 6px color-mix(in srgb, var(--mui-palette-primary-main) 24%, transparent)",
											},
											"&.Mui-active": {
												boxShadow:
													"0 0 0 9px color-mix(in srgb, var(--mui-palette-primary-main) 36%, transparent)",
											},
										},
									}}
								/>

								{/* 3. 右侧独立的分值药丸方框（清晰边框与质感） */}
								<Box
									sx={{
										minWidth: 48,
										px: 1.2,
										py: 0.35,
										borderRadius: 1.5,
										bgcolor: "background.paper",
										border: "1.5px solid",
										borderColor:
											Number(pushRatingInput) > 0
												? "color-mix(in srgb, var(--mui-palette-primary-main) 60%, rgba(140, 150, 165, 0.45))"
												: "color-mix(in srgb, currentColor 28%, rgba(140, 150, 165, 0.35))",
										boxShadow:
											Number(pushRatingInput) > 0
												? "0 2px 6px color-mix(in srgb, var(--mui-palette-primary-main) 20%, transparent), 0 1px 2px rgba(0,0,0,0.08)"
												: "0 1px 2px rgba(0,0,0,0.08)",
										textAlign: "center",
										userSelect: "none",
										transition: "all 0.2s ease-in-out",
									}}
								>
									<Typography
										variant="body2"
										sx={{
											fontSize: "0.82rem",
											fontWeight: 700,
											color:
												Number(pushRatingInput) > 0
													? "text.primary"
													: "text.secondary",
											whiteSpace: "nowrap",
										}}
									>
										{Number(pushRatingInput) > 0
											? pushRatingInput + " 分"
											: "0 分"}
									</Typography>
								</Box>
							</Box>
						</Box>

						<Box
							sx={{
								p: 2,
								borderRadius: 2,
								border: 1,
								borderColor: "divider",
								bgcolor:
									"color-mix(in srgb, var(--skerry-accent) 4%, transparent)",
							}}
						>
							<Stack spacing={1.25}>
								<Stack
									direction={{ xs: "column", sm: "row" }}
									alignItems={{ xs: "flex-start", sm: "center" }}
									justifyContent="space-between"
									gap={1}
								>
									<Box>
										<Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
											{t("pages.Detail.Review.cloudReview", "云端评价草稿")}
										</Typography>
										<Typography variant="caption" color="text.secondary">
											{t(
												"pages.Detail.Review.cloudReviewHelperText",
												"此处内容独立于本地评价；需要时可通过同步按钮复制。",
											)}
										</Typography>
									</Box>
									<FormControlLabel
										control={
											<Switch
												checked={pushReview}
												onChange={(event) =>
													setPushReview(event.target.checked)
												}
											/>
										}
										label={t("pages.Detail.Review.pushReview", "推送评价")}
										sx={{ m: 0 }}
									/>
								</Stack>
								<TextField
									label={t(
										"pages.Detail.Review.cloudReviewInputLabel",
										"云端评价内容",
									)}
									value={cloudReviewInput}
									onChange={(event) => setCloudReviewInput(event.target.value)}
									fullWidth
									multiline
									minRows={4}
									maxRows={10}
									InputLabelProps={{ shrink: true }}
									helperText={t(
										"pages.Detail.Review.cloudReviewInputHint",
										"推送时只会使用此处内容，不会读取或修改本地评价。",
									)}
								/>
								<Box sx={{ display: "flex", justifyContent: "flex-end" }}>
									<Button
										size="small"
										startIcon={<SyncAltIcon />}
										onClick={() => setReviewInput(cloudReviewInput)}
									>
										{t(
											"pages.Detail.Review.syncCloudReviewToLocal",
											"复制到本地评价草稿",
										)}
									</Button>
								</Box>
							</Stack>
						</Box>

						{/* 数据源双列平衡卡槽矩阵（2x2 Grid） */}
						<Box
							sx={{
								display: "grid",
								gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" },
								gap: 2,
							}}
						>
							{/* 1. Bangumi */}
							<Box sx={getTileSx(effectivePushBgm)}>
								<Box
									sx={{
										display: "flex",
										alignItems: "center",
										justifyContent: "space-between",
										mb: 1.5,
									}}
								>
									<Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
										<Checkbox
											checked={effectivePushBgm}
											disabled={!canPushBgm}
											onChange={(event) => setPushBgm(event.target.checked)}
											sx={{ p: 0.5 }}
										/>
										<Typography variant="body1" sx={{ fontWeight: 700 }}>
											Bangumi
										</Typography>
									</Box>
									<Chip
										size="small"
										label={
											canPushBgm ? "已连接" : !hasBgmToken ? "未授权" : "未关联"
										}
										color={canPushBgm ? "success" : "default"}
										variant={canPushBgm ? "filled" : "outlined"}
										sx={{
											height: 24,
											fontSize: "0.74rem",
											fontWeight: 700,
											borderRadius: "6px",
											color: "success.main",
											bgcolor:
												"color-mix(in srgb, var(--mui-palette-success-main) 16%, transparent)",
											border: 1,
											borderColor:
												"color-mix(in srgb, var(--mui-palette-success-main) 42%, transparent)",
											"& .MuiChip-label": { px: 1 },
										}}
									/>
								</Box>
								<Box>
									<FormControlLabel
										sx={{ m: 0 }}
										control={
											<Switch
												size="small"
												checked={bgmPrivate}
												disabled={!effectivePushBgm}
												onChange={(event) =>
													setBgmPrivate(event.target.checked)
												}
											/>
										}
										label={
											<Typography
												variant="body2"
												color={
													effectivePushBgm ? "text.primary" : "text.secondary"
												}
											>
												{t(
													"pages.Detail.Review.bgmPrivate",
													"BGM 私密评价（仅自己可见）",
												)}
											</Typography>
										}
									/>
								</Box>
							</Box>

							{/* 2. VNDB */}
							<Box sx={getTileSx(effectivePushVndb)}>
								<Box
									sx={{
										display: "flex",
										alignItems: "center",
										justifyContent: "space-between",
										mb: 1.5,
									}}
								>
									<Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
										<Checkbox
											checked={effectivePushVndb}
											disabled={!canPushVndb}
											onChange={(event) => setPushVndb(event.target.checked)}
											sx={{ p: 0.5 }}
										/>
										<Typography variant="body1" sx={{ fontWeight: 700 }}>
											VNDB
										</Typography>
									</Box>
									<Chip
										size="small"
										label={
											canPushVndb
												? "已连接"
												: !hasVndbToken
													? "未授权"
													: "未关联"
										}
										color={canPushVndb ? "success" : "default"}
										variant={canPushVndb ? "filled" : "outlined"}
										sx={{
											height: 24,
											fontSize: "0.74rem",
											fontWeight: 700,
											borderRadius: "6px",
											color: "success.main",
											bgcolor:
												"color-mix(in srgb, var(--mui-palette-success-main) 16%, transparent)",
											border: 1,
											borderColor:
												"color-mix(in srgb, var(--mui-palette-success-main) 42%, transparent)",
											"& .MuiChip-label": { px: 1 },
										}}
									/>
								</Box>
								<Box>
									<Typography
										variant="caption"
										color="text.secondary"
										sx={{
											display: "inline-block",
											px: 1,
											py: 0.4,
											bgcolor: "action.hover",
											borderRadius: 1,
											fontSize: "0.8rem",
										}}
									>
										✓{" "}
										{t(
											"pages.Detail.Review.vndbDesc",
											"自动同步评分、状态与标签",
										)}
									</Typography>
								</Box>
							</Box>

							{/* 3. Hikarinagi */}
							<Box sx={getTileSx(effectivePushHikarinagi)}>
								<Box
									sx={{
										display: "flex",
										alignItems: "center",
										justifyContent: "space-between",
										mb: 1.5,
									}}
								>
									<Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
										<Checkbox
											checked={effectivePushHikarinagi}
											disabled={!canPushHikarinagi}
											onChange={(event) =>
												setPushHikarinagi(event.target.checked)
											}
											sx={{ p: 0.5 }}
										/>
										<Typography variant="body1" sx={{ fontWeight: 700 }}>
											Hikarinagi
										</Typography>
									</Box>
									<Chip
										size="small"
										label={
											canPushHikarinagi
												? "已连接"
												: !hasHikarinagiToken
													? "未授权"
													: "未关联"
										}
										color={canPushHikarinagi ? "success" : "default"}
										variant={canPushHikarinagi ? "filled" : "outlined"}
										sx={{
											height: 24,
											fontSize: "0.74rem",
											fontWeight: 700,
											borderRadius: "6px",
											color: "success.main",
											bgcolor:
												"color-mix(in srgb, var(--mui-palette-success-main) 16%, transparent)",
											border: 1,
											borderColor:
												"color-mix(in srgb, var(--mui-palette-success-main) 42%, transparent)",
											"& .MuiChip-label": { px: 1 },
										}}
									/>
								</Box>
								<Stack
									direction="row"
									spacing={1.5}
									alignItems="center"
									flexWrap="wrap"
									sx={{ gap: 1 }}
								>
									<FormControlLabel
										sx={{ m: 0 }}
										control={
											<Switch
												size="small"
												checked={pushHikarinagiPlaytime}
												disabled={!effectivePushHikarinagi}
												onChange={(event) =>
													setPushHikarinagiPlaytime(event.target.checked)
												}
											/>
										}
										label={
											<Typography
												variant="body2"
												color={
													effectivePushHikarinagi
														? "text.primary"
														: "text.secondary"
												}
											>
												{t("pages.Detail.Review.pushGameTime", "推送时长")}
											</Typography>
										}
									/>
									{effectivePushHikarinagi && pushHikarinagiPlaytime && (
										<Box
											sx={{
												display: "inline-flex",
												alignItems: "center",
												gap: 0.5,
												bgcolor: "action.hover",
												px: 1,
												py: 0.3,
												borderRadius: 1.5,
												border: 1,
												borderColor: "divider",
											}}
										>
											<Typography variant="caption" sx={{ fontSize: "0.8rem" }}>
												⏱ 时长:
											</Typography>
											<TextField
												size="small"
												type="number"
												variant="standard"
												value={hikarinagiHoursInput}
												disabled={!effectivePushHikarinagi}
												onChange={(event) =>
													setHikarinagiHoursInput(event.target.value)
												}
												inputProps={{
													min: 0,
													step: 1,
													style: {
														textAlign: "center",
														width: 34,
														fontSize: "0.85rem",
														padding: "0 2px",
													},
												}}
												InputProps={{ disableUnderline: true }}
											/>
											<Typography variant="caption" color="text.secondary">
												小时
											</Typography>
											<TextField
												size="small"
												type="number"
												variant="standard"
												value={hikarinagiMinutesInput}
												disabled={!effectivePushHikarinagi}
												onChange={(event) =>
													setHikarinagiMinutesInput(event.target.value)
												}
												inputProps={{
													min: 0,
													max: 59,
													step: 1,
													style: {
														textAlign: "center",
														width: 34,
														fontSize: "0.85rem",
														padding: "0 2px",
													},
												}}
												InputProps={{ disableUnderline: true }}
											/>
											<Typography variant="caption" color="text.secondary">
												分
											</Typography>
										</Box>
									)}
								</Stack>
							</Box>

							{/* 4. Kungal */}
							<Box sx={getTileSx(effectivePushKun)}>
								<Box
									sx={{
										display: "flex",
										alignItems: "center",
										justifyContent: "space-between",
										mb: 1.5,
									}}
								>
									<Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
										<Checkbox
											checked={effectivePushKun}
											disabled={!canPushKun}
											onChange={(event) => setPushKun(event.target.checked)}
											sx={{ p: 0.5 }}
										/>
										<Typography variant="body1" sx={{ fontWeight: 700 }}>
											Kungal
										</Typography>
									</Box>
									{/* 用户指定：统一只标“已连接”，不搞特殊 */}
									<Chip
										size="small"
										label={
											canPushKun
												? "已连接"
												: !hasKungalToken
													? "未授权"
													: "未关联"
										}
										color={canPushKun ? "success" : "default"}
										variant={canPushKun ? "filled" : "outlined"}
										sx={{
											height: 24,
											fontSize: "0.74rem",
											fontWeight: 700,
											borderRadius: "6px",
											color: "success.main",
											bgcolor:
												"color-mix(in srgb, var(--mui-palette-success-main) 16%, transparent)",
											border: 1,
											borderColor:
												"color-mix(in srgb, var(--mui-palette-success-main) 42%, transparent)",
											"& .MuiChip-label": { px: 1 },
										}}
									/>
								</Box>
								<Stack
									direction="row"
									spacing={1.5}
									alignItems="center"
									flexWrap="wrap"
									sx={{ gap: 1 }}
								>
									<FormControlLabel
										sx={{ m: 0 }}
										control={
											<Switch
												size="small"
												checked={pushKunPlaytime}
												disabled={!effectivePushKun}
												onChange={(event) =>
													setPushKunPlaytime(event.target.checked)
												}
											/>
										}
										label={
											<Typography
												variant="body2"
												color={
													effectivePushKun ? "text.primary" : "text.secondary"
												}
											>
												{t("pages.Detail.Review.pushGameTime", "推送时长")}
											</Typography>
										}
									/>
									{effectivePushKun && pushKunPlaytime && (
										<Box
											sx={{
												display: "inline-flex",
												alignItems: "center",
												gap: 0.5,
												bgcolor: "action.hover",
												px: 1,
												py: 0.3,
												borderRadius: 1.5,
												border: 1,
												borderColor: "divider",
											}}
										>
											<Typography variant="caption" sx={{ fontSize: "0.8rem" }}>
												⏱ 时长:
											</Typography>
											<TextField
												size="small"
												type="number"
												variant="standard"
												value={kunHoursInput}
												disabled={!effectivePushKun}
												onChange={(event) =>
													setKunHoursInput(event.target.value)
												}
												inputProps={{
													min: 0,
													step: 1,
													style: {
														textAlign: "center",
														width: 34,
														fontSize: "0.85rem",
														padding: "0 2px",
													},
												}}
												InputProps={{ disableUnderline: true }}
											/>
											<Typography variant="caption" color="text.secondary">
												小时
											</Typography>
											<TextField
												size="small"
												type="number"
												variant="standard"
												value={kunMinutesInput}
												disabled={!effectivePushKun}
												onChange={(event) =>
													setKunMinutesInput(event.target.value)
												}
												inputProps={{
													min: 0,
													max: 59,
													step: 1,
													style: {
														textAlign: "center",
														width: 34,
														fontSize: "0.85rem",
														padding: "0 2px",
													},
												}}
												InputProps={{ disableUnderline: true }}
											/>
											<Typography variant="caption" color="text.secondary">
												分
											</Typography>
										</Box>
									)}
								</Stack>
							</Box>
						</Box>

						{/* 底部操作与预览栏 */}
						<Stack
							direction={{ xs: "column", sm: "row" }}
							justifyContent="space-between"
							alignItems="center"
							spacing={2}
							sx={{ pt: 2, borderTop: 1, borderColor: "divider" }}
						>
							<Typography variant="body2" color="text.secondary">
								推送预览：将向{" "}
								<Box
									component="span"
									sx={{ fontWeight: 700, color: "text.primary" }}
								>
									{[
										effectivePushBgm && "Bangumi",
										effectivePushVndb && "VNDB",
										effectivePushHikarinagi && "Hikarinagi",
										effectivePushKun && "Kungal",
									]
										.filter(Boolean)
										.join("、") || "未选择站点"}
								</Box>{" "}
								推送{" "}
								<Box
									component="span"
									sx={{ fontWeight: 700, color: "primary.main" }}
								>
									{Number(pushRatingInput) > 0
										? `${pushRatingInput} 分`
										: "无评分"}
									{pushReview
										? cloudReviewInput.trim()
											? " · 推送评价"
											: " · 评价内容为空"
										: " · 不推送评价"}
								</Box>
								{syncPlayStatus && (
									<Box component="span" sx={{ ml: 0.5, fontWeight: 600 }}>
										· {t(PLAY_STATUS_I18N_KEYS[targetPlayStatus])}
									</Box>
								)}
							</Typography>

							<Button
								variant="contained"
								size="large"
								startIcon={
									isPushing ? (
										<ButtonLoadingIndicator color="inherit" />
									) : (
										<CloudUploadIcon />
									)
								}
								disabled={
									isPushing ||
									updateGameMutation.isPending ||
									(!effectivePushBgm &&
										!effectivePushVndb &&
										!effectivePushHikarinagi &&
										!effectivePushKun)
								}
								onClick={handlePush}
								sx={{
									minWidth: 220,
									px: 3,
									py: 1,
									borderRadius: 999,
									fontWeight: 700,
								}}
							>
								{t("pages.Detail.Review.push", "推送到选定站点")}
							</Button>
						</Stack>
					</Stack>

					{showBgmRoundNotice && (
						<Alert severity="info" sx={{ mt: 2 }}>
							{t(
								"pages.Detail.Review.bgmRoundNotice",
								"BGM 将按 {{rating}} 分推送",
								{ rating: bgmRate },
							)}
						</Alert>
					)}
					{showHikarinagiRoundNotice && (
						<Alert severity="info" sx={{ mt: 2 }}>
							{t(
								"pages.Detail.Review.hikarinagiRoundNotice",
								"Hikarinagi 将按 {{rating}} 分推送",
								{ rating: hikarinagiRate },
							)}
						</Alert>
					)}
					{showKunRoundNotice && (
						<Alert severity="info" sx={{ mt: 2 }}>
							{t(
								"pages.Detail.Review.kunRoundNotice",
								"Kungal 将按 {{rating}} 分推送",
								{ rating: kunRate },
							)}
						</Alert>
					)}

					{pushResults.length > 0 && (
						<Stack spacing={1} sx={{ mt: 2 }}>
							{pushResults.map((result) => (
								<Alert
									key={result.source}
									severity={result.success ? "success" : "error"}
								>
									{result.success
										? t("pages.Detail.Review.pushTargetSuccess", {
												source: getSourceLabel(result.source),
												defaultValue: "{{source}} 推送成功",
											})
										: t("pages.Detail.Review.pushTargetFailed", {
												source: getSourceLabel(result.source),
												message: result.error
													? getUserErrorMessage(result.error, t)
													: t("errors.requestFailed", "请求失败，请稍后重试"),
												defaultValue: "{{source}} 推送失败：{{message}}",
											})}
								</Alert>
							))}
						</Stack>
					)}
				</Box>
			</Stack>
		</Box>
	);
};
