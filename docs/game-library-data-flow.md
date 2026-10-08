# 游戏库数据出库与缓存链路

本文档描述游戏库数据从后端出库到前端展示、索引缓存、读写更新的主要链路。目标是让后续开发能判断应该读哪份数据、更新哪层缓存，以及哪些操作会触发全量重建。

## 核心数据形态

### FullGameData

`FullGameData` 是后端 `games` 表的原始读取结果，对应 `src/types/types.ts` 中的读取 DTO。

特点：

- 包含数据库主键、基础字段和所有 JSON 元数据列。
- 包含由 `game_sources` 表聚合而成的 `sources` 数组（存储各平台的原始数据与外部 ID），以及 `custom_data`。
- 是 React Query 中 `gameKeys.all` 的缓存内容。
- 用于写入 patch、详情编辑、数据源切换等需要完整元数据的场景。

### GameData

`GameData` 是展示层数据，由 `getDisplayGameData(fullData)` 从 `FullGameData` 派生（定义在 `src/metadata/data/dataTransform.ts`）。

特点：

- 不包含原始的 `sources` 聚合元数据记录。
- 将当前显示源、混合源和自定义覆盖逻辑展平成 `name`、`image`、`summary`、`developer`、`tags` 等展示字段。
- 用于卡片、详情展示、搜索、开发商分类等 UI 场景。

### GameIndex

`GameIndex` 是前端派生索引，定义在 `src/utils/game/gameIndex.ts`。

当前结构：

```ts
interface GameIndex {
  rawList: FullGameData[];
  rawById: Map<number, FullGameData>;
  displayList: GameData[];
  displayById: Map<number, GameData>;
  ids: number[];
  sourceAvailabilityById: Map<number, SourceAvailability>;
  developerCategories: Category[];
  developerGameIdsByName: Map<string, number[]>;
}
```

用途：

- 作为 `FullGameData[] -> GameData[] / Map` 的派生缓存。
- 避免卡片、详情、分类页面重复从 `FullGameData` 临时转换。
- 提供开发商虚拟分类索引和数据源可用性索引。

## 后端出库接口

游戏数据后端命令在 `src-tauri/src/database/service.rs`，前端封装在 `src/services/invoke/gameService.ts`。

主要读取接口：

- `find_all_games`：返回 `FullGameData[]`。
- `find_game_ids`：只返回排序和筛选后的 `number[]`。
- `find_game_by_id`：返回单个 `FullGameData | null`。
- `get_all_bgm_ids` / `get_all_vndb_ids`：返回外部 ID 去重辅助数据。

主要写入接口：

- `insert_game`：返回新增后的完整 `FullGameData`。
- `insert_games_batch`：返回 `BatchOperationResult`，其中 `games` 是新增成功的完整游戏列表。
- `update_game`：返回更新后的完整 `FullGameData`。
- `update_games_batch`：返回更新后的 `FullGameData[]`。
- `delete_game` / `delete_games_batch`：返回影响行数，前端按已知 ID 移除缓存。

写入接口返回完整游戏数据的目的：前端可以增量 patch `gameKeys.all` 和 `GameIndex`，避免为少量更新重新拉取全量游戏库。

## React Query 缓存

`gameKeys` 定义在 `src/hooks/queries/useGames.ts`。

```ts
gameKeys.all        // FullGameData[]
gameKeys.index()    // GameIndex
gameKeys.idLists()  // 排序/筛选 ID 列表前缀
gameKeys.idList(p)  // 某组排序/筛选参数下的 number[]
gameKeys.bgmIds()   // BGM ID 去重辅助缓存
gameKeys.vndbIds()  // VNDB ID 去重辅助缓存
```

### gameKeys.all

`gameKeys.all` 是原始游戏库缓存，也是服务端状态的主缓存。

读取入口：

```ts
const allGamesQuery = useAllGames();
```

原则：

- 业务代码不应直接 `setQueryData(gameKeys.all, ...)`。
- 写入应通过 `gameCachePatch.ts` 或 `useGames.ts` 中的 mutation hook。
- 如果确实全量重拉，`GameIndex` 会重新派生。

### gameKeys.index()

`gameKeys.index()` 保存 `GameIndex` 派生索引。

读取入口：

```ts
const { index } = useGameIndex();
```

`useGameIndex` 会先检查 React Query 中的 `gameKeys.index()`。当 `index.rawList === allGamesQuery.data` 时直接复用；否则通过 `getGameIndex(allGamesQuery.data)` 构建或读取 WeakMap 缓存。

