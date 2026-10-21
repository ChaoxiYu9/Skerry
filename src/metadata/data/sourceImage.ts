import type { FullGameData, SourceType } from "@/types";
import { getSourceRecordMap, type SourceRecordPayload } from "../sourceRecord";
import { REGISTERED_SOURCE_KEYS } from "../sourceRegistry";
import { getSourceDisplayFields } from "./displaySource";
import { SOURCE_COVER_PRIORITY } from "./mixedDisplayRules";

type SourceImageData = Partial<
	Record<SourceType, { image?: string | null } | null | undefined>
>;

export interface SourceImageOption {
	source: SourceType;
	image: string;
}

export function getSourceImageMap(game: SourceRecordPayload): SourceImageData {
	const sourceMap = getSourceRecordMap(game);
	const images: SourceImageData = {};

	for (const source of REGISTERED_SOURCE_KEYS) {
		const data = sourceMap.get(source)?.data;
		images[source] = data
			? { image: getSourceDisplayFields(source, data).image }
			: null;
	}

	return images;
}

export function resolveSourceImage(
	sources: SourceImageData,
	coverSource?: SourceType | null,
): string | undefined {
	if (coverSource) {
		const selectedImage = sources[coverSource]?.image;
		if (selectedImage) return selectedImage;
	}

	for (const source of SOURCE_COVER_PRIORITY) {
		const image = sources[source]?.image;
		if (image) return image;
	}

	return undefined;
}

export function getSourceImageOptions(game: FullGameData): SourceImageOption[] {
	const sources = getSourceImageMap(game);
	const options: SourceImageOption[] = [];

	for (const source of SOURCE_COVER_PRIORITY) {
		const image = sources[source]?.image;
		if (image) options.push({ source, image });
	}

	return options;
}
