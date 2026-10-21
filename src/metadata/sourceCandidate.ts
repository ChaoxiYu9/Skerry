import type {
	GameMetadataDraft,
	GameSourceRecord,
	JsonValue,
	SourceCandidateRecord,
	SummaryLanguage,
	SourceType,
} from "@/types";
import { SOURCE_TYPES } from "@/types";
import {
	mergeSourceDetailPayload,
	resolveCandidateSourceRecords,
	resolveSelectedSourceRecords,
} from "./data/sourceCandidateRules";

export interface SourceDisplayFields {
	image?: string;
	name?: string;
	name_cn?: string;
	translated_name?: string;
	summary?: string;
	summaryLanguage?: SummaryLanguage;
	tags?: string[];
	screenshots?: string[];
	rank?: number;
	score?: number;
	developer?: string;
	all_titles?: string[];
	aliases?: string[];
	average_hours?: number;
	nsfw?: boolean;
	date?: string;
}

export interface SourceCandidate<TData = unknown> {
	source: SourceType;
	externalId?: string;
	data: TData;
	display: SourceDisplayFields;
}

export type IdentifiedSourceCandidate<TData = unknown> =
	SourceCandidate<TData> & {
		externalId: string;
	};

const SOURCE_ORDER = [...SOURCE_TYPES];

export function createSourceCandidateRecord<TData>(
	source: SourceType,
	externalId: string,
	data: TData,
): SourceCandidateRecord<TData> {
	return {
		source,
		external_id: externalId,
		data,
	};
}

export function candidateSourcesToGameSources(
	sources: readonly SourceCandidateRecord[],
): GameSourceRecord[] {
	return sources.map((record) => ({
		source: record.source,
		external_id: record.external_id,
		data: record.data as JsonValue,
	}));
}

export function mergeCandidateSources(
	candidates: readonly GameMetadataDraft[],
): SourceCandidateRecord[] {
	return resolveCandidateSourceRecords(
		candidates.map((candidate) => candidate.sources),
		SOURCE_ORDER,
	);
}

export function createGameCandidate(params: {
	idType?: string;
	source?: SourceCandidateRecord;
	sources?: readonly SourceCandidateRecord[];
	customData?: GameMetadataDraft["custom_data"];
}): GameMetadataDraft {
	const sources = params.sources ?? (params.source ? [params.source] : []);
	return {
		id_type: params.idType,
		sources: [...sources],
		custom_data: params.customData,
	};
}

export function normalizeGameCandidateSources(
	candidate: GameMetadataDraft,
	fallbackIdType?: string,
): GameMetadataDraft {
	return createGameCandidate({
		idType: candidate.id_type ?? fallbackIdType,
		sources: mergeCandidateSources([candidate]),
		customData: candidate.custom_data,
	});
}

export function getCandidateSourceRecord(
	candidate: GameMetadataDraft,
	source: SourceType,
): SourceCandidateRecord | undefined {
	const nativeRecord = candidate.sources?.find(
		(record) => record.source === source,
	);
	if (nativeRecord) {
		return nativeRecord;
	}
}

export function getCandidateSourceId(
	candidate: GameMetadataDraft,
	source: SourceType,
): string | undefined {
	return getCandidateSourceRecord(candidate, source)?.external_id;
}

export function getCandidateSourceData<TData = unknown>(
	candidate: GameMetadataDraft,
	source: SourceType,
): TData | undefined {
	return getCandidateSourceRecord(candidate, source)?.data as TData | undefined;
}

export function createSourceCandidate<TData>(params: {
	source: SourceType;
	externalId?: string;
	data: TData;
	display: SourceDisplayFields;
}): SourceCandidate<TData> {
	return {
		source: params.source,
		externalId: params.externalId,
		data: params.data,
		display: params.display,
	};
}

export function sourceCandidateToDraft(
	candidate: SourceCandidate,
): GameMetadataDraft {
	if (!candidate.externalId) {
		throw new Error(`Missing ${candidate.source} external id in candidate`);
	}

	return createGameCandidate({
		idType: candidate.source,
		source: createSourceCandidateRecord(
			candidate.source,
			candidate.externalId,
			candidate.data,
		),
	});
}

export function mergeCandidateDetailData(
	candidate: SourceCandidate,
	details: GameMetadataDraft,
): GameMetadataDraft {
	const merged = normalizeGameCandidateSources(details, candidate.source);
	const source = candidate.source;
	const detailRecord = getCandidateSourceRecord(details, source);
	const baseSourceData = candidate.data;
	const detailSourceData = detailRecord?.data;

	if (!detailRecord) {
		merged.sources = mergeCandidateSources([
			merged,
			sourceCandidateToDraft(candidate),
		]);
		return merged;
	}

	const mergedData = mergeSourceDetailPayload(baseSourceData, detailSourceData);
	merged.sources = mergeCandidateSources([
		merged,
		{
			...merged,
			sources: [
				createSourceCandidateRecord(
					source,
					detailRecord.external_id,
					mergedData,
				),
			],
		},
	]);

	return merged;
}

export function getSourceCandidateFromGame<TData>(
	game: GameMetadataDraft,
	source: {
		key: SourceType;
		toDisplayFields(data: TData): SourceDisplayFields;
	},
	display?: SourceDisplayFields,
): SourceCandidate<TData> {
	const data = getCandidateSourceData<TData>(game, source.key);

	if (!data) {
		throw new Error(`Missing ${source.key} data in ${source.key} candidate`);
	}

	return createSourceCandidate({
		source: source.key,
		externalId: getCandidateSourceId(game, source.key),
		data,
		display: display ?? source.toDisplayFields(data),
	});
}

export function buildGameCandidateFromSourceSelection(params: {
	selection: Partial<Record<SourceType, SourceCandidate | null>>;
}): GameMetadataDraft {
	return resolveSelectedSourceRecords({
		selection: params.selection,
		sourceOrder: SOURCE_ORDER,
	});
}
