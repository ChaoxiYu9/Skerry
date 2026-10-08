/**
 * @file Collection 页面
 * @description 分组分类管理页面，显示分组下的所有分类及其游戏数量，以及分类详情页面
 * @module src/pages/Collection/index
 * @author Skerry contributors (based on ReinaManager)
 * @copyright AGPL-3.0
 */

import Box from "@mui/material/Box";
import { AlertConfirmBox } from "@/components/AlertBox";
import { useDeferredValue, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { ManageGamesDialog } from "@/components/Collection";
import { InputDialog } from "@/components/InputDialog";
import { CollectionRightMenu } from "@/components/RightMenu";
import { CollectionToolbar } from "@/components/Toolbar";
import { CollectionEntitySearchBox } from "@/components/CollectionSearchBoxes";
import { useScrollRestore } from "@/hooks/common/useScrollRestore";
import { useVirtualCategories } from "@/hooks/features/collections/useVirtualCollections";
import { useGameIndex } from "@/hooks/features/games/useGameListFacade";
import {
	useCategories,
	useCategoryGames,
	useGroupsWithCount,
} from "@/hooks/queries/useCollections";
import { useStore } from "@/store/appStore";
import {
	type Category as CategoryType,
	DefaultGroup,
} from "@/types/collection";
import { CollectionBreadcrumbs, type CollectionLevel } from "./CollectionBreadcrumbs";
import {
	CollectionCategoryView,
	CollectionGroupView,
} from "./CollectionEntityViews";
import { CollectionGamesView } from "./CollectionGamesView";
import {
	matchesCollectionSearch,
	normalizeCollectionSearch,
	sortCollectionEntityNames,
	sortDeveloperCategories,
} from "./collectionEntity";
import { useCollectionEntityActions } from "./useCollectionEntityActions";
import { useCollectionNavigation } from "./useCollectionNavigation";

export const Collection: React.FC = () => {
	const { i18n, t } = useTranslation();
	useScrollRestore("/collection", {
		containerSelector: "[data-skerry-scroll-root='collection']",
	});
	const {
		currentGroupId,
		setSelectedCategory,
		setCurrentGroup,
		selectedCategory,
		entitySortField,
		entitySortOrder,
		developerSortField,
		developerSortOrder,
		groupSearch,
		categorySearch,
		developerSearch,
	} = useStore(
		useShallow((s) => ({
			currentGroupId: s.currentGroupId,
			setSelectedCategory: s.setSelectedCategory,
			setCurrentGroup: s.setCurrentGroup,
			selectedCategory: s.selectedCategory,
			entitySortField: s.collectionEntitySortField,
			entitySortOrder: s.collectionEntitySortOrder,
			developerSortField: s.developerCategorySortField,
			developerSortOrder: s.developerCategorySortOrder,
			groupSearch: s.collectionGroupSearch,
			categorySearch: s.collectionCategorySearch,
			developerSearch: s.developerCategorySearch,
		})),
	);
	const backendEntitySortField =
		entitySortField === "name" ? undefined : entitySortField;
	const backendEntitySortOrder = backendEntitySortField
		? entitySortOrder
		: undefined;
	const gameIndexQuery = useGameIndex();
	const { index: gameIndex } = gameIndexQuery;
	const displayAllGames = gameIndex.displayList;
	const groupsQuery = useGroupsWithCount(
		backendEntitySortField,
		backendEntitySortOrder,
	);
	const groups = groupsQuery.data ?? [];
	const categoriesQuery = useCategories(
		currentGroupId,
		backendEntitySortField,
		backendEntitySortOrder,
	);
	const currentCategories = categoriesQuery.data ?? [];
	const selectedRealCategoryId =
		selectedCategory?.type === "real" ? selectedCategory.id : null;
	const categoryGamesQuery = useCategoryGames(selectedCategory, gameIndex);
	const categoryGames = categoryGamesQuery.data;
	const virtualCategories = useVirtualCategories(gameIndex);
	const deferredGroupSearch = useDeferredValue(groupSearch);
	const deferredCategorySearch = useDeferredValue(categorySearch);
	const deferredDeveloperSearch = useDeferredValue(developerSearch);
	const {
		currentLevelKey,
		handleGroupClick,
		handleCategoryClick,
		handleBreadcrumbClick,
	} = useCollectionNavigation({
		currentGroupId,
		selectedCategory,
		setCurrentGroup,
		setSelectedCategory,
	});
	const {
		menuPosition,
		setMenuPosition,
		selectedItem,
		renameDialogOpen,
		setRenameDialogOpen,
		deleteDialogOpen,
		setDeleteDialogOpen,
		manageGamesDialogOpen,
		setManageGamesDialogOpen,
		isDeleting,
		handleGroupContextMenu,
		handleCategoryContextMenu,
		handleOpenRenameDialog,
		handleOpenManageGamesDialog,
		handleOpenDeleteDialog,
		handleDeleteConfirm,
		handleRenameConfirm,
	} = useCollectionEntityActions({
		currentGroupId,
		selectedRealCategoryId,
		setCurrentGroup,
		setSelectedCategory,
	});



	const showLevel: CollectionLevel =
		currentGroupId && selectedCategory !== null
			? "games"
			: currentGroupId
				? "categories"
				: "groups";
	const isDeveloperCategoryList =
		showLevel === "categories" && currentGroupId === DefaultGroup.DEVELOPER;
	const entitySearchConfig =
		showLevel === "groups"
			? { kind: "groups" as const, scrollKey: "groups" }
			: showLevel === "categories"
				? currentGroupId === DefaultGroup.DEVELOPER
					? {
							kind: "developers" as const,
							scrollKey: "categories:" + DefaultGroup.DEVELOPER,
						}
					: currentGroupId
						? {
								kind: "categories" as const,
								scrollKey: "categories:" + currentGroupId,
							}
						: null
				: null;
	const collator = useMemo(
		() =>
			new Intl.Collator(i18n.resolvedLanguage, {
				numeric: true,
				sensitivity: "base",
			}),
		[i18n.resolvedLanguage],
	);
	const normalizedGroupSearch = normalizeCollectionSearch(
		deferredGroupSearch,
		i18n.resolvedLanguage,
	);
	const normalizedCategorySearch = normalizeCollectionSearch(
		deferredCategorySearch,
		i18n.resolvedLanguage,
	);
	const normalizedDeveloperSearch = normalizeCollectionSearch(
		deferredDeveloperSearch,
		i18n.resolvedLanguage,
	);
	const filteredDeveloperCategories = useMemo(() => {
		if (!normalizedDeveloperSearch) {
			return virtualCategories.developerCategories;
		}

		return virtualCategories.developerCategories.filter((category) =>
			matchesCollectionSearch(
				category.name,
				normalizedDeveloperSearch,
				i18n.resolvedLanguage,
			),
		);
	}, [
		i18n.resolvedLanguage,
		normalizedDeveloperSearch,
		virtualCategories.developerCategories,
	]);
	const filteredRealCategories = useMemo(
		() =>
			currentCategories.filter((category) =>
				matchesCollectionSearch(
					category.name,
					normalizedCategorySearch,
					i18n.resolvedLanguage,
				),
			),
		[currentCategories, i18n.resolvedLanguage, normalizedCategorySearch],
	);
	const categories = useMemo((): CategoryType[] => {
		if (currentGroupId === DefaultGroup.DEVELOPER) {
			return sortDeveloperCategories(
				filteredDeveloperCategories,
				developerSortField,
				developerSortOrder,
				collator,
			);
		}

		return entitySortField === "name"
			? sortCollectionEntityNames(
					filteredRealCategories,
					entitySortOrder,
					collator,
				)
			: filteredRealCategories;
	}, [
		collator,
		currentGroupId,
		developerSortField,
		developerSortOrder,
		entitySortField,
		entitySortOrder,
		filteredDeveloperCategories,
		filteredRealCategories,
	]);
	const isDeveloperCategoryLoading =
		gameIndexQuery.isLoading && categories.length === 0;

	const filteredCustomGroups = useMemo(
		() =>
			groups
				.filter((group) =>
					matchesCollectionSearch(
						group.name,
						normalizedGroupSearch,
						i18n.resolvedLanguage,
					),
				)
				.map((group) => ({
					id: group.id.toString(),
					name: group.name,
					game_count: group.game_count,
				})),
		[groups, i18n.resolvedLanguage, normalizedGroupSearch],
	);
	const customGroups = useMemo(
		() =>
			entitySortField === "name"
				? sortCollectionEntityNames(
						filteredCustomGroups,
						entitySortOrder,
						collator,
					)
				: filteredCustomGroups,
		[collator, entitySortField, entitySortOrder, filteredCustomGroups],
	);
	const developerGroupName = t(
		"pages.Collection.defaultGroups.developer",
		"开发商",
	);
	const showDeveloperGroup = matchesCollectionSearch(
		developerGroupName,
		normalizedGroupSearch,
		i18n.resolvedLanguage,
	);
	const allGroups = [
		...(showDeveloperGroup
			? [
					{
						id: DefaultGroup.DEVELOPER,
						name: developerGroupName,
						game_count: displayAllGames.length,
					},
				]
			: []),
		...customGroups,
	];

	const activeGroupName = useMemo(() => {
		if (!currentGroupId) return "";
		if (currentGroupId === DefaultGroup.DEVELOPER) {
			return developerGroupName;
		}
		const group = allGroups.find((g) => String(g.id) === currentGroupId);
		return group?.name || "";
	}, [currentGroupId, allGroups, developerGroupName]);

	const activeCategoryName = useMemo(() => {
		if (!selectedCategory) return "";
		if (selectedCategory.type === "developer") {
			return selectedCategory.key;
		}
		const category = currentCategories.find((c) => c.id === selectedCategory.id);
		return category?.name || "";
	}, [selectedCategory, currentCategories]);

	return (
		<Box
			className="library-page-shell collection-page-shell"
			data-skerry-scroll-root="collection"
		>
			<CollectionBreadcrumbs
				level={showLevel}
				groupName={activeGroupName}
				categoryName={activeCategoryName}
				onNavigate={handleBreadcrumbClick}
			/>
			{entitySearchConfig ? (
				<Box className="cards-control-bar collection-controls-bar">
					<Box className="cards-control-main">
						<Box className="library-controls-pack collection-controls-pack">
							<Box className="library-workbench-search">
								<CollectionEntitySearchBox
									kind={entitySearchConfig.kind}
									scrollKey={entitySearchConfig.scrollKey}
								/>
							</Box>
							<Box className="library-workbench-actions">
								<CollectionToolbar />
							</Box>
						</Box>
					</Box>
				</Box>
			) : null}

			{showLevel === "groups" ? (
				<CollectionGroupView
					groups={allGroups}
					onGroupClick={handleGroupClick}
					onContextMenu={handleGroupContextMenu}
				/>
			) : null}

			{showLevel === "categories" ? (
				isDeveloperCategoryList ? (
					<CollectionCategoryView
						mode="developer"
						categories={categories}
						sourceCount={virtualCategories.developerCategories.length}
						loading={isDeveloperCategoryLoading}
						error={gameIndexQuery.isError ? gameIndexQuery.error : null}
						scrollKey={currentLevelKey}
						onCategoryClick={handleCategoryClick}
						onContextMenu={handleCategoryContextMenu}
					/>
				) : (
					<CollectionCategoryView
						mode="real"
						categories={categories}
						sourceCount={currentCategories.length}
						onCategoryClick={handleCategoryClick}
						onContextMenu={handleCategoryContextMenu}
					/>
				)
			) : null}

			{showLevel === "games" ? (
				<CollectionGamesView
					realCategoryId={selectedRealCategoryId}
					gameIds={categoryGames}
					loading={categoryGamesQuery.isLoading}
					error={categoryGamesQuery.isError ? categoryGamesQuery.error : null}
					scrollRestoreKey={currentLevelKey}
				/>
			) : null}

			{/* 统一的右键菜单 */}
			{menuPosition && (
				<CollectionRightMenu
					anchorPosition={{
						top: menuPosition.mouseY,
						left: menuPosition.mouseX,
					}}
					onClose={() => setMenuPosition(null)}
					target={
						menuPosition.type === "group"
							? { type: "group", id: menuPosition.id }
							: { type: "category", id: menuPosition.id }
					}
					onOpenRename={handleOpenRenameDialog}
					onOpenManageGames={handleOpenManageGamesDialog}
					onOpenDelete={handleOpenDeleteDialog}
				/>
			)}

			{selectedItem && (
				<AlertConfirmBox
					open={deleteDialogOpen}
					setOpen={setDeleteDialogOpen}
					onConfirm={handleDeleteConfirm}
					isLoading={isDeleting}
					title={
						selectedItem.type === "group"
							? t("pages.Collection.deleteGroupTitle", "删除分组")
							: t("pages.Collection.deleteCategoryTitle", "删除分类")
					}
					message={
						selectedItem.type === "group"
							? t("pages.Collection.deleteGroupMessage", {
									defaultValue:
										"确定要删除分组“{{name}}”吗？该操作会同时删除分组下的分类。",
									name: selectedItem.name,
								})
							: t("pages.Collection.deleteCategoryMessage", {
									defaultValue:
										"确定要删除分类“{{name}}”吗？游戏本身不会被删除。",
									name: selectedItem.name,
								})
					}
				/>
			)}

			{/* 重命名对话框 */}
			{selectedItem && (
				<InputDialog
					open={renameDialogOpen}
					onClose={() => setRenameDialogOpen(false)}
					onConfirm={handleRenameConfirm}
					title={
						selectedItem.type === "group"
							? t(
									"components.RightMenu.Collection.renameGroupTitle",
									"重命名分组",
								)
							: t(
									"components.RightMenu.Collection.renameCategoryTitle",
									"重命名分类",
								)
					}
					label={
						selectedItem.type === "group"
							? t("components.RightMenu.Collection.newGroupName", "新分组名称")
							: t(
									"components.RightMenu.Collection.newCategoryName",
									"新分类名称",
								)
					}
					placeholder={selectedItem.name}
				/>
			)}

			{/* 管理游戏对话框 */}
			{selectedItem && selectedItem.type === "category" && (
				<ManageGamesDialog
					open={manageGamesDialogOpen}
					onClose={() => setManageGamesDialogOpen(false)}
					categoryId={selectedItem.id}
					categoryName={selectedItem.name}
				/>
			)}
		</Box>
	);
};
