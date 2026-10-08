import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import {
	type CSSProperties,
	type MouseEvent,
	memo,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { VirtuosoGrid } from "react-virtuoso";
import { GameListStateView } from "@/components/GameListStateView";
import { useFlipMotion } from "@/components/motion/useFlipMotion";
import { useVirtuosoGridRestore } from "@/hooks/common/useScrollRestore";
import { isVirtualCategory } from "@/hooks/features/collections/useVirtualCollections";
import type { Category } from "@/types/collection";
import { EntityCard } from "./EntityCard";

const CATEGORY_WIDE_BREAKPOINT = 1200;
const CATEGORY_GRID_TEMPLATE_COLUMNS = {
	md: "repeat(3, 1fr)",
	lg: "repeat(4, 1fr)",
};
const DEVELOPER_CATEGORY_GRID_ROW_HEIGHT = 112;
const DEVELOPER_CATEGORY_GRID_CLASS =
	"collection-developer-category-grid grid gap-4 pb-4 [grid-template-columns:repeat(var(--collection-category-columns),minmax(0,1fr))]";

export interface CollectionGroupListItem {
	id: string;
	name: string;
	game_count: number;
}

interface CollectionGroupViewProps {
	groups: CollectionGroupListItem[];
	onGroupClick: (groupId: string) => void;
	onContextMenu: (
		event: MouseEvent,
		groupId: string,
		groupName: string,
	) => void;
}

interface BaseCategoryViewProps {
	categories: Category[];
	sourceCount: number;
	onCategoryClick: (category: Category) => void;
	onContextMenu: (
		event: MouseEvent,
		categoryId: number,
		categoryName: string,
	) => void;
}

type CollectionCategoryViewProps = BaseCategoryViewProps &
	(
		| {
				mode: "developer";
				loading: boolean;
				error: unknown;
				scrollKey: string;
		  }
		| { mode: "real" }
	);

function CollectionEmptyState({ message }: { message: string }) {
	return (
		<Box
			sx={{
				display: "flex",
				justifyContent: "center",
				alignItems: "center",
				minHeight: "400px",
			}}
		>
			<Typography variant="h6" color="text.secondary">
				{message}
			</Typography>
		</Box>
	);
}

function getCategoryColumnCount(): number {
	return window.innerWidth >= CATEGORY_WIDE_BREAKPOINT ? 4 : 3;
}

function useCategoryColumnCount(): number {
	const [columns, setColumns] = useState(() => getCategoryColumnCount());

	useEffect(() => {
		const media = window.matchMedia(
			`(min-width: ${CATEGORY_WIDE_BREAKPOINT}px)`,
		);
		const onChange = (event: MediaQueryListEvent) => {
			setColumns(event.matches ? 4 : 3);
		};
		media.addEventListener("change", onChange);
		return () => {
			media.removeEventListener("change", onChange);
		};
	}, []);

	return columns;
}

interface DeveloperCategoryGridProps {
	categories: Category[];
	columns: number;
	renderCategory: (category: Category) => React.ReactNode;
	scrollKey: string;
}

function DeveloperCategoryGrid({
	categories,
	columns,
	renderCategory,
	scrollKey,
}: DeveloperCategoryGridProps) {
	const [scrollViewport, setScrollViewport] = useState<HTMLDivElement | null>(
		null,
	);
	const scrollIdleTimerRef = useRef<number | null>(null);
	const { restoreProps, scrollParent, stateChanged } =
		useVirtuosoGridRestore({
			columns,
			itemCount: categories.length,
			rowHeight: DEVELOPER_CATEGORY_GRID_ROW_HEIGHT,
			scrollKey,
			containerSelector: ".collection-developer-category-viewport",
			scrollParentElement: scrollViewport,
			wrapperElement: scrollViewport,
			preferScrollParentElement: true,
		});
	const setViewportRef = useCallback(
		(node: HTMLDivElement | null) => {
			setScrollViewport(node);
		},
		[],
	);
	const handleScrollActivity = useCallback(() => {
		if (!scrollViewport) return;
		scrollViewport.classList.add("is-scrolling");
		if (scrollIdleTimerRef.current !== null) {
			window.clearTimeout(scrollIdleTimerRef.current);
		}
		scrollIdleTimerRef.current = window.setTimeout(() => {
			scrollIdleTimerRef.current = null;
			scrollViewport.classList.remove("is-scrolling");
		}, 140);
	}, [scrollViewport]);

	useEffect(() => {
		return () => {
			if (scrollIdleTimerRef.current !== null) {
				window.clearTimeout(scrollIdleTimerRef.current);
				scrollIdleTimerRef.current = null;
			}
			scrollViewport?.classList.remove("is-scrolling");
		};
	}, [scrollViewport]);

	return (
		<div
			ref={setViewportRef}
			className="collection-developer-category-viewport flex-1 min-h-0"
			data-scroll-restore-key={scrollKey}
			onScroll={handleScrollActivity}
		>
			{scrollParent ? (
				<VirtuosoGrid
					key={scrollKey}
					customScrollParent={scrollParent}
					data={categories}
					computeItemKey={(index, category) =>
						category
							? "category-" + (category.virtualKey ?? category.id)
							: "missing-category-" + index
					}
					listClassName={DEVELOPER_CATEGORY_GRID_CLASS}
					itemClassName="min-w-0 h-112px"
					increaseViewportBy={{ top: 160, bottom: 360 }}
					stateChanged={stateChanged}
					{...restoreProps}
					style={
						{
							"--collection-category-columns": columns,
						} as CSSProperties
					}
					itemContent={(_, category) =>
						category ? renderCategory(category) : null
					}
				/>
			) : null}
		</div>
	);
}

export function CollectionGroupView({
	groups,
	onGroupClick,
	onContextMenu,
}: CollectionGroupViewProps) {
	const { t } = useTranslation();
	const groupGridRef = useFlipMotion<HTMLDivElement>(
		groups.map((group) => group.id).join(","),
	);

	if (groups.length === 0) {
		return (
			<CollectionEmptyState
				message={t(
					"pages.Collection.entitySearch.noGroups",
					"没有找到匹配的分组",
				)}
			/>
		);
	}

	return (
		<Box
			ref={groupGridRef}
			className="collection-groups-viewport flex-1 min-h-0"
			sx={{
				display: "grid",
				gridTemplateColumns: CATEGORY_GRID_TEMPLATE_COLUMNS,
				gap: 2,
				overflowY: "auto",
				overflowX: "hidden",
				scrollbarWidth: "none",
				"&::-webkit-scrollbar": { display: "none" },
			}}
		>
			{groups.map((group) => {
				const isDefault = group.id.startsWith("default_");
				return (
					<EntityCard
						key={group.id}
						entity={{
							id: group.id,
							name: group.name,
							count: group.game_count,
						}}
						onClick={() => onGroupClick(group.id)}
						onContextMenu={(event, id, name) => {
							if (!isDefault) onContextMenu(event, id as string, name);
						}}
						countLabel={t("pages.Collection.gamesCount", "个游戏")}
					/>
				);
			})}
		</Box>
	);
}

const CategoryCard = memo(function CategoryCard({
	category,
	onCategoryClick,
	onContextMenu,
}: Pick<BaseCategoryViewProps, "onCategoryClick" | "onContextMenu"> & {
	category: Category;
}) {
	const { t } = useTranslation();
	const isVirtual = isVirtualCategory(category.id);

	return (
		<EntityCard
			entity={{
				id: category.id,
				name: category.name,
				count: category.game_count,
			}}
			title={category.name}
			fillHeight={isVirtual}
			titleNoWrap={isVirtual}
			onClick={() => onCategoryClick(category)}
			onContextMenu={(event, id, name) => {
				if (!isVirtual) onContextMenu(event, id as number, name);
			}}
			countLabel={t("pages.Collection.gamesCount", "个游戏")}
		/>
	);
}, (prev, next) =>
	prev.category.id === next.category.id &&
	prev.category.name === next.category.name &&
	prev.category.game_count === next.category.game_count &&
	prev.onCategoryClick === next.onCategoryClick &&
	prev.onContextMenu === next.onContextMenu,
);

function DeveloperCategoryView(
	props: Extract<CollectionCategoryViewProps, { mode: "developer" }>,
) {
	const { t } = useTranslation();
	const columns = useCategoryColumnCount();
	const renderCategory = useCallback((category: Category) => (
		<CategoryCard
			category={category}
			onCategoryClick={props.onCategoryClick}
			onContextMenu={props.onContextMenu}
		/>
	), [props.onCategoryClick, props.onContextMenu]);

	return (
		<GameListStateView
			loading={props.loading}
			error={props.error}
			empty={props.categories.length === 0}
			emptyMessage={
				props.sourceCount === 0
					? t("pages.Collection.noCategoriesHint", "当前分组下没有分类")
					: t(
							"pages.Collection.developerSearch.noResults",
							"没有找到匹配的开发商",
						)
			}
		>
			<DeveloperCategoryGrid
				categories={props.categories}
				columns={columns}
				renderCategory={renderCategory}
				scrollKey={props.scrollKey}
			/>
		</GameListStateView>
	);
}

export function CollectionCategoryView(props: CollectionCategoryViewProps) {
	const { t } = useTranslation();
	const categoryGridRef = useFlipMotion<HTMLDivElement>(
		props.categories.map((category) => category.id).join(","),
	);

	if (props.mode === "developer") {
		return <DeveloperCategoryView {...props} />;
	}

	if (props.categories.length === 0) {
		return (
			<CollectionEmptyState
				message={
					props.sourceCount === 0
						? t("pages.Collection.noCategoriesHint", "当前分组下没有分类")
						: t(
								"pages.Collection.entitySearch.noCategories",
								"没有找到匹配的分类",
							)
				}
			/>
		);
	}

	return (
		<Box
			ref={categoryGridRef}
			className="collection-categories-viewport flex-1 min-h-0"
			sx={{
				display: "grid",
				gridTemplateColumns: CATEGORY_GRID_TEMPLATE_COLUMNS,
				gap: 2,
				overflowY: "auto",
				overflowX: "hidden",
				scrollbarWidth: "none",
				"&::-webkit-scrollbar": { display: "none" },
			}}
		>
			{props.categories.map((category) => (
				<CategoryCard
					key={category.id}
					category={category}
					onCategoryClick={props.onCategoryClick}
					onContextMenu={props.onContextMenu}
				/>
			))}
		</Box>
	);
}
