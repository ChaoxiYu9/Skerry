import { SOURCE_TYPES, type SourceType } from "../../types/types.ts";
import { normalizeSteamLaunchId } from "../../utils/steam.ts";
import {
	getAnySourceIdMap,
	type SourceIdentityPayload,
} from "../sourceRecord.ts";

export type GameIdentityPayload = SourceIdentityPayload & {
	steam_launch_id?: string | null;
};

export interface PlannedIdentityCandidate<TCandidate> {
	candidateIndex: number;
	candidate: TCandidate;
}

export interface UniqueCandidatePlan<TCandidate> {
	accepted: PlannedIdentityCandidate<TCandidate>[];
	duplicateIndices: number[];
}

export interface GameIdentityIndex {
	hasSourceId(source: SourceType, externalId: string): boolean;
	/** Accepts only the canonical output of normalizeSteamLaunchId. */
	hasNormalizedSteamLaunchId(launchId: string): boolean;
}

interface GameIdentityFacts {
	sourceIds: ReturnType<typeof getAnySourceIdMap>;
	steamLaunchId?: string;
}

interface MutableGameIdentityIndex {
	lookup: GameIdentityIndex;
	add(identities: GameIdentityFacts): void;
}

function readGameIdentityFacts(
	payload: GameIdentityPayload,
): GameIdentityFacts {
	const steamLaunchId = payload.steam_launch_id
		? normalizeSteamLaunchId(payload.steam_launch_id)
		: undefined;
	return {
		sourceIds: getAnySourceIdMap(payload),
		steamLaunchId,
	};
}

function createMutableGameIdentityIndex(): MutableGameIdentityIndex {
	const sourceIds = new Map<SourceType, Set<string>>();
	for (const source of SOURCE_TYPES) sourceIds.set(source, new Set());
	const steamLaunchIds = new Set<string>();

	return {
		lookup: {
			hasSourceId: (source, externalId) =>
				sourceIds.get(source)?.has(externalId) ?? false,
			hasNormalizedSteamLaunchId: (launchId) => steamLaunchIds.has(launchId),
		},
		add(identities) {
			for (const source of SOURCE_TYPES) {
				const externalId = identities.sourceIds[source];
				if (externalId) sourceIds.get(source)?.add(externalId);
			}

			if (identities.steamLaunchId) {
				steamLaunchIds.add(identities.steamLaunchId);
			}
		},
	};
}

function hasIdentityCollision(
	identities: GameIdentityFacts,
	existingIdentities: GameIdentityIndex,
	additionalIdentities?: GameIdentityIndex,
): boolean {
	for (const source of SOURCE_TYPES) {
		const externalId = identities.sourceIds[source];
		if (
			externalId &&
			(existingIdentities.hasSourceId(source, externalId) ||
				additionalIdentities?.hasSourceId(source, externalId))
		) {
			return true;
		}
	}

	return Boolean(
		identities.steamLaunchId &&
			(existingIdentities.hasNormalizedSteamLaunchId(
				identities.steamLaunchId,
			) ||
				additionalIdentities?.hasNormalizedSteamLaunchId(
					identities.steamLaunchId,
				)),
	);
}

/** Index identities already present in the library snapshot. */
export function createGameIdentityIndex(
	games: readonly GameIdentityPayload[],
): GameIdentityIndex {
	const identities = createMutableGameIdentityIndex();
	for (const game of games) {
		identities.add(readGameIdentityFacts(game));
	}
	return identities.lookup;
}

export function hasGameIdentityCollision(
	candidate: GameIdentityPayload,
	existingIdentities: GameIdentityIndex,
): boolean {
	return hasIdentityCollision(
		readGameIdentityFacts(candidate),
		existingIdentities,
	);
}

/**
 * Keep the first candidate for each provider or Steam identity, matching the
 * add flows' input order. A skipped candidate does not claim its other IDs.
 */
export function planUniqueGameCandidates<
	TCandidate extends GameIdentityPayload,
>(
	candidates: readonly TCandidate[],
	existingIdentities: GameIdentityIndex,
): UniqueCandidatePlan<TCandidate> {
	const claimedInBatch = createMutableGameIdentityIndex();
	const accepted: PlannedIdentityCandidate<TCandidate>[] = [];
	const duplicateIndices: number[] = [];

	for (const [candidateIndex, candidate] of candidates.entries()) {
		const identities = readGameIdentityFacts(candidate);
		if (
			hasIdentityCollision(
				identities,
				existingIdentities,
				claimedInBatch.lookup,
			)
		) {
			duplicateIndices.push(candidateIndex);
			continue;
		}

		accepted.push({ candidateIndex, candidate });
		claimedInBatch.add(identities);
	}

	return { accepted, duplicateIndices };
}
