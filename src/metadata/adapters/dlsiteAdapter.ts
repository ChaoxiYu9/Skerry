import type { DlsiteData, GameMetadataDraft } from "@/types";
import {
	fetchDlsiteById,
	fetchDlsiteByName,
	normalizeDlsiteId,
} from "../api/dlsite";
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

function toDlsiteCandidate(
	game: GameMetadataDraft,
): SourceCandidate<DlsiteData> {
	const data = getCandidateSourceData<DlsiteData>(game, "dlsite");
	if (!data) {
		throw new Error("Missing dlsite data in dlsite candidate");
	}

	return createSourceCandidate({
		source: "dlsite",
		externalId: getCandidateSourceId(game, "dlsite"),
		data,
		display: dlsiteAdapter.toDisplayFields(data),
	});
}

export const dlsiteAdapter: MetadataSourceAdapter<DlsiteData> = {
	key: "dlsite",
	label: "DLsite",
	iconUrl: "/source-icons/dlsite.ico",
	validateId: (id) => Boolean(normalizeDlsiteId(id)),
	getExternalUrl: (id) => {
		const normalizedId = normalizeDlsiteId(id) ?? id;
		const section = normalizedId.startsWith("VJ") ? "pro" : "maniax";
		return `https://www.dlsite.com/${section}/work/=/product_id/${normalizedId}.html?locale=ja`;
	},
	async fetchById(id, ctx) {
		const game = await fetchDlsiteById(id, ctx);
		return normalizeGameCandidateSources(game, "dlsite");
	},
	async searchByName(name, ctx) {
		const games = await fetchDlsiteByName(
			name,
			ctx.limit ?? DEFAULT_METADATA_SEARCH_LIMIT,
			ctx,
		);
		return games.map(toDlsiteCandidate);
	},
	async enrichOnSelect(candidate, ctx) {
		if (!candidate.externalId) {
			return sourceCandidateToDraft(candidate);
		}

		const game = await fetchDlsiteById(candidate.externalId, ctx);
		return mergeCandidateDetailData(candidate, game);
	},
	toDisplayFields: (data): SourceDisplayFields => ({
		image: data.image,
		name: data.name,
		summary: data.summary,
		tags: data.tags ?? [],
		developer: data.developer,
		nsfw: data.nsfw,
		date: data.date,
	}),
};
