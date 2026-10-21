export type DetailSceneKind = "library" | "next-up";
export type DetailPanel = "overview" | "stats" | "edit" | "save" | "review";

interface DetailSceneCapabilities {
	readonly panels: readonly DetailPanel[];
	readonly canLaunch: boolean;
	readonly canChangePlayStatus: boolean;
	readonly canOpenGameText: boolean;
	readonly canManageCollections: boolean;
	readonly canViewStatistics: boolean;
	readonly canManageSaves: boolean;
	readonly canImportToLibrary: boolean;
	readonly sourceLinksOnly: boolean;
	readonly tracksSelectedLibraryGame: boolean;
}

export const DETAIL_SCENE_CAPABILITIES: Record<
	DetailSceneKind,
	DetailSceneCapabilities
> = {
	library: {
		panels: ["overview", "stats", "save", "review", "edit"],
		canLaunch: true,
		canChangePlayStatus: true,
		canOpenGameText: true,
		canManageCollections: true,
		canViewStatistics: true,
		canManageSaves: true,
		canImportToLibrary: false,
		sourceLinksOnly: false,
		tracksSelectedLibraryGame: true,
	},
	"next-up": {
		panels: ["overview", "review", "edit"],
		canLaunch: false,
		canChangePlayStatus: false,
		canOpenGameText: false,
		canManageCollections: false,
		canViewStatistics: false,
		canManageSaves: false,
		canImportToLibrary: true,
		sourceLinksOnly: true,
		tracksSelectedLibraryGame: false,
	},
};
