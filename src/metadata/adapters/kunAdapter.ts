import type { GameMetadataDraft, KunData } from "@/types";
import { fetchGalgameById, searchGalgame } from "../api/kun";
import {
	DEFAULT_METADATA_SEARCH_LIMIT,
	type MetadataSourceAdapter,
} from "../sourceAdapter";
import {
	createSourceCandidate,
	getCandidateSourceData,
	getCandidateSourceId,
	mergeCandidateDetailData,
	normalizeGameCandidateSources,
	type SourceCandidate,
	type SourceDisplayFields,
	sourceCandidateToDraft,
} from "../sourceCandidate";

function toKunCandidate(game: GameMetadataDraft): SourceCandidate<KunData> {
	const data = getCandidateSourceData<KunData>(game, "kun");
	if (!data) {
		throw new Error("Missing kun data in kun candidate");
	}

	return createSourceCandidate({
		source: "kun",
		externalId: getCandidateSourceId(game, "kun"),
		data,
		display: kunAdapter.toDisplayFields(data),
	});
}

export const kunAdapter: MetadataSourceAdapter<KunData> = {
	key: "kun",
	label: "Kungal",
	iconUrl: "/source-icons/kun.ico",
	validateId: (id) => /^\\d+$/.test(id),
	getExternalUrl: (id) => `https://www.kungal.com/galgame/${id}`,
	async fetchById(id, ctx) {
		const game = await fetchGalgameById(id, ctx);
		return normalizeGameCandidateSources(game, "kun");
	},
	async searchByName(name, ctx) {
		const games = await searchGalgame(
			name,
			1,
			ctx.limit ?? DEFAULT_METADATA_SEARCH_LIMIT,
			false,
			ctx,
		);
		return games.map(toKunCandidate);
	},
	async enrichOnSelect(candidate, ctx) {
		if (!candidate.externalId) {
			return sourceCandidateToDraft(candidate);
		}

		const game = await fetchGalgameById(candidate.externalId, ctx);
		return mergeCandidateDetailData(candidate, game);
	},
	toDisplayFields: (data): SourceDisplayFields => ({
		image: data.image,
		name: data.name,
		name_cn: data.name_cn,
		translated_name: data.translated_name,
		summary: data.summary,
		tags: data.tags ?? [],
		developer: data.developer,
		all_titles: data.all_titles ?? [],
		aliases: data.aliases ?? [],
		nsfw: data.nsfw,
		date: data.date,
	}),
};
