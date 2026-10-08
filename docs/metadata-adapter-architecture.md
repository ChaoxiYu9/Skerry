# Metadata 适配器 + 注册表架构文档

> 基于 `f85bfe2 wip(metadata): replace remaining source constants` 整理。

## 1. 模块结构

```
src/metadata/
├── sourceAdapter.ts        # 接口定义
├── sourceCandidate.ts      # 中间表示 + merge helper
├── sourceRegistry.ts       # 注册表 + 派生常量/函数
├── sourceAutoResolve.ts    # 单源自动解析（search(1) + enrichOnSelect）
├── index.ts                # barrel export
├── adapters/
│   ├── bgmAdapter.ts
│   ├── vndbAdapter.ts
│   ├── ymgalAdapter.ts
│   └── kunAdapter.ts
├── api/                    # API 客户端
│   ├── bgm.ts
│   ├── http.ts
│   ├── kun.ts
│   ├── mixed.ts
│   ├── rateLimit.ts
│   ├── vndb.ts
│   └── ymgal.ts
└── data/                   # 数据处理
    ├── dataTransform.ts
    ├── displayMergeRules.ts
    ├── gameMetadataService.ts
    ├── metadata.ts
    ├── metadataBatchUpdate.ts
    └── sourceImage.ts
```

### 1.1 sourceAdapter.ts — 接口定义

```typescript
interface MetadataSourceContext {
  bgmToken?: string;
  enrichCrossSource?: boolean;  // kun 用于控制是否自动补 VNDB
  limit?: number;
  signal?: AbortSignal;
}

interface MetadataSourceAdapter<TData = unknown> {
  key: SourceType;              // "bgm" | "vndb" | "ymgal" | "kun"
  label: string;                // UI 显示名："Bangumi" / "VNDB" / "YMGal" / "Kungal"
  iconUrl: string;
  participatesInMixed: boolean; // 是否参与混合搜索
  defaultMixedEnabled: boolean; // 混合搜索默认启用
  mixedSearchLimit: number;     // 混合搜索结果数限制
  requiresBgmToken?: boolean;   // 是否需要 BGM token

  validateId(id: string): boolean;
  getExternalUrl(id: string): string;
  fetchById(id: string, ctx: MetadataSourceContext): Promise<GameMetadataDraft>;
  searchByName(name: string, ctx: MetadataSourceContext): Promise<SourceCandidate<TData>[]>;
  enrichOnSelect?(candidate: SourceCandidate<TData>, ctx: MetadataSourceContext): Promise<GameMetadataDraft>;
  toDisplayFields(data: TData): SourceDisplayFields;
}
```

### 1.2 sourceCandidate.ts — 中间表示

```typescript
interface SourceCandidate<TData = unknown> {
  source: SourceType;
  idKey: SourceIdType;
  dataKey: SourceDataKey;
  externalId?: string;
  data: TData;                  // 原始源数据（BgmData / VndbData / ...）
  display: SourceDisplayFields; // 标准化展示字段
  raw: GameCandidateData;       // 兼容旧系统的完整 payload
}
```

`SourceCandidate` 是 adapter 内部的中间表示。adapter 返回 `SourceCandidate`，service 层通过 `.raw` 取出 `GameCandidateData` 给下游消费。

关键 helper：
- `getSourceCandidateFromGame(game, adapter, display)` — 从 `GameCandidateData` 构造 `SourceCandidate`
- `sourceCandidateToGameCandidate(candidate)` — 反向转换
- `mergeCandidateWithDetails(candidate, details)` — `enrichOnSelect` 用，undefined-safe 合并

### 1.3 sourceRegistry.ts — 注册表

```typescript
// 类型安全的 adapter 映射
const SOURCE_ADAPTERS = { bgm, vndb, ymgal, kun } as const satisfies SourceAdapterMap;

// 派生常量
const REGISTERED_SOURCE_KEYS = Object.keys(SOURCE_ADAPTERS);  // ["bgm","vndb","ymgal","kun"]
const MIXED_SOURCE_KEYS = REGISTERED_SOURCE_KEYS.filter(a => a.participatesInMixed);  // ["bgm","vndb","ymgal","kun"]
const DEFAULT_MIXED_SOURCE_KEYS = MIXED_SOURCE_KEYS.filter(a => a.defaultMixedEnabled);  // ["bgm","vndb"]

// 查询函数
getSourceAdapter(source)           // 返回强类型 adapter（泛型保留）
getRuntimeSourceAdapter(source)    // 返回 MetadataSourceAdapter<unknown>（类型擦除，用于通用场景）
getEnabledMixedAdapters(enabled?)  // 返回启用的混合 adapter 列表
```

