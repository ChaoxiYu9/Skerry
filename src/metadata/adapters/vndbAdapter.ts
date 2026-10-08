import type { GameMetadataDraft, VndbData } from "@/types";
import { fetchVndbById, fetchVndbByName } from "../api/vndb";
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
import { formatVndbId } from "../sourceIds";

function toVndbCandidate(game: GameMetadataDraft): SourceCandidate<VndbData> {
	const data = getCandidateSourceData<VndbData>(game, "vndb");
	if (!data) {
		throw new Error("Missing vndb data in vndb candidate");
	}

	return createSourceCandidate({
		source: "vndb",
		externalId: getCandidateSourceId(game, "vndb"),
		data,
		display: vndbAdapter.toDisplayFields(data),
	});
}

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
		return games.map(toVndbCandidate);
	},
	toDisplayFields: (data): SourceDisplayFields => ({
		image: data.image,
		name: data.name,
		name_cn: data.name_cn,
		translated_name: data.translated_name,
		summary: data.summary,
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
