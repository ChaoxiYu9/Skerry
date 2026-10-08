import ContentPasteIcon from "@mui/icons-material/ContentPaste";
import FileOpenIcon from "@mui/icons-material/FileOpen";
import ImageSearchIcon from "@mui/icons-material/ImageSearch";
import TravelExploreIcon from "@mui/icons-material/TravelExplore";
import {
	Alert,
	Box,
	Button,
	CircularProgress,
	IconButton,
	InputAdornment,
	Stack,
	TextField,
	ToggleButton,
	ToggleButtonGroup,
	Typography,
} from "@mui/material";
import { convertFileSrc } from "@tauri-apps/api/core";
import { sep } from "@tauri-apps/api/path";
import { join } from "pathe";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useProxyImageUrlResolver } from "@/hooks/common/useProxyImageUrlResolver";
import { useGameStaff } from "@/hooks/queries/useGameStaff";
import { REGISTERED_SOURCE_KEYS } from "@/metadata";
import {
	buildGameInfoUpdatePayload,
	buildMetadataUpdatePayload,
} from "@/metadata/data/metadata";
import { getSourceDisplayFields } from "@/metadata/data/displayMergeRules";
import {
	createGameCandidate,
	mergeCandidateSources,
} from "@/metadata/sourceCandidate";
import {
	getSourceImageMap,
	getSourceImageOptions,
	resolveSourceImage,
} from "@/metadata/data/sourceImage";
import { getSourceData } from "@/metadata/sourceRecord";
import { normalizeEditableSourceId } from "@/metadata/sourceIds";
import {
	EDITABLE_STAFF_ROLES,
	GameMetadataEditForm,
	type GameMetadataEditValues,
	type GameMetadataStaffInputs,
} from "@/pages/NextUpDetail/GameMetadataEditForm";
import { snackbar } from "@/providers/snackBar";
import {
	handleLaunchFile,
	splitExecutablePath,
} from "@/services/fs/fileDialog";
import {
	deleteGameCustomCovers,
	getFileExtension,
	selectImageFile,
	uploadSelectedImage,
} from "@/services/game/customCover";
import { fileService } from "@/services/invoke";
import { createMetadataSession } from "@/services/requestContext";
import { withMetadataAuth } from "@/services/metadataAuth";
import { stringArraysEqual } from "./gameInfoEditData";
import { type NextUpVirtualGame } from "@/store/appStore";
import {
	deleteNextUpAsset,
	getNextUpAssetUrl,
	importNextUpAsset,
} from "@/pages/Home/nextUpAssets";
import type {
	BannerFocus,
	FullGameData,
	GameData,
	GameStaffMember,
	SourceType,
	UpdateGameParams,
} from "@/types";
import { getUserErrorMessage } from "@/utils/errors";
import {
	getcustomCoverFolder,
	getGameBanner,
	getGameCover,
	getGameDisplayName,
	getGameNsfwStatus,
} from "@/utils/game";
import { formatSteamAppIdWithPath } from "@/utils/steam";
import { isInvalidExecutableName } from "./gameInfoEditData";
import { SourceCoverDialog } from "./SourceCoverDialog";
import {
	SummarySourceDialog,
	type SummarySourceState,
} from "./SummarySourceDialog";
import { SteamLaunchAssociationDialog } from "./SteamLaunchAssociationDialog";
import { useSteamAssociation } from "./useSteamAssociation";

interface LibraryGameEditProps {
	selectedGame: GameData;
	rawGame?: FullGameData;
	onSave: (data: UpdateGameParams) => Promise<FullGameData>;
	beforeSections?: ReactNode;
	virtualGame?: NextUpVirtualGame;
}

const EMPTY_STAFF: GameMetadataStaffInputs = {
	writer: "",
	composer: "",
	artist: "",
	director: "",
};
const EMPTY_STAFF_MEMBERS: readonly GameStaffMember[] = [];
const EMPTY_SUMMARY_SOURCE_STATES: Partial<Record<SourceType, SummarySourceState>> = {};
const DEFAULT_BANNER_FOCUS: BannerFocus = { x: 50, y: 50 };

const clampBannerFocus = (value: unknown): number => {
	const numeric =
		typeof value === "number" && Number.isFinite(value) ? value : 50;
	return Math.min(100, Math.max(0, numeric));
};