### 1.4 sourceAutoResolve.ts — 单源自动解析

用于批量导入和混合单 ID 查找中的"用名称搜索最佳匹配"：

```
resolveAutoSelectedSourceCandidate({ query, source, bgmToken })
  → adapter.searchByName(query, { limit: 1 })
  → adapter.enrichOnSelect?(candidate)  // 仅 kun/ymgal 有
  → SourceCandidate | null
```

### 1.5 各 Adapter 特性

| Adapter | requiresBgmToken | enrichOnSelect | enrichCrossSource 控制 | defaultMixedEnabled |
|---------|-----------------|----------------|----------------------|-------------------|
| bgm     | ✅               | ❌              | N/A                  | ✅                 |
| vndb    | ❌               | ❌              | N/A                  | ✅                 |
| ymgal   | ❌               | ✅ (fetchYmById) | 来自 ctx            | ❌                 |
| kun     | ❌               | ✅ (fetchGalgameById) | 来自 ctx → enrichVndb | ❌          |

`enrichCrossSource` 语义：目前只有 kun 使用，映射为 `enrichVndb`。mixed 场景传 `false`（各源并行拉，不需要 kun 顺带拉 VNDB）；单源 auto-resolve 默认 `true`。

---

## 2. 数据流链路

### 2.1 混合名称搜索

```
BulkImportTab / AddModal
  → gameMetadataService.searchGames({ source: "mixed", query })
    → searchMixed() → getMixedGameByName()
      → fetchMixedData({ name, bgmToken, enabledSources })        [api/mixed.ts:160]
        → getEnabledMixedAdapters(enabledSources)                  [sourceRegistry.ts:49]
        → Promise.all(adapters.map(a =>
            canUseAdapter(a, { bgmToken })
              ? fetchAdapterSafely(a, () => a.searchByName(name, { bgmToken, signal }))
              : createEmptyResult(a)
          ))                                                        [api/mixed.ts:222]
        → assertNotAllAttemptedSourcesFailed(results)
        → toSourceResult(results)                                   [api/mixed.ts:110]
          → { bgm: [SourceCandidate...], vndb: [SourceCandidate...], ... }
      → pickFirstMixedResult(result)                                [data/metadata.ts:140]
      → buildGameCandidateFromSourceSelection()                     [sourceCandidate.ts:240]
      → GameMetadataDraft[]
```

### 2.2 单源搜索

```
AddModal → gameMetadataService.searchGames({ source: "bgm", query })
  → searchSingleSource()
    → shouldUseIdSearch(query, source)
      → getSourceAdapter(source).validateId(query)                 [data/gameMetadataService.ts:142]
    → searchByName() → getSourceAdapter(source).searchByName()    [data/gameMetadataService.ts:414]
      → bgmAdapter.searchByName() → fetchBgmByName()
    → candidates.map(c => sourceCandidateToDraft(c))               [data/gameMetadataService.ts:419]
    → GameMetadataDraft[]
```

### 2.3 搜索结果选择后补全

```
用户选择一项 → useMetadataSearchFlow.selectGame()
  → gameMetadataService.enrichSelectedGameDetails({ selectedGame, source })  [data/gameMetadataService.ts:294]
    → getSourceAdapter(source)
    → adapter.enrichOnSelect?
      ├─ ymgal: fetchYmById(id) → mergeCandidateDetailData()
      └─ kun: fetchGalgameById(id, { enrichVndb: ctx.enrichCrossSource })
           → mergeCandidateDetailData()
    → GameMetadataDraft
```

### 2.4 混合单 ID 查找

```
fetchMixedData({ bgm_id: "12345", bgmToken })                   [api/mixed.ts:160]
  → getProvidedSourceIds() → [{ adapter: bgmAdapter, id }]      [api/mixed.ts:131]
  → providedIds === 1
  → bgmAdapter.fetchById("12345", { bgmToken, enrichCrossSource: false })
    → fetchBgmById()
  → extractNameFromApi(candidate) → searchName
  → Promise.all(其他 adapters 用名称做 resolveAutoSelectedSourceCandidate())
    → adapter.searchByName(searchName, { limit: 1 })
    → adapter.enrichOnSelect?(candidate, { enrichCrossSource: false })
  → toSourceResult(results)
```

### 2.5 混合多 ID 查找（数据更新场景）

