/**
 * @file 全局状态管理
 * @description 使用 Zustand 管理应用全局状态，包括游戏列表、排序、筛选、搜索、UI 状态等，适配 Tauri 与 Web 环境。
 * @module src/store/index
 * @author Skerry contributors (based on ReinaManager)
 * @copyright AGPL-3.0
 *
 * 主要导出：
 * - useStore：Zustand 全局状态管理
 * - initializeStores：初始化全局状态
 *
 * 依赖：
 * - zustand
 * - zustand/middleware
 * - @/types
 * - @/store/gamePlayStore
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
	DEFAULT_MIXED_SOURCE_KEYS,
	MIXED_SOURCE_KEYS,
	MIXED_SOURCE_MAX_COUNT,
	MIXED_SOURCE_MIN_COUNT,
} from "@/metadata/constants";
import { type ProxyConfig, settingsService } from "@/services/invoke";
import type { GameType, SortOption, SortOrder } from "@/services/invoke/types";
import type {
	CloudCollectionSource,
	CustomData,
	GameStaffMember,
	SourceCandidateRecord,
	SourceType,
} from "@/types";
import type {
	CollectionEntitySortField,
	PlayStatusFilter,
} from "@/types/collection";
import { normalizeTagFilters } from "@/utils/game/tagFilter";
import {
	APP_STORE_VERSION,
	migrateAppStorePersistedState,
} from "./appStoreMigrations";
import { initializeGamePlayTracking } from "./gamePlayStore";

export type SelectedCategory =
	| { type: "real"; id: number }
	| { type: "developer"; key: string }
	| null;

export type DataSourceUpdateMode = "search" | "manualId";
export type StartupPage = "home" | "libraries" | "collection";

export interface NextUpVirtualGame {
	id: number;
	name: string;
	nameCn?: string;
	image?: string;
	banner?: string;
	coverAsset?: string;
	bannerAsset?: string;
	aliases?: string[];
	developer?: string;
	summary?: string;
	tags?: string[];
	score?: number;
	date?: string;
	nsfw?: boolean;
	staff?: GameStaffMember[];
	sources?: Array<{ source: string; externalId: string }>;
	idType?: string;
	sourceRecords?: SourceCandidateRecord[];
	userRating?: number;
	userReview?: string;
	customData?: Partial<CustomData>;
	sourceKey: string;
}

const DEFAULT_API_SOURCE: SourceType = "hikarinagi";

/**
 * AppState 全局状态类型定义
 */
export interface CollectionGameFilterSortConfig {
	gameFilterType: GameType;
	playStatusFilter: PlayStatusFilter;
	tagFilters: string[];
	sortOption: SortOption;
	sortOrder: SortOrder;
	showCardSortFieldOverlay: boolean;
}
interface AppState {
	collectionGameFilterSort: CollectionGameFilterSortConfig;
	applyCollectionGameFilterSort: (config: CollectionGameFilterSortConfig) => void;
	collectionGameSearch: string;
	setCollectionGameSearch: (value: string) => void;
	zoomPercent: number;
	setZoomPercent: (percent: number) => void;
	updateSort(option: SortOption, sortOrder: SortOrder): void;

	// UI 状态
	selectedGameId: number | null;
	addModalOpen: boolean;
	addModalPath: string;
	taskManagerOpen: boolean;

	// 排序选项
	sortOption: SortOption;
	sortOrder: SortOrder;
	scopedGameOrders: Record<string, number[]>;
	setScopedGameOrder: (scope: string, gameIds: number[]) => void;
	showCardSortFieldOverlay: boolean;
	setShowCardSortFieldOverlay: (enabled: boolean) => void;
	nextUpGameIds: number[];
	nextUpVirtualGames: NextUpVirtualGame[];
	collectionGroupOrder: string[];
	addNextUpGame: (gameId: number) => void;
	addNextUpVirtualGame: (game: Omit<NextUpVirtualGame, "id">) => void;
	updateNextUpVirtualGame: (
		gameId: number,
		updates: Partial<Omit<NextUpVirtualGame, "id">>,
	) => void;
	replaceNextUpVirtualGame: (virtualId: number, gameId: number) => void;
	removeNextUpGame: (gameId: number) => void;
	setCollectionGroupOrder: (groupIds: string[]) => void;
	setNextUpGameOrder: (gameIds: number[]) => void;

