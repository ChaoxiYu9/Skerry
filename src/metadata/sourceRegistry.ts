import type {
	BgmData,
	DlsiteData,
	ErogameScapeData,
	HikarinagiData,
	KunData,
	SourceType,
	VndbData,
	YmgalData,
} from "@/types";
import { bgmAdapter } from "./adapters/bgmAdapter";
import { dlsiteAdapter } from "./adapters/dlsiteAdapter";
import { erogamescapeAdapter } from "./adapters/erogamescapeAdapter";
import { hikarinagiAdapter } from "./adapters/hikarinagiAdapter";
import { kunAdapter } from "./adapters/kunAdapter";
import { vndbAdapter } from "./adapters/vndbAdapter";
import { ymgalAdapter } from "./adapters/ymgalAdapter";
import {
	type BoundMetadataSourceAdapter,
	bindMetadataSourceAdapter,
	type MetadataRequestContext,
	type MetadataSourceAdapter,
} from "./sourceAdapter";

export {
	DEFAULT_MIXED_SOURCE_KEYS,
	MIXED_SOURCE_KEYS,
	MIXED_SOURCE_MAX_COUNT,
	MIXED_SOURCE_MIN_COUNT,
	REGISTERED_SOURCE_KEYS,
	SEARCHABLE_SOURCE_KEYS,
} from "./constants";

export type SourceAdapterMap = {
	bgm: MetadataSourceAdapter<BgmData>;
	vndb: MetadataSourceAdapter<VndbData>;
	ymgal: MetadataSourceAdapter<YmgalData>;
	kun: MetadataSourceAdapter<KunData>;
	dlsite: MetadataSourceAdapter<DlsiteData>;
	erogamescape: MetadataSourceAdapter<ErogameScapeData>;
	hikarinagi: MetadataSourceAdapter<HikarinagiData>;
};

export const SOURCE_ADAPTERS = {
	bgm: bgmAdapter,
	vndb: vndbAdapter,
	ymgal: ymgalAdapter,
	kun: kunAdapter,
	dlsite: dlsiteAdapter,
	erogamescape: erogamescapeAdapter,
	hikarinagi: hikarinagiAdapter,
} as const satisfies SourceAdapterMap;

export type RegisteredSourceAdapter = SourceAdapterMap[SourceType];
export type RuntimeSourceAdapter = MetadataSourceAdapter<unknown>;
type BindSourceAdapter<TAdapter> =
	TAdapter extends MetadataSourceAdapter<infer TData>
		? BoundMetadataSourceAdapter<TData>
		: never;
export type BoundSourceAdapterMap = {
	[TSource in SourceType]: BindSourceAdapter<SourceAdapterMap[TSource]>;
};
export type RuntimeBoundSourceAdapter = BoundMetadataSourceAdapter<unknown>;

export function getSourceAdapter<TSource extends SourceType>(
	source: TSource,
): SourceAdapterMap[TSource] {
	return SOURCE_ADAPTERS[source];
}

export function bindSourceAdapters(
	context: MetadataRequestContext,
): BoundSourceAdapterMap {
	return Object.fromEntries(
		Object.entries(SOURCE_ADAPTERS).map(([source, adapter]) => [
			source,
			bindMetadataSourceAdapter(adapter as RuntimeSourceAdapter, context),
		]),
	) as BoundSourceAdapterMap;
}

export function getRuntimeSourceAdapter(
	source: SourceType,
): RuntimeSourceAdapter {
	return SOURCE_ADAPTERS[source];
}