```
fetchMetadataForUpdate({ idType: "mixed", bgmId, vndbId, ... }) [data/metadata.ts:216]
  → gameMetadataService.getGameByIds()
    → 并行 getSourceAdapter(source).fetchById(id, { bgmToken })  [data/gameMetadataService.ts:274]
    → mergeCandidateSources(combinedResults) 等组合操作
```

### 2.6 展示数据合并

```
FullGameData (数据库)
  → getDisplayGameData(fullData)                                  [data/dataTransform.ts:35]
    → getSourceDataMap(fullData)                                   [data/displayMergeRules.ts:65]
      → REGISTERED_SOURCE_KEYS.map(source => {
          adapter = getRuntimeSourceAdapter(source)
          getCandidateSourceData(fullData, source)
        })
      → { bgm: BgmData, vndb: VndbData, ... }

    → 根据 id_type 分支：
      ├─ 单源 (isSourceType):
      │   → applySingleSourceDisplay(baseData, source, sourceData)
      │     → getRuntimeSourceAdapter(source).toDisplayFields(data)
      │     → assignBasicFields() + image/tags/rank/score/...
      │
      ├─ "mixed":
      │   → applyMixedSourceDisplay(baseData, sourceDataMap, coverSource)
      │     → buildDisplayMap() → 每个源调 toDisplayFields()
      │     → 按优先级合并：
      │       - name/name_cn: BASIC_FIELD_PRIORITY [bgm, vndb, ymgal, kun]
      │       - image: coverSource || SOURCE_COVER_PRIORITY [bgm, vndb, kun, ymgal]
      │       - summary: SUMMARY_PRIORITY [ymgal, bgm, kun, vndb]
      │       - developer: DEVELOPER_PRIORITY [vndb, kun, ymgal, bgm]
      │       - tags: MIXED_TAG_SOURCES [bgm, vndb, kun] (merge + dedupe)
      │       - aliases: MIXED_ALIAS_SOURCES [bgm, vndb, kun, ymgal]
      │       - score: bgm || vndb; rank: bgm only
      │       - all_titles: MIXED_TITLE_SOURCES [vndb, kun]
      │       - average_hours: vndb only
      │
      ├─ "custom" / "Whitecloud":
      │   → applyCustomSourceDisplay(baseData, custom_data)
      │
      └─ default: fallback to first available source

    → applyCustomDataOverride(baseData, custom_data)
      → summary/developer/nsfw 覆盖
      → aliases/tags 增量合并（union）
    → GameData (扁平)
```

### 2.7 批量导入

```
BulkImportTab.handleMatchMetadata()                               [BulkImportTab.tsx:204]
  → 逐项: gameMetadataService.searchBestMatch({ query, source })
    → resolveAutoSelectedSourceCandidate({ query, source, bgmToken })
      → adapter.searchByName(query, { limit: 1 })
      → adapter.enrichOnSelect?(candidate)
    → candidate ? sourceCandidateToDraft(candidate) : undefined
  → items[].matchedData = GameMetadataDraft

BulkImportTab.handleEditRowSearch()
  → metadataSearchFlow.searchMetadata({ query, source })
    ├─ mixed: gameMetadataService.searchMixedSourceCandidates() → MixedSourceConfirmDialog
    └─ 单源: gameMetadataService.searchGames() → GameSelectDialog
```

### 2.8 数据更新

```
DataSourceUpdate.handleFetchAndPreview()                          [DataSourceUpdate.tsx:128]
  → fetchMetadataForUpdate({ selectedGame, idType, ... })         [data/metadata.ts:216]
    ├─ mixed: gameMetadataService.getGameByIds() → fetchMixedData 或逐源 fetchById
    └─ 单源: gameMetadataService.getGameById()
        → getSourceAdapter(source).fetchById(id, { bgmToken })
```

### 2.9 混合搜索结果确认后补全

```
MixedSourceConfirmDialog → 用户确认选择
  → gameMetadataService.enrichMixedSourceSelection({ selection, enabled })  [data/gameMetadataService.ts:337]
    → Promise.all(MIXED_SOURCE_KEYS.map(source => {
        adapter = getRuntimeSourceAdapter(source)
        if (!adapter.enrichOnSelect) return
        sourceCandidate = getSourceCandidateFromGame(selectedGame, adapter, display)
        enrichedDraft = await adapter.enrichOnSelect(sourceCandidate, { enrichCrossSource: false })
        nextSelection[source] = getSourceCandidateFromGame(enrichedDraft, adapter, ...)
      }))
```

---

## 3. 消费方清单

