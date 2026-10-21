import { REGISTERED_SOURCE_KEYS } from "@/metadata/constants";
import { getDisplayGameData } from "@/metadata/data/dataTransform";
import { getSourceRecordMap } from "@/metadata/sourceRecord";
import type { FullGameData, GameData, SourceType } from "@/types";
import type { Category } from "@/types/collection";

export type SourceAvailability = Record<SourceType, boolean>;

export interface GameIndex {
	rawList: FullGameData[];
	rawById: Map<number, FullGameData>;
	displayList: GameData[];
	displayById: Map<number, GameData>;
	ids: number[];
	sourceAvailabilityById: Map<number, SourceAvailability>;
	developerCategories: Category[];
	developerGameIdsByName: Map<string, number[]>;
}

export const EMPTY_SOURCE_AVAILABILITY = Object.fromEntries(
	REGISTERED_SOURCE_KEYS.map((source) => [source, false]),
) as SourceAvailability;

export const EMPTY_GAME_INDEX: GameIndex = {
	rawList: [],
	rawById: new Map(),
	displayList: [],
	displayById: new Map(),
	ids: [],
	sourceAvailabilityById: new Map(),
	developerCategories: [],
	developerGameIdsByName: new Map(),
};

const gameIndexCache = new WeakMap<FullGameData[], GameIndex>();
export const UNKNOWN_DEVELOPER_KEY = "__unknown_developer__";
const DEVELOPER_CATEGORY_ID_START = -101;

function buildSourceAvailability(game: FullGameData): SourceAvailability {
	const availability: SourceAvailability = { ...EMPTY_SOURCE_AVAILABILITY };
	const sourceMap = getSourceRecordMap(game);

	for (const source of REGISTERED_SOURCE_KEYS) {
		availability[source] = sourceMap.get(source)?.data != null;
	}

	return availability;
}

export function getDeveloperNames(
	developer: string | readonly string[] | null | undefined,
	unknownDeveloper: string,
): string[] {
	const developers: string[] = [];
	const rawDevelopers = Array.isArray(developer)
		? developer
		: typeof developer === "string"
			? [developer]
			: [];

	for (const rawDeveloper of rawDevelopers) {
		for (const dev of String(rawDeveloper).split("/")) {
			const trimmed = dev.trim();
			if (trimmed) {
				developers.push(trimmed);
			}
		}
	}

	return developers.length > 0 ? developers : [unknownDeveloper];
}

export function getDeveloperCategoryGameIds(
	categoryKey: string | null,
	gameIndex: Pick<GameIndex, "developerGameIdsByName">,
): number[] {
	return categoryKey
		? (gameIndex.developerGameIdsByName.get(categoryKey) ?? [])
		: [];
}

function buildDeveloperIndex(games: GameData[], unknownDeveloper: string) {
	const developerGameIdsByName = new Map<string, number[]>();

	for (const game of games) {
		for (const developer of getDeveloperNames(
			game.developer,
			unknownDeveloper,
		)) {
			const ids = developerGameIdsByName.get(developer) ?? [];
			ids.push(game.id);
			developerGameIdsByName.set(developer, ids);
		}
	}

	const developerCategories = Array.from(developerGameIdsByName.entries())
		.toSorted((a, b) => b[1].length - a[1].length)
		.map(([name, gameIds], index) => ({
			id: DEVELOPER_CATEGORY_ID_START - index,
			name,
			sort_order: 0,
			game_count: gameIds.length,
		}));

	return {
		developerCategories,
		developerGameIdsByName,
	};
}

/**
 * Derive all views from one committed library snapshot. Unchanged records keep
 * their display objects; additions, removals and ordering come only from this
 * snapshot, never from a second mutation applied to an independently held index.
 */
export function buildGameIndex(
	fullGames: FullGameData[],
	previous: GameIndex = EMPTY_GAME_INDEX,
): GameIndex {
	if (fullGames.length === 0) {
		return fullGames === EMPTY_GAME_INDEX.rawList
			? EMPTY_GAME_INDEX
			: { ...EMPTY_GAME_INDEX, rawList: fullGames };
	}

	const rawById = new Map<number, FullGameData>();
	const displayList: GameData[] = [];
	const displayById = new Map<number, GameData>();
	const ids: number[] = [];
	const sourceAvailabilityById = new Map<number, SourceAvailability>();
	let developersChanged = fullGames.length !== previous.rawList.length;

	for (const [position, fullGame] of fullGames.entries()) {
		const unchanged = previous.rawById.get(fullGame.id) === fullGame;
		const previousDisplay = previous.displayById.get(fullGame.id);
		const displayGame =
			(unchanged ? previousDisplay : undefined) ?? getDisplayGameData(fullGame);
		const availability =
			(unchanged
				? previous.sourceAvailabilityById.get(fullGame.id)
				: undefined) ?? buildSourceAvailability(fullGame);

		rawById.set(fullGame.id, fullGame);
		displayList.push(displayGame);
		displayById.set(displayGame.id, displayGame);
		ids.push(displayGame.id);
		sourceAvailabilityById.set(fullGame.id, availability);
		// Category ties follow first appearance in library order.
		if (
			previous.ids[position] !== fullGame.id ||
			previousDisplay?.developer !== displayGame.developer
		) {
			developersChanged = true;
		}
	}
	const developerIndex = developersChanged
		? buildDeveloperIndex(displayList, UNKNOWN_DEVELOPER_KEY)
		: previous;

	return {
		rawList: fullGames,
		rawById,
		displayList,
		displayById,
		ids,
		sourceAvailabilityById,
		developerCategories: developerIndex.developerCategories,
		developerGameIdsByName: developerIndex.developerGameIdsByName,
	};
}

export function getGameIndex(
	fullGames: FullGameData[] | undefined,
	previous: GameIndex = EMPTY_GAME_INDEX,
): GameIndex {
	if (!fullGames) {
		return EMPTY_GAME_INDEX;
	}

	const cached = gameIndexCache.get(fullGames);
	if (cached) {
		return cached;
	}

	const index = buildGameIndex(fullGames, previous);
	gameIndexCache.set(fullGames, index);
	return index;
}
