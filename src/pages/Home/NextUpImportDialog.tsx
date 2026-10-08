import AddIcon from "@mui/icons-material/Add";
import SearchIcon from "@mui/icons-material/Search";
import {
	Alert,
	Box,
	Button,
	CircularProgress,
	Dialog,
	DialogActions,
	DialogContent,
	DialogTitle,
	InputAdornment,
	LinearProgress,
	TextField,
	Typography,
} from "@mui/material";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import GameSelectDialog from "@/components/AddModal/GameSelectDialog";
import MixedSourceConfirmDialog from "@/components/AddModal/MixedSourceConfirmDialog";
import {
	type MetadataMatchMode,
	MetadataMatchModeToggleGroup,
	SingleSourceSelect,
} from "@/components/AddModal/SourceMatchControls";
import { useMetadataSearchFlow } from "@/hooks/features/games/useMetadataSearchFlow";
import { SEARCHABLE_SOURCE_KEYS } from "@/metadata";
import {
	applyCustomDataOverride,
	applyMixedSourceDisplay,
	applySingleSourceDisplay,
	getSourceDisplayFields,
} from "@/metadata/data/displayMergeRules";
import { formatVndbId, normalizeEditableSourceId } from "@/metadata/sourceIds";
import type { SourceDataMap } from "@/metadata/sourceRecord";
import type { NextUpVirtualGame } from "@/store/appStore";
import type { GameData, GameMetadataDraft, SourceType } from "@/types";
import { isSourceType } from "@/types";
import { createAbortableRunner, isAbortError } from "@/utils/async";

const REQUEST_TIMEOUT_MS = 100000;

interface NextUpImportDialogProps {
	open: boolean;
	onClose: () => void;
	onImport: (game: Omit<NextUpVirtualGame, "id">) => void;
	onImportDraft?: (draft: GameMetadataDraft) => void;
	initialSourceIds?: Partial<Record<SourceType, string>>;
	initialQuery?: string;
	title?: string;
}

function buildVirtualGame(
	draft: GameMetadataDraft,
): Omit<NextUpVirtualGame, "id"> {
	const display: GameData = { id: 0, sourceIds: {}, tags: [] };
	const sourceData: SourceDataMap = Object.fromEntries(
		draft.sources.map((record) => [record.source, record.data]),
	);

	if (draft.id_type && isSourceType(draft.id_type)) {
		const data = sourceData[draft.id_type];
		if (data) applySingleSourceDisplay(display, draft.id_type, data);
	} else {
		applyMixedSourceDisplay(
			display,
			sourceData,
			draft.custom_data?.cover_source ?? undefined,
		);
	}
	if (draft.custom_data) applyCustomDataOverride(display, draft.custom_data);

	const sourceKey = draft.sources
		.map((record) => `${record.source}:${record.external_id}`)
		.sort()
		.join("|");
	const name = display.name || display.name_cn || "未命名游戏";
	const date = draft.sources
		.map((record) => getSourceDisplayFields(record.source, record.data).date)
		.find(Boolean);

	return {
		name,
		nameCn: display.name_cn,
		image: display.image,
		aliases: display.aliases,
		developer: display.developer,
		summary: display.summary,
		tags: display.tags,
		score: display.score,
		date,
		nsfw: display.nsfw,
		staff: draft.custom_data?.staff ?? undefined,
		sources: draft.sources.map((record) => ({
			source: record.source,
			externalId: record.external_id,
		})),
		idType: draft.id_type,
		sourceRecords: draft.sources,
		sourceKey: sourceKey || `metadata:${name}`,
	};
}

