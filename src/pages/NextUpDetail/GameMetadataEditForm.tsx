import DeleteIcon from "@mui/icons-material/Delete";
import PhotoCameraIcon from "@mui/icons-material/PhotoCamera";
import SaveIcon from "@mui/icons-material/Save";
import {
	Box,
	Button,
	CircularProgress,
	FormControlLabel,
	InputAdornment,
	Stack,
	Switch,
	TextField,
	Typography,
} from "@mui/material";
import { type PointerEvent, type ReactNode, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
	getSourceIdInputValue,
	normalizeEditableSourceId,
} from "@/metadata/sourceIds";
import { isDeprecatedSource } from "@/metadata/constants";
import { SkerryDatePicker } from "@/components/ui/SkerryDatePicker";
import { SOURCE_TYPES, type BannerFocus, type GameStaffRole, type SourceType } from "@/types";

export const EDITABLE_STAFF_ROLES: readonly GameStaffRole[] = [
	"writer",
	"composer",
	"artist",
	"director",
];

export type GameMetadataStaffInputs = Record<GameStaffRole, string>;
export interface GameMetadataEditValues {
	name: string;
	translatedName: string;
	nameCn: string;
	aliases: string;
	developer: string;
	date: string;
	nsfw: boolean;
	imageUrl: string;
	bannerUrl: string;
	staff: GameMetadataStaffInputs;
	summary: string;
	tags: string;
}

interface GameMetadataEditFormProps {
	values: GameMetadataEditValues;
	onChange: (
		field: keyof GameMetadataEditValues,
		value: string | boolean | GameMetadataStaffInputs,
	) => void;
	coverPreview?: string;
	bannerPreview?: string;
	onSelectCover: () => void;
	onRemoveCover: () => void;
	canRemoveCover: boolean;
	onSelectBanner?: () => void;
	onRemoveBanner: () => void;
	canRemoveBanner: boolean;
	bannerFocus?: BannerFocus;
	onBannerFocusChange?: (focus: BannerFocus) => void;
	sourceIds?: Partial<Record<SourceType, string>>;
	onSourceIdChange?: (source: SourceType, value: string) => void;
	coverActions?: ReactNode;
	summaryActions?: ReactNode;
	beforeSections?: ReactNode;
	afterSections?: ReactNode;
	showChineseName?: boolean;
	showImageUrls?: boolean;
	nameLabel?: string;
	isSaving: boolean;
	onSave: () => void;
}

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

const SOURCE_ID_LABELS: Record<SourceType, string> = {
	bgm: "BGM",
	vndb: "VNDB",
	hikarinagi: "Hikarinagi",
	ymgal: "YMGal",
	kun: "Kungal",
	dlsite: "DLsite",
	erogamescape: "ErogameScape",
};