	// 关闭应用时的提醒设置，skip=不再提醒，行为为 'hide' 或 'close'
	skipCloseRemind: boolean;
	defaultCloseAction: "hide" | "close";
	// 设置不再提醒及默认关闭行为
	setSkipCloseRemind: (skip: boolean) => void;
	setDefaultCloseAction: (action: "hide" | "close") => void;

	// 退出时自动备份
	autoBackupOnExit: boolean;
	autoBackupIncludeCovers: boolean;
	autoBackupMinIntervalHours: number;
	autoBackupRetentionCount: number;
	autoBackupLastSuccessAt: number | null;
	autoBackupLastError: string | null;
	setAutoBackupOnExit: (enabled: boolean) => void;
	setAutoBackupIncludeCovers: (enabled: boolean) => void;
	setAutoBackupMinIntervalHours: (hours: number) => void;
	setAutoBackupRetentionCount: (count: number) => void;
	setAutoBackupLastResult: (
		successAt: number | null,
		error: string | null,
	) => void;

	cloudCollectionImportSource: CloudCollectionSource | null;
	openCloudCollectionImport: (source: CloudCollectionSource) => void;

	// UI 操作方法
	setSelectedGameId: (id: number | null) => void;
	openAddModal: (path?: string) => void;
	closeAddModal: () => void;
	setAddModalPath: (path: string) => void;
	openTaskManager: () => void;
	closeTaskManager: () => void;

	// 初始化
	initialize: () => Promise<void>;

	// 搜索相关
	/** 搜索输入框的原始输入值（即时更新，仅 SearchBox 订阅） */
	searchInput: string;
	setSearchInput: (input: string) => void;
	/** 防抖后的搜索关键词（用于游戏列表过滤） */
	searchKeyword: string;
	setSearchKeyword: (keyword: string) => void;

	// 筛选相关
	gameFilterType: GameType;
	setGameFilterType: (type: GameType) => void;
	playStatusFilter: PlayStatusFilter;
	setPlayStatusFilter: (status: PlayStatusFilter) => void;
	tagFilters: string[];
	setTagFilters: (tags: string[]) => void;
	addTagFilter: (tag: string) => void;
	removeTagFilter: (tag: string) => void;
	clearTagFilters: () => void;

	// 数据来源选择
	apiSource: SourceType;
	setApiSource: (source: SourceType) => void;
	mixedEnabledSources: SourceType[];
	toggleMixedSource: (source: SourceType) => void;
	dataSourceUpdateMode: DataSourceUpdateMode;
	setDataSourceUpdateMode: (mode: DataSourceUpdateMode) => void;

	// NSFW相关
	nsfwFilter: boolean;
	setNsfwFilter: (enabled: boolean) => void;
	nsfwCoverReplace: boolean;
	setNsfwCoverReplace: (enabled: boolean) => void;

	// 卡片交互模式
	cardClickMode: "navigate" | "select";
	setCardClickMode: (mode: "navigate" | "select") => void;

	// 启动默认页面
	startupPage: StartupPage;
	setStartupPage: (page: StartupPage) => void;

	// TAG翻译功能
	tagTranslation: boolean;
	setTagTranslation: (enabled: boolean) => void;

	// 收藏同步开关
	syncBgmCollection: boolean;
	setSyncBgmCollection: (enabled: boolean) => void;
	syncVndbCollection: boolean;
	setSyncVndbCollection: (enabled: boolean) => void;
	syncHikarinagiCollection: boolean;
	setSyncHikarinagiCollection: (enabled: boolean) => void;

	// 剧透等级
	spoilerLevel: number;
	setSpoilerLevel: (level: number) => void;

	// 计时模式：playtime = 真实游戏时间（仅活跃时），elapsed = 游戏启动时间（从启动到结束）
	timeTrackingMode: "playtime" | "elapsed";
	setTimeTrackingMode: (mode: "playtime" | "elapsed") => void;

