import type { ErogameScapeData, GameMetadataDraft } from "@/types";
import {
	fetchErogameScapeById,
	fetchErogameScapeByName,
	normalizeErogameScapeId,
} from "../api/erogamescape";
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

function toErogameScapeCandidate(
	game: GameMetadataDraft,
): SourceCandidate<ErogameScapeData> {
	const data = getCandidateSourceData<ErogameScapeData>(game, "erogamescape");
	if (!data) {
		throw new Error("Missing erogamescape data in erogamescape candidate");
	}

	return createSourceCandidate({
		source: "erogamescape",
		externalId: getCandidateSourceId(game, "erogamescape"),
		data,
		display: erogamescapeAdapter.toDisplayFields(data),
	});
}

export const erogamescapeAdapter: MetadataSourceAdapter<ErogameScapeData> = {
	key: "erogamescape",
	label: "ErogameScape",
	iconUrl: "/source-icons/erogamescape.svg",
	validateId: (id) => Boolean(normalizeErogameScapeId(id)),
	getExternalUrl: (id) => {
		const normalizedId = normalizeErogameScapeId(id) ?? id;
		return `https://erogamescape.org/~ap2/ero/toukei_kaiseki/game.php?game=${normalizedId}`;
	},
	async fetchById(id, ctx) {
		const game = await fetchErogameScapeById(id, ctx);
		return normalizeGameCandidateSources(game, "erogamescape");
	},
	async searchByName(name, ctx) {
		const games = await fetchErogameScapeByName(
			name,
			ctx.limit ?? DEFAULT_METADATA_SEARCH_LIMIT,
			ctx,
		);
		return games.map(toErogameScapeCandidate);
	},
	async enrichOnSelect(candidate, ctx) {
		if (!candidate.externalId) {
			return sourceCandidateToDraft(candidate);
		}

		const game = await fetchErogameScapeById(candidate.externalId, ctx);
		return mergeCandidateDetailData(candidate, game);
	},
	toDisplayFields: (data): SourceDisplayFields => ({
		image: data.image,
		name: data.name,
		tags: data.tags ?? [],
		score: data.score ?? undefined,
		developer: data.developer,
		nsfw: data.nsfw,
		date: data.date,
	}),
};