const normalizeBannerFocus = (focus?: BannerFocus | null): BannerFocus => ({
	x: clampBannerFocus(focus?.x),
	y: clampBannerFocus(focus?.y),
});

const isSameBannerFocus = (
	a: BannerFocus | null | undefined,
	b: BannerFocus | null | undefined,
) => {
	const left = normalizeBannerFocus(a);
	const right = normalizeBannerFocus(b);
	return left.x === right.x && left.y === right.y;
};

const LAUNCH_SECTION_SX = {
	p: { xs: 1.5, md: 2.5 },
	border: 1,
	borderColor: "divider",
	borderRadius: 2,
} as const;

function parseList(value: string): string[] {
	return Array.from(
		new Set(
			value
				.split(/[\t,，\r\n]+/)
				.map((item) => item.trim())
				.filter(Boolean),
		),
	);
}

function toStaffInputs(
	staff: readonly GameStaffMember[],
): GameMetadataStaffInputs {
	return EDITABLE_STAFF_ROLES.reduce(
		(result, role) => {
			result[role] = staff
				.filter((member) => member.roles.includes(role))
				.map((member) => member.name.trim())
				.filter(Boolean)
				.join("\t");
			return result;
		},
		{ ...EMPTY_STAFF },
	);
}

function toStaffMembers(inputs: GameMetadataStaffInputs): GameStaffMember[] {
	const members = new Map<string, GameStaffMember>();
	let nextId = -1;
	for (const role of EDITABLE_STAFF_ROLES) {
		for (const name of inputs[role]
			.split(/[\t\r\n]+/)
			.map((item) => item.trim())
			.filter(Boolean)) {
			const existing = members.get(name);
			if (existing) {
				if (!existing.roles.includes(role)) existing.roles.push(role);
			} else {
				members.set(name, { id: nextId--, name, roles: [role] });
			}
		}
	}
	return [...members.values()];
}

function getInitialValues(
	game: GameData,
	staff: readonly GameStaffMember[],
): GameMetadataEditValues {
	const unifiedTags = getUnifiedTags(game);
	return {
		name: game.custom_data?.name || game.name || getGameDisplayName(game),
		translatedName:
			game.custom_data?.translated_name ||
			game.custom_data?.name_cn ||
			game.name_cn ||
			"",
		nameCn: game.custom_data?.name_cn || game.name_cn || "",
		aliases: game.custom_data?.aliases?.join("\t") ?? "",
		developer: game.developer ?? "",
		date: game.date ?? "",
		nsfw: getGameNsfwStatus(game),
		imageUrl: "",
		bannerUrl: "",
		staff: toStaffInputs(staff),
		summary: game.summary ?? "",
		tags: unifiedTags.join("\t"),
	};
}

/**
 * 统一标签集合：详情页展示的数据源标签 + 本地自定义标签合并去重。
 * 编辑器以此集合为准，保存后详情页与编辑器显示同一套标签。
 */
const getUnifiedTags = (game: GameData): string[] =>
	Array.from(new Set([...(game.tags ?? []), ...(game.custom_data?.tags ?? [])]));