export function NextUpImportDialog({
	open,
	onClose,
	onImport,
	onImportDraft,
	initialSourceIds,
	initialQuery,
	title,
}: NextUpImportDialogProps) {
	const { t } = useTranslation();
	const [query, setQuery] = useState("");
	const [mode, setMode] = useState<MetadataMatchMode>("mixed");
	const [source, setSource] = useState<SourceType>(
		SEARCHABLE_SOURCE_KEYS[0] as SourceType,
	);
	const [error, setError] = useState("");
	const abortControllerRef = useRef<AbortController | null>(null);
	const getSourceQuery = useCallback(
		(targetSource: SourceType): string => {
			const rawId = initialSourceIds?.[targetSource];
			const normalized = normalizeEditableSourceId(targetSource, rawId);
			if (normalized && normalized.trim().length > 0) {
				return normalized.trim();
			}
			return initialQuery?.trim() ?? "";
		},
		[initialSourceIds, initialQuery],
	);

	const handleSourceChange = useCallback(
		(nextSource: SourceType) => {
			setSource(nextSource);
			setQuery(getSourceQuery(nextSource));
		},
		[getSourceQuery],
	);

	const handleResolved = useCallback(
		(game: GameMetadataDraft) => {
			if (onImportDraft) {
				onImportDraft(game);
			} else {
				onImport(buildVirtualGame(game));
			}
			setQuery("");
			setError("");
			onClose();
		},
		[onClose, onImport, onImportDraft],
	);
	const metadataSearchFlow = useMetadataSearchFlow({
		t,
		onResolved: handleResolved,
		onError: setError,
	});
	const isBusy = metadataSearchFlow.isSearching;
	const canSubmit = query.trim().length > 0 && !isBusy;
	const loadingStage =
		mode === "mixed"
			? t(
					"pages.Detail.DataSourceUpdate.searchingMixed",
					"正在搜索多个数据源...",
				)
			: t("pages.Detail.DataSourceUpdate.searching", "正在搜索...");
	const loadingHint =
		mode === "mixed"
			? t(
					"pages.Detail.DataSourceUpdate.mixedLoadingHint",
					"Mixed 会等待已启用数据源返回，慢源可能需要更久。",
				)
			: t("components.AddModal.loadingHint", "操作完成后会自动进入下一步。");

	const abortActiveRequest = useCallback(() => {
		abortControllerRef.current?.abort();
		abortControllerRef.current = null;
	}, []);

	useEffect(() => abortActiveRequest, [abortActiveRequest]);

	useEffect(() => {
		if (!open) return;
		const firstSourceWithId = SEARCHABLE_SOURCE_KEYS.find((s) => {
			const rawId = initialSourceIds?.[s as SourceType];
			const normalized = normalizeEditableSourceId(s as SourceType, rawId);
			return Boolean(normalized && normalized.trim().length > 0);
		}) as SourceType | undefined;

		if (firstSourceWithId) {
			setMode("single");
			setSource(firstSourceWithId);
			setQuery(getSourceQuery(firstSourceWithId));
			return;
		}

		setQuery(initialQuery?.trim() ?? "");
	}, [open, initialSourceIds, initialQuery, getSourceQuery]);

	const handleClose = useCallback(() => {
		if (isBusy) return;
		metadataSearchFlow.reset();
		setError("");
		onClose();
	}, [isBusy, metadataSearchFlow, onClose]);
	const handleSubmit = useCallback(async () => {
		if (!canSubmit) return;
		setError("");
		const trimmedQuery = query.trim();
		const isVndbNumericId =
			mode === "single" && source === "vndb" && /^v?\d+$/i.test(trimmedQuery);
		const normalizedQuery = isVndbNumericId
			? formatVndbId(trimmedQuery)
			: trimmedQuery;
		const { controller, withAbort } = createAbortableRunner();
		abortActiveRequest();
		abortControllerRef.current = controller;
		const timeoutId = window.setTimeout(() => {
			controller.abort();
			setError(t("components.AddModal.timeout", "请求超时，请稍后重试"));
		}, REQUEST_TIMEOUT_MS);

		try {
			await metadataSearchFlow.searchMetadata({
				query: normalizedQuery,
				source: mode === "single" ? source : "mixed",
				withAbort,
				signal: controller.signal,
			});
		} catch (cause) {
			if (!isAbortError(cause)) {
				setError(String(cause));
			}
		} finally {
			window.clearTimeout(timeoutId);
			if (abortControllerRef.current === controller) {
				abortControllerRef.current = null;
			}
		}
	}, [
		abortActiveRequest,
		canSubmit,
		metadataSearchFlow,
		mode,
		query,
		source,
		t,
	]);

	const searchTitle = useMemo(
		() => title || t("home.nextUp.importTitle", "加入心愿与计划"),
		[t, title],
	);

	return (
		<>
			<Dialog open={open} onClose={handleClose} fullWidth maxWidth="sm">
				<DialogTitle>{searchTitle}</DialogTitle>
				<DialogContent className="flex flex-col gap-4 !pt-2">
					<MetadataMatchModeToggleGroup
						value={mode}
						onChange={(nextMode) => {
							setMode(nextMode);
							if (nextMode === "mixed") {
								setQuery(initialQuery?.trim() ?? "");
							} else {
								setQuery(getSourceQuery(source));
							}
						}}
						disabled={isBusy}
					/>
					{mode === "single" ? (
						<SingleSourceSelect
							value={source}
							onChange={handleSourceChange}
							disabled={isBusy}
						/>
					) : null}
					{isBusy && (
						<Box
							className="skerry-import-loading-strip"
							role="status"
							aria-live="polite"
						>
							<CircularProgress size={18} thickness={4} />
							<Box className="skerry-import-loading-copy">
								<Typography variant="body2" fontWeight={800}>
									{loadingStage}
								</Typography>
								<Typography variant="caption" color="text.secondary">
									{loadingHint}
								</Typography>
							</Box>
							<LinearProgress className="skerry-import-loading-progress" />
						</Box>
					)}
					<TextField
						autoFocus
						label={t("components.AddModal.gameName", "游戏名称")}
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") handleSubmit();
						}}
						disabled={isBusy}
						InputProps={{
							startAdornment: (
								<InputAdornment position="start">
									<SearchIcon />
								</InputAdornment>
							),
						}}
					/>
					{error ? <Alert severity="error">{error}</Alert> : null}
				</DialogContent>
				<DialogActions>
					<Button onClick={handleClose} disabled={isBusy}>
						{t("components.AddModal.cancel", "取消")}
					</Button>
					<Button
						variant="contained"
						startIcon={
							isBusy ? (
								<CircularProgress size={20} color="inherit" />
							) : (
								<AddIcon />
							)
						}
						onClick={handleSubmit}
						disabled={!canSubmit}
					>
						{isBusy
							? t("components.AddModal.processing", "处理中...")
							: t("components.AddModal.confirm", "搜索")}
					</Button>
				</DialogActions>
			</Dialog>
			<GameSelectDialog
				open={metadataSearchFlow.searchResultState.open}
				onClose={metadataSearchFlow.closeSearchResult}
				sourceCandidates={metadataSearchFlow.searchResultState.results}
				onSelectCandidate={metadataSearchFlow.selectGame}
				loading={isBusy}
				title={searchTitle}
				apiSource={metadataSearchFlow.searchResultState.apiSource}
			/>
			<MixedSourceConfirmDialog
				open={metadataSearchFlow.mixedCandidateState.open}
				onClose={metadataSearchFlow.closeMixedCandidates}
				candidates={metadataSearchFlow.mixedCandidateState.candidates}
				onConfirm={metadataSearchFlow.confirmMixedSelection}
				loading={isBusy}
				title={searchTitle}
			/>
		</>
	);
}
