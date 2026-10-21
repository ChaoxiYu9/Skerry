import type { SourceType } from "../types/types.ts";
import { isSourceType, SOURCE_TYPES } from "../types/types.ts";

type SourceRecordLike = {
	source: string;
	external_id?: string | null;
	data?: unknown;
};

export type SourceRecordPayload = {
	sources: readonly SourceRecordLike[] | null;
};

export type SourceIdPayload = {
	sourceIds: Partial<Record<SourceType, string>> | null;
};

export type SourceIdentityPayload = SourceRecordPayload | SourceIdPayload;

export type SourceRecord = {
	source: SourceType;
	external_id: string | null;
	data: unknown | null;
};

export type SourceRecordMap = Map<SourceType, SourceRecord>;
export type SourceDataMap = Partial<Record<SourceType, unknown>>;
export type SourceIdMap = Partial<Record<SourceType, string>>;

function createSourceRecord(
	record: SourceRecordLike,
	source: SourceType,
): SourceRecord {
	return {
		source,
		external_id: record.external_id ?? null,
		data: record.data ?? null,
	};
}

export function getSourceRecordMap(
	payload: SourceRecordPayload,
): SourceRecordMap {
	const map: SourceRecordMap = new Map();

	for (const record of payload.sources ?? []) {
		if (!isSourceType(record.source)) continue;
		if (record.external_id == null && record.data == null) continue;
		map.set(record.source, createSourceRecord(record, record.source));
	}

	return map;
}

export function getSourceRecord(
	payload: SourceRecordPayload,
	source: SourceType,
): SourceRecord | undefined {
	const records = payload.sources;
	if (records == null) return undefined;

	for (let index = records.length - 1; index >= 0; index -= 1) {
		const record = records[index];
		if (
			record.source !== source ||
			!isSourceType(record.source) ||
			(record.external_id == null && record.data == null)
		) {
			continue;
		}

		return createSourceRecord(record, source);
	}

	return undefined;
}

export function getSourceIdFromRecords(
	payload: SourceRecordPayload,
	source: SourceType,
): string | undefined {
	return getSourceRecord(payload, source)?.external_id ?? undefined;
}

export function getSourceIdFromDisplay(
	payload: SourceIdPayload,
	source: SourceType,
): string | undefined {
	return payload.sourceIds?.[source] || undefined;
}

export function getAnySourceId(
	payload: SourceIdentityPayload,
	source: SourceType,
): string | undefined {
	if ("sources" in payload) {
		const sourceId = getSourceIdFromRecords(payload, source);
		if (sourceId) return sourceId;
	}

	if ("sourceIds" in payload) {
		return getSourceIdFromDisplay(payload, source);
	}

	return undefined;
}

export function getSourceData(
	payload: SourceRecordPayload,
	source: SourceType,
): unknown {
	return getSourceRecord(payload, source)?.data ?? undefined;
}

export function hasSourceRecord(
	payload: SourceRecordPayload,
	source: SourceType,
): boolean {
	return getSourceRecord(payload, source) !== undefined;
}

export function getSourceIdMap(payload: SourceRecordPayload): SourceIdMap {
	const ids: SourceIdMap = {};
	for (const [source, record] of getSourceRecordMap(payload)) {
		if (record.external_id) {
			ids[source] = record.external_id;
		}
	}
	return ids;
}

export function getAnySourceIdMap(payload: SourceIdentityPayload): SourceIdMap {
	const ids: SourceIdMap = {};

	if ("sourceIds" in payload && payload.sourceIds) {
		for (const source of SOURCE_TYPES) {
			const sourceId = getSourceIdFromDisplay(payload, source);
			if (sourceId) {
				ids[source] = sourceId;
			}
		}
	}

	if ("sources" in payload) {
		for (const [source, record] of getSourceRecordMap(payload)) {
			const sourceId = record.external_id;
			if (sourceId) {
				ids[source] = sourceId;
			}
		}
	}

	return ids;
}
