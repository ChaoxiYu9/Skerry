/**
 * @file 多数据源名称搜索 API 封装
 * @description 并发查询启用的数据源并保留各源候选与部分失败状态
 * @module src/metadata/api/mixed
 * @author Skerry contributors (based on ReinaManager)
 * @copyright AGPL-3.0
 *
 * 逻辑说明：按名称并发搜索启用的数据源，保留可用来源的候选和失败来源。
 * ID 查询由单个数据源 adapter 负责，不在 Mixed 名称搜索中扩散。
 *
 * 主要导出：
 * - fetchMixedData：Mixed 名称搜索，返回按 source 分组的候选列表
 */

import type { SourceType } from "@/types";
import { isAbortError } from "@/utils/async";
import {
	AppError,
	isApiRateLimitError,
	isHttpStatus,
	toError,
} from "@/utils/errors";
import { MIXED_SOURCE_MAX_COUNT } from "../constants";
import {
	createMixedSearchPlan,
	summarizeMixedSearchOutcomes,
} from "../data/mixedSearchPlan";
import { deduplicateSourceCandidates } from "../data/sourceCandidateRules";
import type { SourceCandidate } from "../sourceCandidate";
import type { RuntimeBoundSourceAdapter } from "../sourceRegistry";

interface SafeFetchResult {
	source: SourceType;
	data: SourceCandidate[];
	failed: boolean;
	attempted: boolean;
	error?: unknown;
}

export type MixedSourceCandidateResult = Partial<
	Record<SourceType, SourceCandidate[]>
>;

export interface MixedSourceFetchResult {
	candidates: MixedSourceCandidateResult;
	failedSources: SourceType[];
}

interface FetchMixedDataOptions {
	name: string;
	adapters: RuntimeBoundSourceAdapter[];
}

async function fetchAdapterSafely(
	adapter: RuntimeBoundSourceAdapter,
	task: () => Promise<SourceCandidate[]>,
): Promise<SafeFetchResult> {
	try {
		const data = deduplicateSourceCandidates(await task());
		return {
			source: adapter.key,
			data,
			failed: false,
			attempted: true,
		};
	} catch (error) {
		if (isAbortError(error)) throw error;
		if (isApiRateLimitError(error)) throw error;
		if (adapter.key === "bgm" && isHttpStatus(error, 401)) throw error;
		return {
			source: adapter.key,
			data: [],
			failed: true,
			attempted: true,
			error,
		};
	}
}

function isMetadataNotFound(error: unknown) {
	return (
		isHttpStatus(error, 404) ||
		(error instanceof AppError && error.code === "metadata_not_found")
	);
}

function assertNotAllAttemptedSourcesFailed(
	results: SafeFetchResult[],
	message: string,
	cause?: Error,
) {
	const summary = summarizeMixedSearchOutcomes(results, isMetadataNotFound);
	if (summary.allAttemptedFailed) {
		if (summary.allAttemptedFailuresNotFound) {
			throw new AppError({
				code: "metadata_not_found",
				message: "No metadata found from attempted mixed sources",
				cause,
			});
		}
		throw new AppError({
			code: "mixed_sources_failed",
			message,
			cause,
		});
	}
}

function toSourceResult(results: SafeFetchResult[]): MixedSourceFetchResult {
	const mixedResult: MixedSourceCandidateResult = {};

	for (const result of results) {
		mixedResult[result.source] = result.data;
	}

	return {
		candidates: mixedResult,
		failedSources: summarizeMixedSearchOutcomes(
			results,
			isMetadataNotFound,
		).failedSources,
	};
}

/**
 * 搜索多个元数据源的名称候选。
 * 外部 ID 查询由对应数据源的单源入口处理。
 *
 * @param options 配置选项
 * @param options.name 游戏名称
 * @returns 返回按 source 分组的候选列表
 */
export async function fetchMixedData(options: FetchMixedDataOptions) {
	const { name, adapters } = options;
	const plan = createMixedSearchPlan({
		query: name,
		sources: adapters.map((adapter) => adapter.key),
		maxSources: MIXED_SOURCE_MAX_COUNT,
	});
	if (plan.kind === "too-many-sources") {
		throw new AppError({
			code: "mixed_source_limit_exceeded",
			message: `Mixed search is limited to ${MIXED_SOURCE_MAX_COUNT} sources`,
		});
	}

	if (plan.kind === "name-search") {
		const results = await Promise.all(
			adapters.map((adapter) =>
				fetchAdapterSafely(adapter, () =>
					adapter.searchByName(plan.query),
				),
			),
		);

		assertNotAllAttemptedSourcesFailed(
			results,
			`All mixed source requests failed for search: ${plan.query}`,
			toError(undefined, "Mixed search failed"),
		);

		return toSourceResult(results);
	}

	throw new AppError({
		code: "invalid_game_id",
		message: "Mixed fetch requires a name query",
	});
}