注意：React Query 默认有 structural sharing。`gameCachePatch.ts` 在提交缓存后会读取 React Query 实际保存的 `FullGameData[]` 引用，再把这个引用绑定到 `GameIndex.rawList` 和 WeakMap 缓存，避免引用不一致导致全量重建。

### gameKeys.idList()

`gameKeys.idList(params)` 是后端轻量排序/筛选结果，只传输 ID。

读取入口：

```ts
const gameIdListQuery = useGameIdList(gameType, sortOption, sortOrder);
```

说明：

- `FullGameData[]` 已在前端缓存。
- 切换基础类型筛选或排序时，只需要从后端取 ID 列表。
- 展示时再从 `GameIndex.displayById` 按 ID 取 `GameData`。

## 读取链路

### 游戏列表

入口：`useGameListFacade()`。

链路：

1. `useAllGames()` 读取 `FullGameData[]`。
2. `useGameIndex()` 派生或复用 `GameIndex`。
3. `useGameIdList()` 读取排序/筛选后的 ID。
4. `useFilteredGamesFacade()` 从 `index.displayById` 取 `GameData`，应用游玩状态和 NSFW 过滤。
5. `useGameListFacade()` 在基础过滤结果上应用搜索。
6. `VirtualCardsGrid` / `CardsGrid` 用 `gameIds + displayById` 渲染卡片。

示例：

```ts
const { gameIds, displayById, isLoading } = useGameListFacade();

return <VirtualCardsGrid gameIds={gameIds} displayById={displayById} />;
```

### 单个游戏详情

入口：`useGameById(gameId)`。

链路：

```ts
const gameIndexQuery = useGameIndex();
const selectedGame =
  gameId === null
    ? null
    : gameIndexQuery.index.displayById.get(gameId) ?? null;
```

详情页默认读 `GameData`。只有需要完整元数据时才应读 `index.rawById` 或调用后端详情接口。

### 开发商虚拟分类

开发商分类来自 `GameIndex`：

- `developerCategories`
- `developerGameIdsByName`
- `developerGameIdsByCategoryId`

开发商虚拟分类 ID 根据开发商名称稳定生成，不再使用排序下标。这样删除游戏导致开发商数量变化时，当前分类不会漂移到另一个开发商。

## 写入链路

统一缓存 patch 工具在 `src/hooks/queries/gameCachePatch.ts`。

当前公开函数：

```ts
patchGameCaches(queryClient, gameKeys, updatedFullGame);
patchManyGameCaches(queryClient, gameKeys, updatedFullGames);
appendGamesToCaches(queryClient, gameKeys, insertedFullGames);
removeGamesFromCaches(queryClient, gameKeys, gameIds);
```

这些函数负责同时维护：

- `gameKeys.all`
- `gameKeys.index()`
- WeakMap 中的 `FullGameData[] -> GameIndex` 派生缓存

### 新增单个游戏

入口：`useAddGame()`。

链路：

1. `gameService.insertGame(params)`。
2. 后端返回新增后的 `FullGameData`。
3. `appendGamesToCaches(...)` 追加到 `gameKeys.all` 和 `GameIndex`。
4. invalidate `gameKeys.idLists()`。
5. invalidate `gameKeys.bgmIds()` / `gameKeys.vndbIds()`。
6. invalidate `collections`。

示例：

```ts
const addGameMutation = useAddGame();
const game = await addGameMutation.mutateAsync(payload);
showGameAddedSuccess({ gameId: game.id, navigate, t });
```

### 批量新增游戏

入口：`useBatchAddGames()`。

链路：

1. `gameService.insertGamesBatch(payloads)`。
2. 后端返回 `BatchOperationResult`。
3. `result.games` 中的成功项通过 `appendGamesToCaches(...)` 追加。
4. invalidate ID 列表、外部 ID 去重缓存和合集缓存。

### 更新单个游戏

入口：`useUpdateGame()`。

链路：

1. `gameService.updateGame(gameId, updates)`。
2. 后端返回更新后的 `FullGameData`。
3. `patchGameCaches(...)` 替换 `gameKeys.all` 中对应项。
4. `patchGameIndex(...)` 只转换该游戏的 `GameData`。
5. 如果更新字段会影响排序/筛选，invalidate `gameKeys.idLists()`。
6. 如果更新 `bgm_id` 或 `vndb_id`，invalidate 外部 ID 去重缓存。

示例：

```ts
const updateGameMutation = useUpdateGame();

await updateGameMutation.mutateAsync({
  gameId,
  updates: {
    id_type: "vndb",
  },
});
```

