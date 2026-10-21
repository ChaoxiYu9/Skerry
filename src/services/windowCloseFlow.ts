export type WindowCloseAction = "hide" | "close";

export interface WindowClosePreferences {
	skipCloseRemind: boolean;
	defaultCloseAction: WindowCloseAction;
}

export type WindowCloseIntent =
	| {
			type: "requested";
			preferences: WindowClosePreferences;
			runningGameCount: number;
	  }
	| {
			type: "selected";
			action: WindowCloseAction;
			runningGameCount: number;
	  }
	| { type: "running-exit-confirmed" };

export type WindowCloseDecision =
	| { kind: "show-choice" }
	| { kind: "hide-window"; rememberDefaultAction?: "hide" }
	| { kind: "confirm-running-exit"; rememberDefaultAction?: "close" }
	| { kind: "destroy-window"; rememberDefaultAction?: "close" };

type ExitDecision =
	| { kind: "confirm-running-exit"; rememberDefaultAction?: "close" }
	| { kind: "destroy-window"; rememberDefaultAction?: "close" };

function decideExit(
	runningGameCount: number,
	rememberCloseAction: boolean,
): ExitDecision {
	if (runningGameCount > 0) {
		return rememberCloseAction
			? { kind: "confirm-running-exit", rememberDefaultAction: "close" }
			: { kind: "confirm-running-exit" };
	}

	return rememberCloseAction
		? { kind: "destroy-window", rememberDefaultAction: "close" }
		: { kind: "destroy-window" };
}

function decideAction(
	action: WindowCloseAction,
	runningGameCount: number,
	rememberSelection: boolean,
): WindowCloseDecision {
	if (action === "hide") {
		return rememberSelection
			? { kind: "hide-window", rememberDefaultAction: "hide" }
			: { kind: "hide-window" };
	}

	return decideExit(runningGameCount, rememberSelection);
}

/** Resolve one close intent from persisted preferences and the live game count. */
export function resolveWindowCloseIntent(
	intent: WindowCloseIntent,
): WindowCloseDecision {
	switch (intent.type) {
		case "requested":
			if (!intent.preferences.skipCloseRemind) {
				return { kind: "show-choice" };
			}
			return decideAction(
				intent.preferences.defaultCloseAction,
				intent.runningGameCount,
				false,
			);
		case "selected":
			return decideAction(intent.action, intent.runningGameCount, true);
		case "running-exit-confirmed":
			return { kind: "destroy-window" };
	}
}

/** Apply the same active-game guard to the tray's native confirmation flow. */
export function resolveTrayExitIntent(runningGameCount: number): ExitDecision {
	return decideExit(runningGameCount, false);
}