| 文件 | 导入内容 | 用途 |
|------|---------|------|
| `src/metadata/data/gameMetadataService.ts` | `getSourceAdapter`, `getRuntimeSourceAdapter`, `getSourceCandidateFromGame`, `resolveAutoSelectedSourceCandidate` | 核心搜索/补全逻辑 |
| `src/metadata/api/mixed.ts` | `getEnabledMixedAdapters`, `getRuntimeSourceAdapter`, `resolveAutoSelectedSourceCandidate`, `SourceCandidate` | 混合并行搜索 |
| `src/metadata/data/metadata.ts` | `getRuntimeSourceAdapter`, `MIXED_SOURCE_KEYS`, `REGISTERED_SOURCE_KEYS` | 合并/更新/build helpers |
| `src/metadata/data/dataTransform.ts` | `getRuntimeSourceAdapter` | `getDisplayGameData` 中取 dataKey |
| `src/metadata/data/displayMergeRules.ts` | `getRuntimeSourceAdapter`, `REGISTERED_SOURCE_KEYS` | 展示合并规则 |
| `src/metadata/data/sourceImage.ts` | `getRuntimeSourceAdapter`, `REGISTERED_SOURCE_KEYS` | 封面图解析 |
| `src/utils/game/gameIndex.ts` | `getRuntimeSourceAdapter`, `REGISTERED_SOURCE_KEYS` | 数据源可用性检查 |
| `src/store/appStore.ts` | `MIXED_SOURCE_KEYS` | toggleMixedSource |
| `src/store/appStoreMigrations.ts` | `DEFAULT_MIXED_SOURCE_KEYS`, `MIXED_SOURCE_KEYS` | 迁移：默认启用源 |
| `src/pages/Settings/DataSourceSettings.tsx` | `DEFAULT_MIXED_SOURCE_KEYS`, `getRuntimeSourceAdapter`, `MIXED_SOURCE_KEYS` | 混合源设置 UI |
| `src/pages/Detail/DataSourceUpdate.tsx` | `getRuntimeSourceAdapter` | hasSelectedSourceData |
| `src/components/AddModal/BulkImportTab.tsx` | `getRuntimeSourceAdapter`, `REGISTERED_SOURCE_KEYS` | 源选项列表 |
| `src/components/AddModal/GameSelectDialog.tsx` | `getRuntimeSourceAdapter` | extractDisplayInfo |
| `src/components/AddModal/MixedSourceConfirmDialog.tsx` | `getRuntimeSourceAdapter`, `MIXED_SOURCE_KEYS` | 混合确认弹窗 |

---

## 4. 旧类型 ↔ 新 Adapter 映射

| 旧常量/类型 (types.ts) | 新对应 (metadata/) | 关系 |
|---|---|---|
| `SourceType` | `MetadataSourceAdapter.key` | 1:1，继续使用 |
| `SourceIdType` / `SourceDataKey` | (已废弃) | 被 `game_sources` 聚合表结构取代 |
| `SOURCE_KEYS` | `REGISTERED_SOURCE_KEYS` | 后者从 `Object.keys(SOURCE_ADAPTERS)` 派生 |
| `SOURCE_FIELD_KEYS` | (已废弃) | 不再依赖特定数据列后缀 |
| `SOURCE_LABELS[source]` | `getRuntimeSourceAdapter(source).label` | 后者是超集 |
| `GameCandidateData` | `GameMetadataDraft` | 全新数据草稿格式，支持 sources 数组 |

旧常量 `SOURCE_FIELD_KEYS` 和 `SOURCE_KEYS` 仅在 `types/types.ts` 定义处保留（`isSourceType()` 依赖），所有消费方已迁移到 registry 体系。

---

## 5. 新增数据源 Checklist

添加新数据源（如 `example`）需要：

1. **定义类型**：`src/types/types.ts` 中添加 `ExampleData`、扩展 `SourceType` / `SourceIdType` / `SourceDataKey` / `SOURCE_FIELD_KEYS`
2. **创建 adapter**：`src/metadata/adapters/exampleAdapter.ts`，实现 `MetadataSourceAdapter<ExampleData>`
3. **注册**：`src/metadata/sourceRegistry.ts` 的 `SOURCE_ADAPTERS` 中添加 `example: exampleAdapter`
4. **API 层**：`src/metadata/api/example.ts` 实现 `fetchExampleById` / `fetchExampleByName`

以上 4 步完成后，以下场景自动支持（无需额外修改）：
- 混合搜索 / 单源搜索 / 批量导入
- 展示数据合并（displayMergeRules 自动遍历 REGISTERED_SOURCE_KEYS）
- 数据更新 / 数据源可用性检查
- 设置页 UI / 混合确认弹窗