export function LibraryGameEdit({
	selectedGame,
	rawGame,
	onSave,
	beforeSections,
	virtualGame,
}: LibraryGameEditProps) {
	const isVirtualGame = Boolean(virtualGame);
	const { t } = useTranslation();
	const resolveImageUrl = useProxyImageUrlResolver();
	const staffQuery = useGameStaff(selectedGame.sourceIds.bgm);
	const fetchedStaff = staffQuery.data ?? EMPTY_STAFF_MEMBERS;
	const manualStaff = selectedGame.custom_data?.staff;
	const visibleStaff =
		selectedGame.custom_data?.staff_overridden === true ||
		(manualStaff?.length ?? 0) > 0
			? (manualStaff ?? EMPTY_STAFF_MEMBERS)
			: fetchedStaff;
	const sourceImageMap = useMemo(
		() => (rawGame ? getSourceImageMap(rawGame) : {}),
		[rawGame],
	);
	const sourceImageOptions = useMemo(
		() => (rawGame ? getSourceImageOptions(rawGame) : []),
		[rawGame],
	);

	const [values, setValues] = useState(() =>
		getInitialValues(selectedGame, visibleStaff),
	);
	const initialTagsRef = useRef<string[]>(getUnifiedTags(selectedGame));
	const [staffTouched, setStaffTouched] = useState(false);
	const [localPath, setLocalPath] = useState(selectedGame.localpath ?? "");
	const [executable, setExecutable] = useState(selectedGame.executable ?? "");
	const [coverPath, setCoverPath] = useState<string | null>(null);
	const [bannerPath, setBannerPath] = useState<string | null>(null);
	const [bannerFocus, setBannerFocus] = useState<BannerFocus>(
		normalizeBannerFocus(selectedGame.custom_data?.banner_focus),
	);
	const [sourceIds, setSourceIds] = useState<Partial<Record<SourceType, string>>>(
		() =>
			Object.fromEntries(
				REGISTERED_SOURCE_KEYS.map((source) => [
					source,
					selectedGame.sourceIds[source] ?? "",
				]),
			),
	);
	const clipboardTempPathRef = useRef<string | null>(null);
	const [removeCover, setRemoveCover] = useState(false);
	const [removeBanner, setRemoveBanner] = useState(false);
	const [coverSource, setCoverSource] = useState<SourceType | null>(
		selectedGame.custom_data?.cover_source ?? null,
	);
	const [sourceCoverDialogOpen, setSourceCoverDialogOpen] = useState(false);
	const [summarySourceDialogOpen, setSummarySourceDialogOpen] = useState(false);
	const [summarySourceStates, setSummarySourceStates] = useState(
		EMPTY_SUMMARY_SOURCE_STATES,
	);
	const [isSaving, setIsSaving] = useState(false);

	const steam = useSteamAssociation({
		selectedGame,
		gameName: values.name,
		localPath,
		executable,
		onLocalPathChange: setLocalPath,
		onExecutableChange: setExecutable,
	});

	// Reset the editor only when switching games; cache refreshes are handled below.
	// biome-ignore lint/correctness/useExhaustiveDependencies: switching IDs is the reset boundary
	useEffect(() => {
		setValues(getInitialValues(selectedGame, visibleStaff));
		setStaffTouched(false);
		setLocalPath(selectedGame.localpath ?? "");
		setExecutable(selectedGame.executable ?? "");
		setCoverSource(selectedGame.custom_data?.cover_source ?? null);
		setCoverPath(null);
		setBannerPath(null);
		setBannerFocus(
			normalizeBannerFocus(selectedGame.custom_data?.banner_focus),
		);
		setSourceIds(
			Object.fromEntries(
				REGISTERED_SOURCE_KEYS.map((source) => [
					source,
					selectedGame.sourceIds[source] ?? "",
				]),
			),
		);
		setRemoveCover(false);
		setRemoveBanner(false);
	}, [selectedGame.id]);

	const sourceIdSignature = REGISTERED_SOURCE_KEYS.map(
		(source) => selectedGame.sourceIds[source] ?? "",
	).join("|");
	useEffect(() => {
		setSourceIds(
			Object.fromEntries(
				REGISTERED_SOURCE_KEYS.map((source) => [
					source,
					selectedGame.sourceIds[source] ?? "",
				]),
			),
		);
	}, [sourceIdSignature]);

	useEffect(() => {
		if (staffTouched) return;
		setValues((current) => ({
			...current,
			staff: toStaffInputs(visibleStaff),
		}));
	}, [staffTouched, visibleStaff]);

	useEffect(() => {
		return () => {
			const tempPath = clipboardTempPathRef.current;
			if (tempPath) void fileService.deleteFile(tempPath);
		};
	}, []);

	const clearClipboardTemp = async () => {
		const tempPath = clipboardTempPathRef.current;
		clipboardTempPathRef.current = null;
		if (tempPath) await fileService.deleteFile(tempPath);
	};

	const handleChange = (
		field: keyof GameMetadataEditValues,
		value: string | boolean | GameMetadataStaffInputs,
	) => {
		if (field === "staff") setStaffTouched(true);
		setValues((current) => ({ ...current, [field]: value }));
	};

	const selectCover = async () => {
		try {
			const path = await selectImageFile();
			if (!path) return;
			await clearClipboardTemp();
			setCoverPath(path);
			setRemoveCover(false);
		} catch (error) {
			snackbar.error(getUserErrorMessage(error, t));
		}
	};

	const importClipboardCover = async () => {
		try {
			const path = await fileService.importClipboardImageToTemp(
				selectedGame.id,
			);
			await clearClipboardTemp();
			clipboardTempPathRef.current = path;
			setCoverPath(path);
			setRemoveCover(false);
		} catch (error) {
			snackbar.error(getUserErrorMessage(error, t));
		}
	};

	const selectBanner = async () => {
		try {
			const path = await selectImageFile();
			if (!path) return;
			setBannerPath(path);
			setBannerFocus(DEFAULT_BANNER_FOCUS);
			setRemoveBanner(false);
		} catch (error) {
			snackbar.error(getUserErrorMessage(error, t));
		}
	};

	const selectExecutable = async () => {
		try {
			const selection = await handleLaunchFile(localPath);
			if (!selection) return;
			if (selection.launchType === "steam") {
				steam.actions.openAssociation(selection.target);
				return;
			}
			const parts = await splitExecutablePath(selection.path);
			if (parts) {
				setLocalPath(parts.localpath);
				setExecutable(parts.executable);
			}
		} catch (error) {
			snackbar.error(getUserErrorMessage(error, t));
		}
	};

	const fetchSummaryFromSource = async (source: SourceType) => {
		const sourceId = sourceIds[source]?.trim();
		if (!sourceId) return;

		setSummarySourceStates((current) => ({
			...current,
			[source]: { status: "loading" },
		}));

		try {
			const draft = await withMetadataAuth(
				[source],
				(tokens) =>
					createMetadataSession(tokens).getGameById(sourceId, source),
				{
					requireHikarinagi: source === "hikarinagi",
				},
			);
			const sourceData = getSourceData(draft, source);
			const summary = sourceData
				? getSourceDisplayFields(source, sourceData).summary
				: undefined;

			setSummarySourceStates((current) => ({
				...current,
				[source]: { status: "ready", summary },
			}));
		} catch (error) {
			setSummarySourceStates((current) => ({
				...current,
				[source]: {
					status: "error",
					message: getUserErrorMessage(error, t),
				},
			}));
		}
	};

	const virtualBannerPreview = virtualGame
		? getNextUpAssetUrl(virtualGame, "banner")
			|| getGameBanner(selectedGame)
			|| resolveImageUrl(virtualGame.banner)
		: undefined;
	const virtualCoverPreview = virtualGame
		? getNextUpAssetUrl(virtualGame, "cover") || getGameCover(selectedGame)
		: undefined;
	const sourceCoverImage = resolveSourceImage(sourceImageMap, coverSource);
	const coverPreview = coverPath
		? convertFileSrc(coverPath)
		: removeCover ||
				coverSource !== (selectedGame.custom_data?.cover_source ?? null)
			? resolveImageUrl(sourceCoverImage ?? selectedGame.image) ||
				"/images/default.png"
			: virtualCoverPreview || getGameCover(selectedGame);
	const bannerPreview = bannerPath
		? convertFileSrc(bannerPath)
		: removeBanner
			? coverPreview
			: virtualBannerPreview || getGameBanner(selectedGame) || coverPreview;
	const hasEditableBanner = Boolean(
		bannerPath ||
			(!removeBanner &&
				(virtualGame?.bannerAsset || selectedGame.custom_data?.banner)),
	);

	const save = async () => {
		if (!values.name.trim() || isSaving) return;
		if (
			!isVirtualGame &&
			!localPath.trim() &&
			executable.trim()
		) {
			snackbar.error("填写可执行文件时，游戏目录不能为空");
			return;
		}
		if (!isVirtualGame && isInvalidExecutableName(executable)) {
			snackbar.error("可执行文件必须是单个文件名，不能包含路径分隔符");
			return;
		}
		if (
			!isVirtualGame &&
			steam.launchType === "steam" &&
			!steam.steamLaunchId.trim()
		) {
			snackbar.error("请选择 Steam 启动项");
			return;
		}

		setIsSaving(true);
		let newBannerPath: string | null = null;
		try {
			let imageExt: string | null | undefined;
			if (removeCover) {
				if (virtualGame) {
					await deleteNextUpAsset(
						virtualGame.id,
						"cover",
						virtualGame.coverAsset,
					);
				} else {
					await deleteGameCustomCovers(selectedGame.id);
				}
				imageExt = null;
			} else if (coverPath) {
				imageExt = virtualGame
					? await importNextUpAsset(
							virtualGame.id,
							"cover",
							coverPath,
							virtualGame.coverAsset,
						)
					: await uploadSelectedImage(selectedGame.id, coverPath);
			}

			let bannerId: string | null | undefined;
			if (removeBanner) {
				bannerId = null;
			} else if (bannerPath) {
				const extension = getFileExtension(bannerPath) || "png";
				if (virtualGame) {
					bannerId = await importNextUpAsset(
						virtualGame.id,
						"banner",
						bannerPath,
						virtualGame.bannerAsset,
					);
				} else {
					bannerId = `${extension}_${Date.now()}`;
					const destinationPath = join(
						getcustomCoverFolder(selectedGame.id),
						`banner_${selectedGame.id}_${bannerId}`,
					);
					newBannerPath = destinationPath;
					await fileService.copyFile(bannerPath, destinationPath);
				}
			}

			const updates = buildGameInfoUpdatePayload(selectedGame, {
				newLocalPath: localPath,
				newExecutable: executable,
				newLaunchType: steam.launchType,
				newSteamLaunchId:
					steam.launchType === "steam" ? steam.steamLaunchId : "",
				newName: values.name.trim(),
				newTranslatedName: values.translatedName.trim(),
				newNameCn: values.nameCn.trim(),
				newImageExt: imageExt,
				newCoverSource: coverSource,
				newAliases: parseList(values.aliases),
				newSummary: values.summary,
				newTags: parseList(values.tags),
				newDeveloper: values.developer,
				newNsfw: values.nsfw,
				newDate: values.date,
				newStaff: staffTouched ? toStaffMembers(values.staff) : undefined,
			});
			if (
				!stringArraysEqual(parseList(values.tags), initialTagsRef.current) &&
				updates.custom_data
			) {
				updates.custom_data.tags_curated = true;
			}
			const normalizedBannerFocus = normalizeBannerFocus(bannerFocus);
			const currentBannerFocus = normalizeBannerFocus(
				selectedGame.custom_data?.banner_focus,
			);
			const nextBannerId =
				bannerId !== undefined ? bannerId : selectedGame.custom_data?.banner;
			const willHaveCustomBanner = Boolean(nextBannerId);
			const hasBannerFocusChanged =
				willHaveCustomBanner &&
				!isSameBannerFocus(normalizedBannerFocus, currentBannerFocus);
			if (bannerId !== undefined || hasBannerFocusChanged) {
				updates.custom_data = {
					...selectedGame.custom_data,
					...(updates.custom_data ?? {}),
					banner: nextBannerId,
					banner_focus: willHaveCustomBanner ? normalizedBannerFocus : null,
				};
			}

			const nextSourceIds = Object.fromEntries(
				REGISTERED_SOURCE_KEYS.map((source) => [
					source,
					normalizeEditableSourceId(source, sourceIds[source]),
				]),
			) as Record<SourceType, string>;
			const sourceIdChanges = REGISTERED_SOURCE_KEYS.filter(
				(source) =>
					nextSourceIds[source] !== (selectedGame.sourceIds[source] ?? ""),
			);
			if (sourceIdChanges.length > 0) {
				const removedSources = REGISTERED_SOURCE_KEYS.filter(
					(source) =>
						!nextSourceIds[source] && Boolean(selectedGame.sourceIds[source]),
				);

				const fetchSources = sourceIdChanges.filter(
					(source) => Boolean(nextSourceIds[source]),
				);
				if (fetchSources.length > 0) {
					const fetchedDrafts = await withMetadataAuth(
						fetchSources,
						(tokens) =>
							Promise.all(
								fetchSources.map((source) =>
									createMetadataSession(tokens).getGameById(
										nextSourceIds[source],
										source,
									),
								),
							),
						{
							requireHikarinagi: fetchSources.includes("hikarinagi"),
						},
					);
					const mergedDraft = createGameCandidate({
						idType: "mixed",
						sources: mergeCandidateSources(fetchedDrafts),
					});
					const sourcePayload = buildMetadataUpdatePayload(
						mergedDraft,
						[],
						rawGame?.sources ?? [],
						selectedGame?.custom_data,
					);
					if (sourcePayload.id_type) updates.id_type = sourcePayload.id_type;
					if (sourcePayload.date) updates.date = sourcePayload.date;
					if (sourcePayload.upsert_sources)
						updates.upsert_sources = sourcePayload.upsert_sources;
					if (sourcePayload.custom_data) {
						updates.custom_data = {
							...(selectedGame?.custom_data ?? {}),
							...(updates.custom_data ?? {}),
							...(sourcePayload.custom_data ?? {}),
						};
					}
				}

				if (removedSources.length > 0)
					updates.remove_sources = [...removedSources];
				if (
					!REGISTERED_SOURCE_KEYS.some((source) => nextSourceIds[source]) &&
					(selectedGame.id_type === "bgm" || selectedGame.id_type === "vndb")
				) {
					updates.id_type = "custom";
				}
			}
			if (Object.keys(updates).length === 0) return;

			const updatedGame = await onSave(updates);
			if (
				virtualGame &&
				bannerId !== undefined &&
				virtualGame.bannerAsset &&
				!bannerPath
			) {
				await deleteNextUpAsset(virtualGame.id, "banner", virtualGame.bannerAsset);
			} else {
				const oldBanner = selectedGame.custom_data?.banner;
				const shouldDeleteOldBanner =
					!virtualGame && bannerId !== undefined && oldBanner;
				if (shouldDeleteOldBanner) {
					await fileService.deleteFile(
						join(
							getcustomCoverFolder(selectedGame.id),
							`banner_${selectedGame.id}_${oldBanner}`,
						),
					);
				}
			}
			await clearClipboardTemp();
			setCoverPath(null);
			setBannerPath(null);
			setBannerFocus(
				normalizeBannerFocus(updatedGame.custom_data?.banner_focus),
			);
			setSourceIds(nextSourceIds);
			setRemoveCover(false);
			setRemoveBanner(false);
			setStaffTouched(false);
			snackbar.success(t("pages.Detail.Edit.updateSuccess", "游戏信息已保存"));
		} catch (error) {
			if (newBannerPath) await fileService.deleteFile(newBannerPath);
			snackbar.error(getUserErrorMessage(error, t));
		} finally {
			setIsSaving(false);
		}
	};

	const coverActions = (
		<>
			<Button
				size="small"
				variant="outlined"
				startIcon={<ContentPasteIcon />}
				onClick={() => void importClipboardCover()}
			>
				从剪贴板导入
			</Button>
			{sourceImageOptions.length > 0 ? (
				<Button
					size="small"
					variant="outlined"
					startIcon={<ImageSearchIcon />}
					onClick={() => setSourceCoverDialogOpen(true)}
				>
					数据源封面
				</Button>
			) : null}
		</>
	);

	const summaryActions = (
		<Button
			size="small"
			variant="outlined"
			startIcon={<TravelExploreIcon />}
			disabled={isSaving}
			onClick={() => {
				setSummarySourceStates(EMPTY_SUMMARY_SOURCE_STATES);
				setSummarySourceDialogOpen(true);
			}}
		>
			简介获取源
		</Button>
	);

	const launchSettings = (
		<Box sx={LAUNCH_SECTION_SX}>
			<Typography variant="h6" fontWeight={700} sx={{ mb: 2 }}>
				启动设置
			</Typography>
			<Stack spacing={2}>
				<ToggleButtonGroup
					exclusive
					value={steam.launchType}
					onChange={(_, value) => steam.actions.handleLaunchTypeChange(value)}
					size="small"
					fullWidth
					sx={{
						minWidth: 0,
						"& .MuiToggleButton-root": {
							minWidth: 0,
							flex: "1 1 0",
							whiteSpace: "nowrap",
						},
					}}
				>
					<ToggleButton value="local">本地程序</ToggleButton>
					<ToggleButton value="steam">
						{steam.dialog.scanning ? <CircularProgress size={16} /> : "Steam"}
					</ToggleButton>
				</ToggleButtonGroup>
				{steam.launchType === "steam" ? (
					<Stack spacing={1}>
						{steam.steamLaunchId ? (
							<Alert severity="success">
								{formatSteamAppIdWithPath(steam.steamLaunchId, localPath)}
							</Alert>
						) : (
							<Alert severity="info">尚未关联 Steam 启动项</Alert>
						)}
						<Button
							variant="outlined"
							onClick={() => steam.actions.openAssociation()}
						>
							选择或更换 Steam 游戏
						</Button>
					</Stack>
				) : null}
				<Box
					sx={{
						display: "grid",
						gridTemplateColumns: {
							xs: "1fr",
							sm: "minmax(0, 1.6fr) minmax(0, 1fr)",
						},
						gap: { xs: 1.5, sm: 2 },
						minWidth: 0,
					}}
				>
					<TextField
						label="游戏目录"
						value={localPath}
						onChange={(event) => setLocalPath(event.target.value)}
						fullWidth
						sx={{ minWidth: 0 }}
						slotProps={{
							input: {
								endAdornment: (
									<InputAdornment position="end">{sep()}</InputAdornment>
								),
							},
						}}
					/>
					<TextField
						label="可执行文件"
						value={executable}
						onChange={(event) => setExecutable(event.target.value)}
						error={isInvalidExecutableName(executable)}
						fullWidth
						sx={{ minWidth: 0 }}
						slotProps={{
							input: {
								endAdornment:
									steam.launchType === "local" ? (
										<InputAdornment position="end">
											<IconButton
												size="small"
												edge="end"
												onClick={() => void selectExecutable()}
											>
												<FileOpenIcon />
											</IconButton>
										</InputAdornment>
									) : undefined,
							},
						}}
					/>
				</Box>
			</Stack>
		</Box>
	);

	return (
		<>
			<GameMetadataEditForm
				values={values}
				onChange={handleChange}
				coverPreview={coverPreview}
				bannerPreview={bannerPreview}
				bannerFocus={hasEditableBanner ? bannerFocus : undefined}
				onBannerFocusChange={hasEditableBanner ? setBannerFocus : undefined}
				sourceIds={sourceIds}
				onSourceIdChange={(source, value) =>
					setSourceIds((current) => ({ ...current, [source]: value }))
				}
				onSelectCover={() => void selectCover()}
				onRemoveCover={() => {
					setCoverPath(null);
					setRemoveCover(true);
				}}
				canRemoveCover={Boolean(
					virtualGame?.coverAsset ||
						selectedGame.custom_data?.image ||
						coverPath,
				)}
				onSelectBanner={() => void selectBanner()}
				onRemoveBanner={() => {
					setBannerPath(null);
					setBannerFocus(DEFAULT_BANNER_FOCUS);
					setRemoveBanner(true);
				}}
				canRemoveBanner={Boolean(
					virtualGame?.bannerAsset ||
						selectedGame.custom_data?.banner ||
						bannerPath,
				)}
				coverActions={coverActions}
				summaryActions={summaryActions}
				beforeSections={beforeSections}
				afterSections={isVirtualGame ? undefined : launchSettings}
				showChineseName
				showImageUrls={false}
				nameLabel="游戏原名"
				isSaving={isSaving}
				onSave={() => void save()}
			/>
			{steam.dialog.open ? (
				<SteamLaunchAssociationDialog
					open
					currentLocalPath={localPath}
					initialTarget={steam.dialog.initialTarget}
					initialScanResult={steam.dialog.scanResult}
					onScanResult={steam.dialog.setScanResult}
					onClose={steam.actions.closeDialog}
					onConfirm={steam.actions.confirmAssociation}
				/>
			) : null}
			<SourceCoverDialog
				open={sourceCoverDialogOpen}
				options={sourceImageOptions}
				currentSource={coverSource}
				hasCustomCover={Boolean(
					(virtualGame?.coverAsset || selectedGame.custom_data?.image) &&
						!removeCover,
				)}
				disabled={isSaving}
				onClose={() => setSourceCoverDialogOpen(false)}
				onSelect={(source) => {
					setCoverSource(source);
					setSourceCoverDialogOpen(false);
				}}
				onReset={() => {
					setCoverSource(null);
					setSourceCoverDialogOpen(false);
				}}
			/>
			<SummarySourceDialog
				open={summarySourceDialogOpen}
				sourceIds={sourceIds}
				states={summarySourceStates}
				disabled={isSaving}
				onClose={() => setSummarySourceDialogOpen(false)}
				onFetch={(source) => void fetchSummaryFromSource(source)}
				onSelect={(_source, summary) => {
					handleChange("summary", summary);
					setSummarySourceDialogOpen(false);
				}}
			/>
		</>
	);
}