export function GameMetadataEditForm({
	values,
	onChange,
	coverPreview,
	bannerPreview,
	onSelectCover,
	onRemoveCover,
	canRemoveCover,
	onRemoveBanner,
	canRemoveBanner,
	bannerFocus,
	onBannerFocusChange,
	sourceIds,
	onSourceIdChange,
	coverActions,
	summaryActions,
	beforeSections,
	afterSections,
	showChineseName = true,
	showImageUrls = true,
	nameLabel,
	isSaving,
	onSave,
}: GameMetadataEditFormProps) {
	const { t } = useTranslation();
	const bannerFrameRef = useRef<HTMLDivElement | null>(null);
	const bannerFocusFrameRef = useRef<number | null>(null);
	const pendingBannerFocusRef = useRef<BannerFocus | null>(null);
	const bannerDragRef = useRef<{
		pointerId: number;
		startX: number;
		startY: number;
		startFocus: BannerFocus;
	} | null>(null);

	const updateStaff = (role: GameStaffRole, value: string) => {
		onChange("staff", { ...values.staff, [role]: value });
	};

	useEffect(() => {
		return () => {
			if (bannerFocusFrameRef.current !== null) {
				window.cancelAnimationFrame(bannerFocusFrameRef.current);
				bannerFocusFrameRef.current = null;
			}
		};
	}, []);

	const scheduleBannerFocusChange = (nextFocus: BannerFocus) => {
		if (!onBannerFocusChange) return;
		pendingBannerFocusRef.current = nextFocus;
		if (bannerFocusFrameRef.current !== null) return;
		bannerFocusFrameRef.current = window.requestAnimationFrame(() => {
			bannerFocusFrameRef.current = null;
			const focus = pendingBannerFocusRef.current;
			pendingBannerFocusRef.current = null;
			if (focus) onBannerFocusChange(focus);
		});
	};

	const flushPendingBannerFocus = () => {
		if (bannerFocusFrameRef.current !== null) {
			window.cancelAnimationFrame(bannerFocusFrameRef.current);
			bannerFocusFrameRef.current = null;
		}
		const focus = pendingBannerFocusRef.current;
		pendingBannerFocusRef.current = null;
		if (focus) onBannerFocusChange?.(focus);
	};

	const handleBannerPointerDown = (event: PointerEvent<HTMLDivElement>) => {
		if (!bannerFocus || !onBannerFocusChange || !bannerPreview) return;
		bannerDragRef.current = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			startFocus: bannerFocus,
		};
		event.currentTarget.setPointerCapture(event.pointerId);
	};

	const handleBannerPointerMove = (event: PointerEvent<HTMLDivElement>) => {
		const drag = bannerDragRef.current;
		const frame = bannerFrameRef.current;
		if (
			!drag ||
			drag.pointerId !== event.pointerId ||
			!frame ||
			!onBannerFocusChange
		)
			return;
		event.preventDefault();
		const rect = frame.getBoundingClientRect();
		scheduleBannerFocusChange({
			x: Math.min(
				100,
				Math.max(
					0,
					drag.startFocus.x - ((event.clientX - drag.startX) / rect.width) * 75,
				),
			),
			y: Math.min(
				100,
				Math.max(
					0,
					drag.startFocus.y -
						((event.clientY - drag.startY) / rect.height) * 75,
				),
			),
		});
	};

	const handleBannerPointerUp = (event: PointerEvent<HTMLDivElement>) => {
		if (bannerDragRef.current?.pointerId === event.pointerId) {
			bannerDragRef.current = null;
			flushPendingBannerFocus();
			if (event.currentTarget.hasPointerCapture(event.pointerId)) {
				event.currentTarget.releasePointerCapture(event.pointerId);
			}
		}
	};

	return (
		<Stack className="detail-glass-form" spacing={3}>
			{beforeSections}

			<Box sx={SECTION_SX}>
				<Typography variant="h6" fontWeight={700} sx={{ mb: 2 }}>
					{t("pages.Detail.GameInfoEdit.coverAndBasicInfo", "封面与基本信息")}
				</Typography>
				<Box
					sx={{
						display: "grid",
						gridTemplateColumns: { xs: "1fr", md: "220px minmax(0, 1fr)" },
						gap: 3,
					}}
				>
					<Stack spacing={1}>
						<Box
							component={coverPreview ? "img" : "div"}
							src={coverPreview}
							alt=""
							sx={{
								width: "100%",
								aspectRatio: "2 / 3",
								objectFit: "cover",
								bgcolor: "action.hover",
								borderRadius: 1,
								border: 1,
								borderColor: "divider",
							}}
						/>
						<Button
							size="small"
							variant="outlined"
							startIcon={<PhotoCameraIcon />}
							onClick={onSelectCover}
						>
							{t("pages.Detail.GameInfoEdit.selectLocalImage", "导入本地封面")}
						</Button>
						{coverActions}
						{canRemoveCover ? (
							<Button
								size="small"
								color="error"
								startIcon={<DeleteIcon />}
								onClick={onRemoveCover}
							>
								{t(
									"pages.Detail.GameInfoEdit.removeCustomCover",
									"移除自定义封面",
								)}
							</Button>
						) : null}
					</Stack>
					<Stack spacing={2}>
						<TextField
							label={
								nameLabel || t("pages.Detail.GameInfoEdit.customGameName", "游戏原名")
							}
							value={values.name}
							onChange={(event) => onChange("name", event.target.value)}
							fullWidth
						/>
						<TextField
							label={t("pages.Detail.GameInfoEdit.customTranslatedName", "游戏译名")}
							value={values.translatedName}
							onChange={(event) => {
								const val = event.target.value;
								onChange("translatedName", val);
								if (/[\u4e00-\u9fa5]/.test(val)) {
									onChange("nameCn", val);
								}
							}}
							fullWidth
						/>
						{showChineseName ? (
							<TextField
								label={t("pages.Detail.GameInfoEdit.customChineseName", "中文译名")}
								value={values.nameCn}
								onChange={(event) => onChange("nameCn", event.target.value)}
								fullWidth
							/>
						) : null}
						<TextField
							label={t("pages.Detail.GameInfoEdit.developer", "开发商")}
							value={values.developer}
							onChange={(event) => onChange("developer", event.target.value)}
							fullWidth
						/>
						<SkerryDatePicker
							label={t("pages.Detail.GameInfoEdit.releaseDate", "发行日期")}
							value={values.date}
							onChange={(val) => onChange("date", val)}
							fullWidth
						/>
						<FormControlLabel
							control={
								<Switch
									checked={values.nsfw}
									onChange={(event) => onChange("nsfw", event.target.checked)}
									color="warning"
								/>
							}
							label={t("pages.Detail.GameInfoEdit.nsfw", "NSFW (18+)")}
						/>
					</Stack>
				</Box>
			</Box>

			<Box sx={SECTION_SX}>
				<Typography variant="h6" fontWeight={700} sx={{ mb: 2 }}>
					{t("pages.Detail.editBanner", "横幅图")}
				</Typography>
				<Box
					ref={bannerFrameRef}
					onPointerDown={handleBannerPointerDown}
					onPointerMove={handleBannerPointerMove}
					onPointerUp={handleBannerPointerUp}
					onPointerCancel={handleBannerPointerUp}
					sx={{
						position: "relative",
						display: "block",
						width: "100%",
						aspectRatio: "16 / 9",
						maxHeight: 420,
						overflow: "hidden",
						cursor: bannerFocus && onBannerFocusChange ? "grab" : "default",
						touchAction: "none",
						userSelect: "none",
						bgcolor: "action.hover",
						borderRadius: 1,
						border: 1,
						borderColor: "divider",
						mb: bannerFocus && onBannerFocusChange ? 1 : 1.5,
					}}
				>
					{bannerPreview ? (
						<Box
							component="img"
							src={bannerPreview}
							alt=""
							draggable={false}
							sx={{
								display: "block",
								width: "100%",
								height: "100%",
								objectFit: "cover",
								objectPosition: bannerFocus
									? `${bannerFocus.x}% ${bannerFocus.y}%`
									: "center",
							}}
						/>
					) : null}
					{bannerFocus && onBannerFocusChange ? (
						<Box
							aria-hidden="true"
							sx={{
								position: "absolute",
								inset: 0,
								border: "1px solid rgba(255,255,255,.42)",
								boxShadow: "inset 0 0 0 1px rgba(15,45,90,.28)",
								pointerEvents: "none",
							}}
						/>
					) : null}
				</Box>
				{bannerFocus && onBannerFocusChange ? (
					<Stack
						direction="row"
						alignItems="center"
						justifyContent="space-between"
						spacing={1}
						sx={{ mb: 1.5 }}
					>
						<Typography variant="caption" color="text.secondary">
							拖动图片调整横幅焦点
						</Typography>
						<Button
							size="small"
							variant="text"
							onClick={() => onBannerFocusChange({ x: 50, y: 50 })}
						>
							重置居中
						</Button>
					</Stack>
				) : null}
				{canRemoveBanner ? (
					<Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
						<Button
							size="small"
							color="error"
							startIcon={<DeleteIcon />}
							onClick={onRemoveBanner}
						>
							移除自定义横幅
						</Button>
					</Stack>
				) : null}
				{showImageUrls ? (
					<Box
						sx={{
							display: "grid",
							gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" },
							gap: 2,
							mt: 2,
						}}
					>
						<TextField
							label={t("pages.Detail.GameInfoEdit.coverUrl", "封面图片地址")}
							value={values.imageUrl}
							onChange={(event) => onChange("imageUrl", event.target.value)}
							fullWidth
						/>
						<TextField
							label="横幅图片地址"
							value={values.bannerUrl}
							onChange={(event) => onChange("bannerUrl", event.target.value)}
							fullWidth
						/>
					</Box>
				) : null}
			</Box>

			{sourceIds && onSourceIdChange ? (
				<Box sx={SECTION_SX}>
					<Typography variant="h6" fontWeight={700} sx={{ mb: 2 }}>
						数据源编号
					</Typography>
					<Box
						sx={{
							display: "grid",
							gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" },
							gap: 2,
						}}
					>
						{SOURCE_TYPES.filter((source) => !isDeprecatedSource(source)).map((source) => {
							const prefix = source === "vndb" ? "v" : source === "ymgal" ? "ga" : null;
							const placeholder =
								source === "vndb"
									? "例如 v12345"
									: source === "ymgal"
										? "例如 ga12345"
										: source === "dlsite"
											? "例如 RJ123456 / VJ123456"
											: "例如 123456";
							return (
								<TextField
									key={source}
									label={`${SOURCE_ID_LABELS[source]} 编号`}
									placeholder={placeholder}
									value={getSourceIdInputValue(source, sourceIds[source])}
									onChange={(event) =>
										onSourceIdChange(
											source,
											normalizeEditableSourceId(source, event.target.value),
										)
									}
									autoComplete="off"
									spellCheck={false}
									inputProps={{
										autoComplete: "off",
										spellCheck: false,
										inputMode: source === "dlsite" ? "text" : "numeric",
										pattern: source === "dlsite" ? "[A-Za-z0-9]*" : "[0-9]*",
									}}
									InputProps={
										prefix
											? {
													startAdornment: (
														<InputAdornment position="start">
															<Typography
																component="span"
																variant="body2"
																fontWeight={800}
																sx={{
																	color: "primary.main",
																	fontFamily: "monospace",
																	lineHeight: 1,
																}}
															>
																{prefix}
															</Typography>
														</InputAdornment>
													),
												}
											: undefined
									}
									fullWidth
								/>
							);
						})}
					</Box>
					<Typography
						variant="caption"
						color="text.secondary"
						sx={{ display: "block", mt: 1 }}
					>
						填入编号后保存，会自动拉取该数据源资料；更新资料源也会同步这里的编号。
					</Typography>
				</Box>
			) : null}

			<Box sx={SECTION_SX}>
				<Typography variant="h6" fontWeight={700} sx={{ mb: 2 }}>
					{t("pages.Detail.GameInfoEdit.staff", "制作人员")}
				</Typography>
				<Box
					sx={{
						display: "grid",
						gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" },
						gap: 2,
					}}
				>
					{EDITABLE_STAFF_ROLES.map((role) => (
						<TextField
							key={role}
							label={t(`pages.Detail.staffRoles.${role}`, role)}
							value={values.staff[role]}
							onChange={(event) => updateStaff(role, event.target.value)}
							onKeyDown={(event) => {
								if (event.key !== "Tab") return;
								event.preventDefault();
								const input = event.target as HTMLInputElement;
								const start = input.selectionStart ?? input.value.length;
								const end = input.selectionEnd ?? start;
								updateStaff(
									role,
									`${input.value.slice(0, start)}\t${input.value.slice(end)}`,
								);
								requestAnimationFrame(() => {
									input.selectionStart = start + 1;
									input.selectionEnd = start + 1;
								});
							}}
							placeholder="多人请用 Tab 分隔"
							fullWidth
						/>
					))}
				</Box>
			</Box>

		<Box sx={SECTION_SX}>
			<Stack
				direction="row"
				spacing={1}
				alignItems="center"
				justifyContent="space-between"
				sx={{ mb: 2 }}
			>
				<Typography variant="h6" fontWeight={700}>
					{t("pages.Detail.GameInfoEdit.descriptionAndTags", "简介与标签")}
				</Typography>
				{summaryActions}
			</Stack>
			<Stack spacing={2}>
					<TextField
						label={t("pages.Detail.GameInfoEdit.summary", "游戏简介")}
						value={values.summary}
						onChange={(event) => onChange("summary", event.target.value)}
						multiline
						minRows={6}
						fullWidth
					/>
					<TextField
						label={t("pages.Detail.GameInfoEdit.tags", "标签")}
						value={values.tags}
						onChange={(event) => onChange("tags", event.target.value)}
						helperText="使用 Tab、逗号或换行分隔"
						fullWidth
					/>
				</Stack>
			</Box>

			{afterSections}

			<Button
				variant="contained"
				size="large"
				fullWidth
				startIcon={
					isSaving ? (
						<CircularProgress size={20} color="inherit" />
					) : (
						<SaveIcon />
					)
				}
				disabled={!values.name.trim() || isSaving}
				onClick={onSave}
			>
				{isSaving
					? t("pages.Detail.GameInfoEdit.saving", "保存中...")
					: t("pages.Detail.GameInfoEdit.saveAllChanges", "保存所有更改")}
			</Button>
		</Stack>
	);
}
