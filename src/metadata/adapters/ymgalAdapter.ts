import type { YmgalData } from "@/types";
import { fetchYmById, fetchYmByName } from "../api/ymgal";
import {
	DEFAULT_METADATA_SEARCH_LIMIT,
	type MetadataSourceAdapter,
} from "../sourceAdapter";
import {
	getSourceCandidateFromGame,
	mergeCandidateDetailData,
	normalizeGameCandidateSources,
	type SourceDisplayFields,
} from "../sourceCandidate";

export const ymgalAdapter: MetadataSourceAdapter<YmgalData> = {
	key: "ymgal",
	label: "YMGal",
	iconUrl: "/source-icons/ymgal.ico",
	validateId: (id) => /^(ga)?\d+$/i.test(id),
	getExternalUrl: (id) => `https://www.ymgal.games/ga${id}`,
	async fetchById(id, ctx) {
		const game = await fetchYmById(id, ctx);
		return normalizeGameCandidateSources(game, "ymgal");
	},
	async searchByName(name, ctx) {
		const games = await fetchYmByName(
			name,
			1,
			ctx.limit ?? DEFAULT_METADATA_SEARCH_LIMIT,
			false,
			ctx,
		);
		return games.map((game) => getSourceCandidateFromGame(game, ymgalAdapter));
	},
	async enrichOnSelect(candidate, ctx) {
		const game = await fetchYmById(candidate.externalId, ctx);
		return mergeCandidateDetailData(candidate, game);
	},
	toDisplayFields: (data): SourceDisplayFields => ({
		image: data.image,
		name: data.name,
		name_cn: data.name_cn,
		translated_name: data.name_cn || undefined,
		summary: data.summary,
		summaryLanguage: data.summary_language,
		developer: data.developer,
		aliases: data.aliases ?? [],
		nsfw: data.nsfw,
		date: data.date,
	}),
};
