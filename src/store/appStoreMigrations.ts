import {
	DEFAULT_MIXED_SOURCE_KEYS,
	MIXED_SOURCE_KEYS,
	normalizeMixedSourceSelection,
} from "@/metadata/constants";
import type { SourceType } from "@/types";
import { DefaultGroup } from "@/types/collection";
import { normalizeTimeTrackingMode } from "@/types/timeTrackingMode";

export const APP_STORE_VERSION = 6;

type PersistedAppState = Record<string, unknown>;

export function migrateAppStorePersistedState(
	persistedState: unknown,
	version: number,
) {
	if (!isPersistedAppState(persistedState) || !(version < APP_STORE_VERSION)) {
		return persistedState;
	}

	let state: PersistedAppState = { ...persistedState };
	if (version < 1) {
		state = migrateMixedSourceFlagsToEnabledSources(state);
		state = migrateSelectedCategoryState(state);
	}

	if (version < 2) {
		state = migrateCardLaunchSettings(state);
	}

	if (version < 3) {
		state = migrateDefaultAddTimeSortOrder(state);
	}

	if (version < 4) {
		state = migrateMixedSourceSelection(state);
	}

	if (version < 5) {
		state = migrateTimeTrackingMode(state);
	}

	if (version < 6) {
		state = removeAutoBackupCoverPreference(state);
	}

	return state;
}

function isPersistedAppState(value: unknown): value is PersistedAppState {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function migrateDefaultAddTimeSortOrder(
	state: PersistedAppState,
): PersistedAppState {
	if (state.sortOption === "addtime" && state.sortOrder === "asc") {
		return { ...state, sortOrder: "desc" };
	}
	return state;
}

function migrateMixedSourceFlagsToEnabledSources(
	state: PersistedAppState,
): PersistedAppState {
	const { mixedEnableYmgal, mixedEnableKun, ...remainingState } = state;
	const sources: SourceType[] = [...DEFAULT_MIXED_SOURCE_KEYS];
	if (mixedEnableYmgal) sources.push("ymgal");
	if (mixedEnableKun) sources.push("kun");

	return {
		...remainingState,
		mixedEnabledSources: normalizeMixedSourceSelection(sources),
	};
}

function migrateSelectedCategoryState(
	state: PersistedAppState,
): PersistedAppState {
	const { selectedCategoryId, selectedCategoryName, ...remainingState } = state;
	if (state.selectedCategory !== undefined) return remainingState;

	let selectedCategory: unknown = null;
	if (typeof selectedCategoryId === "number" && selectedCategoryId > 0) {
		selectedCategory = { type: "real", id: selectedCategoryId };
	} else if (
		state.currentGroupId === DefaultGroup.DEVELOPER &&
		typeof selectedCategoryName === "string" &&
		selectedCategoryName
	) {
		selectedCategory = { type: "developer", key: selectedCategoryName };
	}

	return { ...remainingState, selectedCategory };
}

function migrateCardLaunchSettings(
	state: PersistedAppState,
): PersistedAppState {
	const { doubleClickLaunch, longPressLaunch, ...remainingState } = state;
	return remainingState;
}

function migrateMixedSourceSelection(
	state: PersistedAppState,
): PersistedAppState {
	const persistedSources = state.mixedEnabledSources;
	const sources = Array.isArray(persistedSources)
		? MIXED_SOURCE_KEYS.filter((source) =>
				persistedSources.some((candidate: unknown) => candidate === source),
			)
		: undefined;

	return {
		...state,
		mixedEnabledSources: normalizeMixedSourceSelection(sources),
	};
}

function migrateTimeTrackingMode(state: PersistedAppState): PersistedAppState {
	return {
		...state,
		timeTrackingMode: normalizeTimeTrackingMode(state.timeTrackingMode),
	};
}

function removeAutoBackupCoverPreference(
	state: PersistedAppState,
): PersistedAppState {
	delete state.autoBackupIncludeCovers;
	return state;
}
