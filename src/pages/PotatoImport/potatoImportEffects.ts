import type { FullGameData } from "@/types";
import {
	buildSessionEntries,
	type PotatoImportRecord,
} from "./potatoImport.ts";

export interface PotatoImportEffectTarget {
	record: PotatoImportRecord;
	game: FullGameData;
}

export interface PotatoImportEffectPort {
	saveImages: (
		gameId: number,
		record: PotatoImportRecord,
		game: FullGameData,
		index: number,
	) => Promise<void>;
	saveSession: (entry: {
		gameId: number;
		startTime: number;
		duration: number;
	}) => Promise<void>;
}

export interface PotatoImportEffectFailure {
	gameId: number;
	stage: "images" | "session";
	error: unknown;
}

/** Completes each inserted game's independent assets and history side effects. */
export async function executePotatoImportEffects(
	targets: readonly PotatoImportEffectTarget[],
	port: PotatoImportEffectPort,
): Promise<PotatoImportEffectFailure[]> {
	const failures: PotatoImportEffectFailure[] = [];

	for (const [index, { record, game }] of targets.entries()) {
		const gameId = game.id;
		if (!gameId) continue;

		try {
			await port.saveImages(gameId, record, game, index);
		} catch (error) {
			failures.push({ gameId, stage: "images", error });
		}

		for (const entry of buildSessionEntries(gameId, record)) {
			try {
				await port.saveSession(entry);
			} catch (error) {
				failures.push({ gameId, stage: "session", error });
			}
		}
	}

	return failures;
}
