import type { BgmData, GameMetadataDraft } from "@/types";
import { isHttpStatus } from "@/utils/errors";
import { fetchBgmById, fetchBgmByName, fetchBgmStaffById } from "../api/bgm";
import {
	DEFAULT_METADATA_SEARCH_LIMIT,
	type MetadataSourceAdapter,
} from "../sourceAdapter";
import {
	createSourceCandidate,
	getCandidateSourceData,
	getCandidateSourceId,
	normalizeGameCandidateSources,
	type SourceCandidate,
	type SourceDisplayFields,
} from "../sourceCandidate";

// BGM token 不應為必須
// 但是需要R18等信息時還是需要登錄

function toBgmCandidate(game: GameMetadataDraft): SourceCandidate<BgmData> {
	const data = getCandidateSourceData<BgmData>(game, "bgm");
	if (!data) {
		throw new Error("Missing bgm data in bgm candidate");
	}

	return createSourceCandidate({
		source: "bgm",
		externalId: getCandidateSourceId(game, "bgm"),
		data,
		display: bgmAdapter.toDisplayFields(data),
	});
}

export const bgmAdapter: MetadataSourceAdapter<BgmData> = {
	key: "bgm",
	label: "Bangumi",
	iconUrl: "/source-icons/bgm.ico",
	validateId: (id) => /^\d+$/.test(id),
	getExternalUrl: (id) => `https://bgm.tv/subject/${id}`,
	async fetchById(id, ctx) {
		let game: GameMetadataDraft;
		try {
			game = await fetchBgmById(id, ctx.bgmToken, ctx);
		} catch (error) {
			if (!ctx.bgmToken || !isHttpStatus(error, 401)) throw error;
			game = await fetchBgmById(id, undefined, ctx);
		}
		try {
			const staff = await fetchBgmStaffById(id, ctx);
			if (staff && staff.length > 0) {
				game.custom_data = {
					...(game.custom_data ?? {}),
					staff,
				};
			}
		} catch (err) {
			console.warn(`Failed to fetch bgm staff for ${id}:`, err);
		}
		return normalizeGameCandidateSources(game, "bgm");
	},
	async searchByName(name, ctx) {
		let games: GameMetadataDraft[];
		try {
			games = await fetchBgmByName(
				name,
				ctx.bgmToken,
				ctx.limit ?? DEFAULT_METADATA_SEARCH_LIMIT,
				ctx,
			);
		} catch (error) {
			if (!ctx.bgmToken || !isHttpStatus(error, 401)) throw error;
			games = await fetchBgmByName(
				name,
				undefined,
				ctx.limit ?? DEFAULT_METADATA_SEARCH_LIMIT,
				ctx,
			);
		}
		return games.map(toBgmCandidate);
	},
	toDisplayFields: (data): SourceDisplayFields => ({
		image: data.image,
		name: data.name,
		name_cn: data.name_cn,
		translated_name: data.name_cn || undefined,
		summary: data.summary,
		tags: data.tags ?? [],
		rank: data.rank,
		score: data.score,
		developer: data.developer,
		aliases: data.aliases ?? [],
		nsfw: data.nsfw,
		date: data.date,
	}),
};