### 批量更新游戏

入口：`useBatchUpdateGames()` 或 `gameService.updateBatch(...)` 后手动 patch。

标准链路：

```ts
const updatedGames = await gameService.updateBatch(updates);
patchManyGameCaches(queryClient, gameKeys, updatedGames);
queryClient.invalidateQueries({ queryKey: gameKeys.idLists() });
```

`patchManyGameIndex(...)` 是真正的批量 patch：

- 对每个更新项只执行一次 `getDisplayGameData`。
- 一次性更新 `rawById`、`displayById`、`sourceAvailabilityById`。
- 一次性替换 `rawList` 和 `displayList`。
- 如果任意游戏的 developer 变化，最后只重建一次 developer index。
- 不再因为更新比例较高而全量转换整个游戏库。

### 删除游戏

入口：

- `useDeleteGame()`
- `useDeleteGames()`

链路：

1. 后端删除并返回影响行数。
2. `removeGamesFromCaches(...)` 从 `gameKeys.all` 和 `GameIndex` 删除对应 ID。
3. invalidate ID 列表、合集缓存和统计缓存。

### 游玩状态更新

入口：`useGameStatusActions()`。

链路：

1. 先读取当前 `gameKeys.all` 和 `gameKeys.index()`，保存回滚快照。
2. 用 `patchGameCaches(...)` 做乐观更新。
3. 调用 `useUpdatePlayStatus()` 写后端。
4. 成功后用后端返回的 `FullGameData` 再 patch 一次。
5. 同步云端状态。
6. 失败时恢复 `gameKeys.all` 和 `gameKeys.index()`。

说明：游玩状态更新可能对同一个游戏执行多次 `getDisplayGameData`，但不是全量重建。它来自乐观更新、后端成功 patch 和云同步用的展示数据转换。

## 全量转换发生时机

全量 `getDisplayGameData` 主要发生在以下情况：

- 首次加载 `FullGameData[]`。
- `gameKeys.all` 被真正全量 refetch。
- `GameIndex` 缓存不存在，且 `getGameIndex(allGamesQuery.data)` 无法命中 WeakMap。
- 直接绕过 `gameCachePatch.ts` 修改 `gameKeys.all`，导致 `gameKeys.index()` 与 `gameKeys.all` 引用不匹配。

正常单个游戏更新只应转换该游戏一次或少量几次，不应按游戏库总数转换。

## 开发约束

### 写缓存必须走统一入口

新增写入链路时，优先使用现有 mutation hook：

- `useAddGame`
- `useBatchAddGames`
- `useUpdateGame`
- `useBatchUpdateGames`
- `useDeleteGame`
- `useDeleteGames`

如果必须直接调用 service，例如工具函数中调用 `gameService.updateBatch(...)`，必须随后调用对应 patch 函数：

```ts
const updatedGames = await gameService.updateBatch(updates);
patchManyGameCaches(queryClient, gameKeys, updatedGames);
```

禁止在业务代码中只做：

```ts
queryClient.setQueryData(gameKeys.all, nextGames);
```

这会绕过 `GameIndex`，可能导致下次读取时全量重建。

### ID 列表仍需 invalidate

`GameIndex` 只维护本地数据字典和派生索引。排序/筛选后的 ID 列表来自后端 `find_game_ids`，因此以下操作仍应 invalidate `gameKeys.idLists()`：

- 新增游戏。
- 删除游戏。
- 修改 `id_type`、外部 ID、日期、本地路径、游玩状态、元数据等影响列表归属或排序的字段。

### 源 ID 缓存需要单独 invalidate

修改 `bgm_id` 或 `vndb_id` 后，需要 invalidate：

```ts
gameKeys.bgmIds();
gameKeys.vndbIds();
```

它们用于新增和批量导入时的重复检测。

## 调试建议

如果怀疑单个更新触发了全量重建，可以临时在 `getDisplayGameData` 开头打日志。

预期：

- 单个普通更新：少量日志。
- 单个游玩状态更新：可能出现数次日志。
- 如果出现接近游戏库总数的日志，说明某处触发了全量 `GameIndex` 重建。

排查顺序：

1. 是否有代码直接写 `gameKeys.all`。
2. 是否 invalidate/refetch 了 `gameKeys.all`。
3. `gameKeys.index()` 的 `rawList` 是否与 `useAllGames().data` 对应。
4. 是否绕过 `gameCachePatch.ts` 修改了游戏缓存。
