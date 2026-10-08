import { memo } from "react";
import { useTranslation } from "react-i18next";
import { useGameIndex } from "@/hooks/features/games/useGameListFacade";
import { type SelectedCategory, useStore } from "@/store/appStore";
import { DefaultGroup } from "@/types/collection";
import { getDeveloperCategoryGameIds } from "@/utils/game/gameIndex";
import { setScrollPosition } from "@/hooks/common/useScrollRestore";
import { SearchBox } from "./SearchBox";

export function DeveloperGameSearchBox({
	categoryKey,
}: {
	categoryKey: string;
}) {
	const { index: gameIndex } = useGameIndex();
	const developerGameIds = getDeveloperCategoryGameIds(categoryKey, gameIndex);

	return <SearchBox scopeGameIds={developerGameIds} applyNsfwFilter={false} />;
}

export function CollectionGameSearchBox() {
	const value = useStore((s) => s.collectionGameSearch);
	const setValue = useStore((s) => s.setCollectionGameSearch);
	const { t } = useTranslation();
	return (
		<SearchBox
			mode="controlled"
			value={value}
			onValueChange={setValue}
			ariaLabel={t("pages.Collection.gameSort.search", "搜索当前分类的游戏")}
		/>
	);
}

export type CollectionEntitySearchKind = "groups" | "categories" | "developers";

export type CollectionTitleMode =
	| {
			type: "entity-search";
			kind: CollectionEntitySearchKind;
			scrollKey: string;
	  }
	| { type: "developer-game-search"; categoryKey: string }
	| { type: "collection-game-search" }
	| { type: "none" };

export function getCollectionTitleMode(
	pathname: string,
	currentGroupId: string | null,
	selectedCategory: SelectedCategory,
): CollectionTitleMode {
	if (pathname !== "/collection") {
		return { type: "none" };
	}

	if (
		currentGroupId === DefaultGroup.DEVELOPER &&
		selectedCategory?.type === "developer"
	) {
		return {
			type: "developer-game-search",
			categoryKey: selectedCategory.key,
		};
	}

	if (selectedCategory?.type === "real") {
		return { type: "collection-game-search" };
	}

	switch (currentGroupId) {
		case null:
			return { type: "entity-search", kind: "groups", scrollKey: "groups" };
		case DefaultGroup.DEVELOPER:
			return {
				type: "entity-search",
				kind: "developers",
				scrollKey: `categories:${DefaultGroup.DEVELOPER}`,
			};
		default:
			return currentGroupId.startsWith("default_")
				? { type: "none" }
				: {
						type: "entity-search",
						kind: "categories",
						scrollKey: `categories:${currentGroupId}`,
					};
	}
}

export interface CollectionEntitySearchBoxProps {
	kind: CollectionEntitySearchKind;
	scrollKey: string;
}

export const CollectionEntitySearchBox = memo(function CollectionEntitySearchBox({
	kind,
	scrollKey,
}: CollectionEntitySearchBoxProps) {
	const { t } = useTranslation();
	const value = useStore((state) => {
		switch (kind) {
			case "groups":
				return state.collectionGroupSearch;
			case "categories":
				return state.collectionCategorySearch;
			case "developers":
				return state.developerCategorySearch;
		}
	});
	const setValue = useStore((state) => {
		switch (kind) {
			case "groups":
				return state.setCollectionGroupSearch;
			case "categories":
				return state.setCollectionCategorySearch;
			case "developers":
				return state.setDeveloperCategorySearch;
		}
	});
	const ariaLabel = (() => {
		switch (kind) {
			case "groups":
				return t("pages.Collection.entitySearch.groups", "搜索分组");
			case "categories":
				return t("pages.Collection.entitySearch.categories", "搜索分类");
			case "developers":
				return t("pages.Collection.developerSearch.label", "搜索开发商");
		}
	})();

	const handleValueChange = (nextValue: string) => {
		setScrollPosition(scrollKey, 0);
		const localScrollRoot = document.querySelector<HTMLElement>(
			'[data-scroll-restore-key="' + scrollKey + '"]',
		);
		(localScrollRoot ??
			document.querySelector<HTMLElement>(
				"[data-skerry-scroll-root='collection']",
			) ??
			document.querySelector<HTMLElement>("main"))?.scrollTo({ top: 0 });
		setValue(nextValue);
	};

	return (
		<SearchBox
			mode="controlled"
			value={value}
			onValueChange={handleValueChange}
			ariaLabel={ariaLabel}
		/>
	);
});