	// 分组分类选择状态
	currentGroupId: string | null; // 当前选中的分组ID
	selectedCategory: SelectedCategory; // 当前选中的分类
	setCurrentGroup: (groupId: string | null) => void; // 设置当前分组
	setSelectedCategory: (category: SelectedCategory) => void; // 设置当前选中的分类
	collectionEntitySortField: CollectionEntitySortField;
	collectionEntitySortOrder: SortOrder;
	setCollectionEntitySort: (
		field: CollectionEntitySortField,
		order: SortOrder,
	) => void;
	developerCategorySortField: CollectionEntitySortField;
	developerCategorySortOrder: SortOrder;
	setDeveloperCategorySort: (
		field: CollectionEntitySortField,
		order: SortOrder,
	) => void;
	collectionGroupSearch: string;
	setCollectionGroupSearch: (value: string) => void;
	collectionCategorySearch: string;
	setCollectionCategorySearch: (value: string) => void;
	developerCategorySearch: string;
	setDeveloperCategorySearch: (value: string) => void;

	// 代理设置
	proxyConfig: ProxyConfig;
	setProxyConfig: (config: ProxyConfig) => void;
}

// 创建持久化的全局状态
export const useStore = create<AppState>()(
		// ...

	persist(
		(set, get) => ({
			// UI 状态
			selectedGameId: null,
			addModalOpen: false,
			addModalPath: "",
			taskManagerOpen: false,

			searchInput: "",
			searchKeyword: "",

			gameFilterType: "all",
			playStatusFilter: "all",
			tagFilters: [],

			// 排序选项默认值
			sortOption: "addtime",
			sortOrder: "desc",
			scopedGameOrders: {},
			showCardSortFieldOverlay: false,
			zoomPercent: 100,
			collectionGameFilterSort: {
				gameFilterType: "all",
				playStatusFilter: "all",
				tagFilters: [],
				sortOption: "addtime",
				sortOrder: "asc",
				showCardSortFieldOverlay: false,
			},
			applyCollectionGameFilterSort: (config) => set({ collectionGameFilterSort: config }),
			collectionGameSearch: "",
			setCollectionGameSearch: (value) => set({ collectionGameSearch: value }),

			setZoomPercent: (percent: number) => set({ zoomPercent: percent }),
			nextUpGameIds: [],
			nextUpVirtualGames: [],
			collectionGroupOrder: [],

			// 关闭应用时的提醒设置，skip=不再提醒，行为为 'hide' 或 'close'
			skipCloseRemind: false,
			defaultCloseAction: "hide",
			// Setter: 不再提醒和默认关闭行为
			setSkipCloseRemind: (skip: boolean) => set({ skipCloseRemind: skip }),
			setDefaultCloseAction: (action: "hide" | "close") =>
				set({ defaultCloseAction: action }),

			// 退出时自动备份
			autoBackupOnExit: false,
			autoBackupIncludeCovers: false,
			autoBackupMinIntervalHours: 6,
			autoBackupRetentionCount: 7,
			autoBackupLastSuccessAt: null,
			autoBackupLastError: null,
			setAutoBackupOnExit: (enabled: boolean) =>
				set({ autoBackupOnExit: enabled }),
			setAutoBackupIncludeCovers: (enabled: boolean) =>
				set({ autoBackupIncludeCovers: enabled }),
			setAutoBackupMinIntervalHours: (hours: number) => {
				const nextHours = Number.isFinite(hours) ? hours : 0;
				set({
					autoBackupMinIntervalHours: Math.max(0, Math.floor(nextHours)),
				});
			},
			setAutoBackupRetentionCount: (count: number) => {
				const nextCount = Number.isFinite(count) ? count : 1;
				set({
					autoBackupRetentionCount: Math.max(1, Math.floor(nextCount)),
				});
			},
			setAutoBackupLastResult: (
				successAt: number | null,
				error: string | null,
			) =>
				set((state) => ({
					autoBackupLastSuccessAt: successAt ?? state.autoBackupLastSuccessAt,
					autoBackupLastError: error,
				})),

			// 数据来源选择
			apiSource: DEFAULT_API_SOURCE,
			setApiSource: (source: SourceType) => {
				set({ apiSource: source });
			},
			mixedEnabledSources: [...DEFAULT_MIXED_SOURCE_KEYS],
			toggleMixedSource: (source: SourceType) => {
				set((state) => {
					const current = state.mixedEnabledSources;
					const enabledAfterAdd = MIXED_SOURCE_KEYS.filter(
						(item) => item === source || current.includes(item),
					);
					const nextSources = current.includes(source)
						? current.filter((item) => item !== source)
						: enabledAfterAdd;

					return nextSources.length >= MIXED_SOURCE_MIN_COUNT &&
						nextSources.length <= MIXED_SOURCE_MAX_COUNT
						? { mixedEnabledSources: nextSources }
						: {};
				});
			},
			dataSourceUpdateMode: "search",
			setDataSourceUpdateMode: (mode: DataSourceUpdateMode) => {
				set({ dataSourceUpdateMode: mode });
			},

			cloudCollectionImportSource: null,
			openAddModal: (path?: string) => {
				const nextPath = path ?? get().addModalPath;
				const { addModalOpen, addModalPath } = get();
				if (addModalOpen && addModalPath === nextPath) return;
				set({
					addModalOpen: true,
					addModalPath: nextPath,
					cloudCollectionImportSource: null,
				});
			},
			openCloudCollectionImport: (source: CloudCollectionSource) => {
				set({
					addModalOpen: true,
					addModalPath: "",
					cloudCollectionImportSource: source,
				});
			},
			closeAddModal: () => {
				set({ addModalOpen: false, cloudCollectionImportSource: null });
			},
			setAddModalPath: (path: string) => {
				set({ addModalPath: path });
			},
			openTaskManager: () => {
				set({ taskManagerOpen: true });
			},
			closeTaskManager: () => {
				set({ taskManagerOpen: false });
			},

			// NSFW相关
			nsfwFilter: false,
			setNsfwFilter: (enabled: boolean) => {
				set({ nsfwFilter: enabled });
			},
			nsfwCoverReplace: false,
			setNsfwCoverReplace: (enabled: boolean) => {
				set({ nsfwCoverReplace: enabled });
			},

			// 卡片交互模式
			cardClickMode: "navigate",
			setCardClickMode: (mode: "navigate" | "select") => {
				set({ cardClickMode: mode });
			},

			// 启动默认页面
			startupPage: "home",
			setStartupPage: (page: StartupPage) => set({ startupPage: page }),

			// TAG翻译功能（默认关闭）
			tagTranslation: false,
			setTagTranslation: (enabled: boolean) => {
				set({ tagTranslation: enabled });
			},

			// 收藏同步开关（默认关闭）
			syncBgmCollection: false,
			setSyncBgmCollection: (enabled: boolean) => {
				set({ syncBgmCollection: enabled });
			},
			syncVndbCollection: false,
			setSyncVndbCollection: (enabled: boolean) => {
				set({ syncVndbCollection: enabled });
			},
			syncHikarinagiCollection: false,
			setSyncHikarinagiCollection: (enabled: boolean) => {
				set({ syncHikarinagiCollection: enabled });
			},

			// 剧透等级
			spoilerLevel: 0,
			setSpoilerLevel: (level: number) => {
				set({ spoilerLevel: level });
			},

			// 计时模式：默认使用活跃时间（真实游戏时间）
			timeTrackingMode: "playtime",
			setTimeTrackingMode: (mode: "playtime" | "elapsed") => {
				set({ timeTrackingMode: mode });
			},
			setSearchInput: (input: string) => {
				set({ searchInput: input });
			},
			setSearchKeyword: (keyword: string) => {
				set({ searchKeyword: keyword });
			},

			// 排序偏好更新（数据刷新由 React Query 参数驱动）
			updateSort: (option: SortOption, order: SortOrder) => {
				const prevOption = get().sortOption;
				const prevOrder = get().sortOrder;

				// 如果排序选项和顺序都没变，不做任何操作
				if (prevOption === option && prevOrder === order) return;

				// 设置排序选项
				set({
					sortOption: option,
					sortOrder: order,
				});
			},
			setScopedGameOrder: (scope: string, gameIds: number[]) => {
				const nextIds = [...new Set(gameIds)];
				set((state) => {
					const currentIds = state.scopedGameOrders[scope];
					if (
						currentIds &&
						currentIds.length === nextIds.length &&
						currentIds.every((id, index) => id === nextIds[index])
					) {
						return state;
					}
					return {
						scopedGameOrders: {
							...state.scopedGameOrders,
							[scope]: nextIds,
						},
					};
				});
			},
			setShowCardSortFieldOverlay: (enabled: boolean) => {
				set({ showCardSortFieldOverlay: enabled });
			},
			addNextUpGame: (gameId: number) => {
				set((state) =>
					state.nextUpGameIds.includes(gameId)
						? state
						: { nextUpGameIds: [...state.nextUpGameIds, gameId] },
				);
			},
			addNextUpVirtualGame: (game) => {
				set((state) => {
					const existing = state.nextUpVirtualGames.find(
						(item) => item.sourceKey === game.sourceKey,
					);
					if (existing) {
						return state.nextUpGameIds.includes(existing.id)
							? state
							: { nextUpGameIds: [...state.nextUpGameIds, existing.id] };
					}

					const usedIds = new Set(
						state.nextUpVirtualGames.map((item) => item.id),
					);
					let id = -Date.now();
					while (usedIds.has(id)) id -= 1;
					return {
						nextUpVirtualGames: [...state.nextUpVirtualGames, { ...game, id }],
						nextUpGameIds: [...state.nextUpGameIds, id],
					};
				});
			},
			updateNextUpVirtualGame: (gameId, updates) => {
				set((state) => ({
					nextUpVirtualGames: state.nextUpVirtualGames.map((game) =>
						game.id === gameId ? { ...game, ...updates } : game,
					),
				}));
			},
			replaceNextUpVirtualGame: (virtualId, gameId) => {
				set((state) => ({
					nextUpGameIds: state.nextUpGameIds.map((id) =>
						id === virtualId ? gameId : id,
					),
					nextUpVirtualGames: state.nextUpVirtualGames.filter(
						(game) => game.id !== virtualId,
					),
				}));
			},
			removeNextUpGame: (gameId: number) => {
				set((state) => ({
					nextUpGameIds: state.nextUpGameIds.filter((id) => id !== gameId),
					nextUpVirtualGames: state.nextUpVirtualGames.filter(
						(game) => game.id !== gameId,
					),
				}));
			},
			setCollectionGroupOrder: (groupIds: string[]) => {
				set({ collectionGroupOrder: [...new Set(groupIds)] });
			},
			setNextUpGameOrder: (gameIds: number[]) => {
				set({ nextUpGameIds: [...new Set(gameIds)] });
			},

			// UI 操作方法
			setSelectedGameId: (id: number | null) => {
				set({ selectedGameId: id });
			},

			// 筛选偏好更新（数据刷新由 React Query 参数驱动）
			setGameFilterType: (type: GameType) => {
				const prevType = get().gameFilterType;

				// 如果类型没变，不做任何操作
				if (prevType === type) return;

				// 设置新的筛选类型
				set({ gameFilterType: type });
			},
			setPlayStatusFilter: (status: PlayStatusFilter) => {
				const prevStatus = get().playStatusFilter;

				if (prevStatus === status) return;

				set({ playStatusFilter: status });
			},
			setTagFilters: (tags: string[]) => {
				set({ tagFilters: normalizeTagFilters(tags) });
			},
			addTagFilter: (tag: string) => {
				const trimmed = tag.trim();
				if (!trimmed) return;
				const current = get().tagFilters;
				if (
					current.some((item) => item.toLowerCase() === trimmed.toLowerCase())
				) {
					return;
				}
				set({ tagFilters: [...current, trimmed] });
			},
			removeTagFilter: (tag: string) => {
				const normalized = tag.toLowerCase();
				set({
					tagFilters: get().tagFilters.filter(
						(item) => item.toLowerCase() !== normalized,
					),
				});
			},
			clearTagFilters: () => {
				set({ tagFilters: [] });
			},

			// 分组分类选择状态初始值
			currentGroupId: null,
			selectedCategory: null,
			collectionEntitySortField: "created_at",
			collectionEntitySortOrder: "asc",
			developerCategorySortField: "game_count",
			developerCategorySortOrder: "desc",
			collectionGroupSearch: "",
			collectionCategorySearch: "",
			developerCategorySearch: "",

			// 设置当前分组
			setCurrentGroup: (groupId: string | null) => {
				set({
					currentGroupId: groupId,
					selectedCategory: null,
				});
			},

			// 设置当前选中的分类
			setSelectedCategory: (category: SelectedCategory) => {
				set({ selectedCategory: category });
			},
			setCollectionEntitySort: (
				field: CollectionEntitySortField,
				order: SortOrder,
			) => {
				set({
					collectionEntitySortField: field,
					collectionEntitySortOrder: order,
				});
			},
			setDeveloperCategorySort: (
				field: CollectionEntitySortField,
				order: SortOrder,
			) => {
				set({
					developerCategorySortField: field,
					developerCategorySortOrder: order,
				});
			},
			setCollectionGroupSearch: (value: string) => {
				set({ collectionGroupSearch: value });
			},
			setCollectionCategorySearch: (value: string) => {
				set({ collectionCategorySearch: value });
			},
			setDeveloperCategorySearch: (value: string) => {
				set({ developerCategorySearch: value });
			},

			// 代理设置
			proxyConfig: {
				url: "",
			},
			setProxyConfig: (config: ProxyConfig) => {
				set({ proxyConfig: config });
				settingsService.updateProxyConfig(config).catch(console.error);
			},

			// 初始化方法
			initialize: async () => {
				const { proxyConfig } = get();
				await Promise.all([
					// 初始化游戏时间跟踪（数据获取由 React Query 自动触发）
					initializeGamePlayTracking().catch((error) => {
						console.error("初始化游戏时间跟踪失败:", error);
					}),
					// 启动时同步代理设置到后端
					settingsService.updateProxyConfig(proxyConfig).catch(console.error),
				]);
			},
		}),
		{
			name: "skerry-store",
			// 可选：定义哪些字段需要持久化存储
			partialize: (state) => ({
				// 排序偏好
				sortOption: state.sortOption,
				sortOrder: state.sortOrder,
				scopedGameOrders: state.scopedGameOrders,
				showCardSortFieldOverlay: state.showCardSortFieldOverlay,
				zoomPercent: state.zoomPercent,
				collectionGameFilterSort: state.collectionGameFilterSort,
				nextUpGameIds: state.nextUpGameIds,
				nextUpVirtualGames: state.nextUpVirtualGames,
				collectionGroupOrder: state.collectionGroupOrder,
				// 筛选偏好
				gameFilterType: state.gameFilterType,
				playStatusFilter: state.playStatusFilter,
				// 关闭应用相关
				skipCloseRemind: state.skipCloseRemind,
				defaultCloseAction: state.defaultCloseAction,
				autoBackupOnExit: state.autoBackupOnExit,
				autoBackupIncludeCovers: state.autoBackupIncludeCovers,
				autoBackupMinIntervalHours: state.autoBackupMinIntervalHours,
				autoBackupRetentionCount: state.autoBackupRetentionCount,
				autoBackupLastSuccessAt: state.autoBackupLastSuccessAt,
				autoBackupLastError: state.autoBackupLastError,
				// 数据来源选择
				apiSource: state.apiSource,
				mixedEnabledSources: state.mixedEnabledSources,
				dataSourceUpdateMode: state.dataSourceUpdateMode,
				// nsfw相关
				nsfwFilter: state.nsfwFilter,
				nsfwCoverReplace: state.nsfwCoverReplace,
				// 卡片点击模式
				cardClickMode: state.cardClickMode,
				// 启动默认页面
				startupPage: state.startupPage,
				// VNDB标签翻译
				tagTranslation: state.tagTranslation,
				// 收藏同步开关
				syncBgmCollection: state.syncBgmCollection,
				syncVndbCollection: state.syncVndbCollection,
				syncHikarinagiCollection: state.syncHikarinagiCollection,
				// 剧透等级
				spoilerLevel: state.spoilerLevel,
				// 计时模式：playtime 或 elapsed
				timeTrackingMode: state.timeTrackingMode,
				// 分组分类选择状态
				currentGroupId: state.currentGroupId,
				selectedCategory: state.selectedCategory,
				// 代理设置
				proxyConfig: { url: state.proxyConfig.url },
			}),
			version: APP_STORE_VERSION,
			migrate: migrateAppStorePersistedState,
		},
	),
);

/**
 * initializeStores
 * 初始化全局状态，加载游戏与分类数据，并初始化游戏时间跟踪
 */
export const initializeStores = async (): Promise<void> => {
	await useStore.getState().initialize();
};
