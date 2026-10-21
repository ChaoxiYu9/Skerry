import type { VndbData } from "@/types";
import { fetchVndbById, fetchVndbByName } from "../api/vndb";
import {
	DEFAULT_METADATA_SEARCH_LIMIT,
	type MetadataSourceAdapter,
} from "../sourceAdapter";
import {
	getSourceCandidateFromGame,
	normalizeGameCandidateSources,
	type SourceDisplayFields,
} from "../sourceCandidate";
import { formatVndbId } from "../sourceIds";

export const vndbAdapter: MetadataSourceAdapter<VndbData> = {
	key: "vndb",
	label: "VNDB",
	iconUrl: "/source-icons/vndb.ico",
	validateId: (id) => /^v\d+$/i.test(id),
	getExternalUrl: (id) => `https://vndb.org/${formatVndbId(id)}`,
	async fetchById(id, ctx) {
		const game = await fetchVndbById(id, ctx, false);
		return normalizeGameCandidateSources(game, "vndb");
	},
	async searchByName(name, ctx) {
		const games = await fetchVndbByName(
			name,
			ctx,
			undefined,
			ctx.limit ?? DEFAULT_METADATA_SEARCH_LIMIT,
		);
		return games.map((game) => getSourceCandidateFromGame(game, vndbAdapter));
	},
	toDisplayFields: (data): SourceDisplayFields => ({
		image: data.image,
		name: data.name,
		name_cn: data.name_cn,
		translated_name: data.translated_name,
		summary: data.summary,
		summaryLanguage: data.summary_language,
		tags: data.tags ?? [],
		screenshots: data.screenshots ?? [],
		score: data.score ?? undefined,
		developer: data.developer,
		all_titles: data.all_titles ?? [],
		aliases: data.aliases ?? [],
		average_hours: data.average_hours ?? undefined,
		nsfw: data.nsfw,
		date: data.date,
	}),
};
