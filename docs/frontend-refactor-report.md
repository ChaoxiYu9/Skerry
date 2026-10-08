# Skerry 前端重构前系统报告

日期：2026-08-12
项目：Skerry 0.27.1
位置：E:\\galgame\\Codex_xm\\Wangy\\WangyManager

## 1. 报告范围

本报告只记录当前系统的结构、调用、数据流、外部边界和重构风险，不包含本轮业务实现改动。后续重构应以此文件为基线，先保持现有功能契约，再逐步替换界面层。

当前工作区包含一个 Tauri 桌面应用和一个 Chrome 下载重定向扩展。游戏库、元数据、统计、存档、安装任务和下载任务由本地 Rust 后端提供能力，React 前端负责页面、交互、缓存和展示。

## 2. 技术栈

### 前端

- React 18、TypeScript 7、Vite 8
- React Router 7
- MUI 7、Emotion、MUI X Charts
- @toolpad/core DashboardLayout / AppProvider
- TanStack React Query 5
- Zustand 5 + persist
- i18next / react-i18next
- @dnd-kit：卡片拖拽排序
- Fuse.js：搜索辅助
- notistack：应用内 Snackbar
- UnoCSS 与 MUI sx 混用

### 桌面后端

- Tauri 2、Rust 2024 edition
- SeaORM + SQLite、Tokio
- Tauri Store：settings.json
- Tauri plugins：single-instance、deep-link、notification、shell、dialog、opener、http、autostart、window-state、log、store
- Windows 下包含 7-Zip 工具资源和 PowerShell 系统通知兜底

### 外部数据源

- Bangumi / BGM
- VNDB
- Ymgal
- Kungal
- Hikarinagi
- DLsite、Erogamescape
- Steam 本地扫描与快捷方式解析

## 3. 顶层运行结构

~~~text
main.tsx
  -> initializeStores()
  -> initTray()
  -> initPathCache()
  -> RouterProvider(routers)
      -> App
          -> SnackbarProvider
          -> ToolpadReactRouterAppProvider
          -> WindowsHandler
          -> InstallRequestHandler
          -> BrowserDownloadHandler
          -> Outlet
              -> Layout / DashboardLayout
                  -> Header / WindowControls / Toolbar / SearchBox
                  -> Page Outlet
~~~

Tauri 启动后会初始化数据库迁移、安装协议、下载桥接、任务恢复和窗口状态。单实例插件接收到第二次启动参数时，会把协议参数交给 dispatch_protocol_args。

## 4. 路由与页面清单

路由定义在 src/providers/router.tsx，页面使用 React.lazy 分包。

| 路径 | 页面 | 主要职责 |
|---|---|---|
| / | src/pages/Home/HomePage.tsx | 首页总览、继续游戏、心愿与计划、最近玩过、动态、随机游戏、统计 |
| /libraries | src/pages/LibrariesPage.tsx | 游戏库列表、搜索、筛选、排序、批量操作 |
| /libraries/:id | src/pages/Detail/DetailPage.tsx | 游戏详细页、启动、编辑、评价、存档、统计、数据源更新 |
| /next-up/:id | src/pages/NextUpDetail/NextUpDetailPage.tsx | 待玩/心愿与计划详细页、编辑、评价、路径 |
| /collection | src/pages/Collection/CollectionPage.tsx | 分组、分类、开发商分类、集合内游戏 |
| /report | src/pages/AnnualReport/AnnualReportPage.tsx | 年度报告、年份选择、游玩统计与图表 |
| /potato-import | src/pages/PotatoImport/PotatoImportPage.tsx | PotatoVN .pvnExport.zip 导入与预览 |
| /settings | src/pages/Settings/SettingsPage.tsx | 通用、数据源、账号、系统、维护、关于 |
| /downloads | src/pages/Downloads.tsx | 内嵌下载任务、线程数、文件名、目录、任务控制 |

隐藏详情路由通过 AppRoute.hideInMenu 排除在导航外。Layout 对 /libraries 单独使用 PageContainer，其他页面直接渲染 Outlet，造成不同的内容宽度和垂直间距基线。

## 5. 前端模块分层

### 页面层：src/pages

页面目前同时承担布局、状态组合、业务编排和部分后端调用。首页和详情页尤其复杂，存在大量 Stack、Box、内联 sx 与条件布局。

### 组件层：src/components

- Cards：卡片、虚拟列表、拖拽排序、右键菜单、批量栏
- AddModal：单条添加、批量导入、源匹配、游戏选择、混合源确认
- Toolbar：搜索、主题、工具栏操作
- Collection：集合选择与管理
- RightMenu：卡片右键菜单与状态子菜单
- Windows：自绘窗口关闭确认、最小化到托盘、退出流程
- BrowserDownloadHandler：浏览器下载事件接收、入队和 Windows 通知
- InstallRequestHandler：安装协议事件接收和安装任务创建

### Hooks 层：src/hooks

- queries：React Query 查询、mutation、缓存 patch/invalidate
- features/games：游戏列表、详情、状态动作、启动流程、元数据搜索
- features/collections：虚拟集合
- common：防抖、图片 URL、滚动恢复

### Service 层：src/services

常规 Tauri 调用走 BaseService，统一做 Tauri 环境检查和错误归一化。主要 service：

- gameService：游戏增删改查、批量操作、ID 列表、源绑定
- collectionService：集合和分类关系
- fileService：扫描目录、Steam、文件、备份、封面、目录打开
- installService：安装任务与任务控制
- savedataService：存档备份、恢复和记录
- settingsService：用户设置、代理、日志级别、BGM/Hikarinagi OAuth
- statsService：游玩记录、统计、最近游玩
- embeddedDownloads：内嵌下载器独立调用
- gameRuntime / gameStats：启动运行时和统计组合逻辑
- trayService / autoStartService：托盘与开机启动

### 数据源层：src/metadata

采用 adapter + registry：

~~~text
sourceAdapter.ts       接口
sourceRegistry.ts      注册表与派生常量
sourceCandidate.ts     搜索候选中间结构
sourceAutoResolve.ts   自动最佳匹配
adapters/*             BGM/VNDB/Ymgal/Kungal 适配器
api/*                  各数据源 HTTP 客户端
data/*                 展示转换、合并规则、批量更新
~~~

新增数据源的最小扩展点是类型、adapter、registry、API。混合搜索、单源搜索、自动匹配、详情补全、显示合并和数据源更新均依赖 registry。

## 6. 前端状态与缓存

### Zustand：src/store/appStore.ts

持久化了大量跨页面状态：

- 当前选中游戏、添加弹窗、任务管理弹窗
- 搜索词、游戏类型、游玩状态、标签筛选
- 排序、拖拽顺序、分组范围顺序
- 待玩/心愿计划游戏 ID 和虚拟游戏
- 数据源、混合数据源、更新模式
- NSFW、卡片点击模式、启动页、标签翻译
- 收藏同步开关、剧透等级、计时模式
- 集合导航、集合搜索、开发商搜索
- 代理、关闭行为、退出自动备份

src/store/gamePlayStore.ts 负责当前运行游戏和计时跟踪，appStoreMigrations.ts 负责持久化版本迁移。

### React Query

~~~text
gameKeys.all                         FullGameData[]
gameKeys.index()                     GameIndex 派生缓存
gameKeys.idLists(params)             排序/筛选后的 ID 列表
gameKeys.bgmIds() / vndbIds()        外部 ID 去重辅助缓存
settingsKeys.allSettings()           用户设置
statsKeys.*                          游戏统计、会话、总时长
~~~

游戏写入通常通过 src/hooks/queries/useGames.ts 的 mutation 完成，并调用 gameCachePatch.ts 对缓存做增量 patch；影响排序或源 ID 的字段还会 invalidate ID 列表或源 ID 缓存。

### 数据模型边界

- FullGameData：数据库完整 DTO，包含 sources、custom_data 等原始信息
- GameData：展示层扁平化数据
- GameIndex：前端派生索引，包含 raw/display list、Map、源可用性、开发商分类
- NextUpVirtualGame：待玩页可存在的虚拟游戏，不一定有数据库 ID
- Task：安装任务
- EmbeddedDownloadItem：内嵌下载任务

## 7. Tauri command 总表

所有 command 在 src-tauri/src/lib.rs 的 tauri::generate_handler! 中注册。

### 游戏与库

~~~text
insert_game
insert_games_batch
find_game_by_id
find_all_games
find_game_ids
update_game
delete_game
delete_games_batch
count_games
get_source_bindings
update_games_batch
~~~

### 文件、扫描、Steam、封面与备份

~~~text
launch_game / stop_game
open_directory
resolve_dropped_local_path
is_portable_mode
scan_directory_for_games
scan_steam_launch_targets
resolve_steam_shortcut_file
copy_file / write_file_bytes / delete_file
import_clipboard_image_to_temp
delete_game_covers / delete_cloud_cache
backup_database / backup_custom_covers / import_database
move_backup_folder
create_savedata_backup / delete_savedata_backup / restore_savedata_backup
~~~

### 安装任务

~~~text
take_pending_install_requests
take_pending_install_rejections
create_game_install_task
list_tasks
retry_task
pause_task
resume_task
cancel_task
delete_task
complete_game_install_task
fail_game_install_metadata
~~~

### 游玩统计

~~~text
create_manual_game_session
rebuild_game_statistics
get_game_sessions
get_recent_sessions_for_all
delete_game_session
get_game_statistics
get_all_game_statistics
get_all_game_last_played
~~~

### 设置、日志、窗口和协议

~~~text
get_all_settings / update_settings
update_proxy_config
set_reina_log_level / get_reina_log_level
restart_app
notify_browser_download_added
get_download_thread_count / set_download_thread_count
take_pending_browser_downloads
~~~

### 集合

~~~text
create_collection
find_root_collections
get_root_collections_with_count
update_collection
delete_collection
remove_games_from_collection
get_games_in_collection
get_game_collection_ids
add_games_to_collections
set_game_collections
update_category_games
count_games_in_group
get_categories_with_count
~~~

### OAuth

~~~text
bgm_oauth_start_login / bgm_oauth_cancel_login
bgm_oauth_exchange_code / bgm_oauth_refresh_token
hikarinagi_oauth_start_login / hikarinagi_oauth_cancel_login
hikarinagi_oauth_exchange_code / hikarinagi_oauth_refresh_token
~~~

## 8. 内嵌下载调用链

### 应用内手动添加

~~~text
Downloads.tsx
  -> embeddedDownloadsService.suggestName(link)
  -> embeddedDownloadsService.add(request)
  -> add_embedded_download
  -> src-tauri/src/embedded_downloads.rs
  -> downloader worker / task persistence
~~~

任务列表和控制使用 ensure_embedded_downloader、list_embedded_downloads、control_embedded_download(id, pause|resume|remove)。

线程数通过 settings.json 的 download_thread_count 保存，范围为 1-256，默认 8。浏览器扩展传入的线程数仍有独立设置链路，后续重构应统一成一个设置源。

### Chrome 扩展重定向

~~~text
Chrome background.js
  -> POST 127.0.0.1:17832/api/browser-download
     或 skerry://download?... 深链接
  -> DownloadProtocolState.push()
  -> URL + original URL 短时去重，约 8 秒
  -> emit(browser-download-requested)
  -> BrowserDownloadHandler
  -> take_pending_browser_downloads
  -> embeddedDownloadsService.add(start=true)
  -> 根据 Skerry 窗口焦点决定是否 notify_browser_download_added
~~~

Windows 通知当前由 Rust 启动隐藏 PowerShell NotifyIcon，尝试从当前 Skerry exe 提取图标，失败时使用系统信息图标。

## 9. 安装协议与浏览器桥接

- scheme：skerry
- 安装 host：skerry://install
- 下载 host：skerry://download
- HTTP bridge：127.0.0.1:17832
- bridge path：/api/browser-download
- 支持 OPTIONS，POST 返回 JSON
- 下载协议包含 URL、原始 URL、文件名、来源页、Cookie、UA、请求头、MIME、大小、线程数
- 下载请求按 URL + original URL 做短时去重，避免一个浏览器任务创建两个任务
- 安装协议和下载协议共用单实例/深链接入口，但状态队列不同

## 10. 主要前端数据流

### 游戏库

~~~text
useAllGames()
  -> gameService.find_all_games
  -> FullGameData[]
  -> useGameIndex()
  -> GameIndex / GameData
  -> useGameIdList()
  -> find_game_ids
  -> CardsGrid / VirtualCardsGrid
~~~

### 游戏编辑

~~~text
Detail/Edit 或 NextUpGameEdit
  -> GameInfoEdit / GameMetadataEditForm
  -> gameService.updateGame
  -> update_game
  -> patchGameCaches
  -> invalidate 必要的 idLists / source IDs / stats
~~~

### 元数据搜索与更新

~~~text
AddModal / DataSourceUpdate
  -> gameMetadataService
  -> sourceRegistry adapter
  -> API client
  -> SourceCandidate
  -> GameMetadataDraft
  -> 用户确认
  -> insert_game / update_game
~~~

### 首页

~~~text
HomePage
  -> game facade / stats hooks / appStore
  -> FocusGamePanel
  -> NextUpPanel
  -> RecentGamesPanel
  -> ActivityPanel
  -> HomeStats
  -> RandomGamePanel
~~~

首页同时混合游戏库数据、统计数据、待玩虚拟数据、运行时游戏状态和自定义布局，因此是重构时最需要先拆分 view model 的区域。

## 11. 当前发现的结构性问题

### 重构前必须锁定的契约

1. FullGameData、GameData、GameIndex、NextUpVirtualGame 的边界必须保持，不能让 UI 直接依赖数据库原始结构。
2. gameCachePatch.ts 的增量更新规则不能被页面层绕过，否则中文名、评分、源 ID、排序和首页卡片会出现保存后不刷新。
3. 待玩虚拟游戏 ID 使用负数和持久化 Zustand，详情页和真实游戏详情页不能共用未经区分的 ID 逻辑。
4. 安装协议、下载协议、Chrome 扩展和单实例回调是跨进程契约，不能仅按页面路由重写。
5. 下载线程数目前存在两个来源：Skerry settings.json 与 Chrome 扩展设置，必须明确优先级并最终统一。

### 前端架构问题

1. 页面层仍有直接 invoke：下载线程数、浏览器通知、取待处理下载请求。建议全部迁移到 service。
2. AppLayout、页面组件、MUI sx、UnoCSS 同时控制间距和高度，导致主页、下载页、库页的容器行为不一致。
3. Layout 对 /libraries 使用 PageContainer，其他页面不使用，形成不同的内容宽度和垂直间距基线。
4. 窗口控制、托盘退出、关闭确认、协议唤醒分散在 AppLayout、Windows、main.tsx 和 Rust single-instance 回调。
5. 页面中存在超长 JSX 行，下载页和部分设置页的 UI 状态与业务操作难以测试。
6. 文案仍有直接硬编码，路由标题“下载”等未完全使用 i18n。
7. 首页各面板之间没有统一布局契约，窗口尺寸变化时容易出现卡片压缩、空白和覆盖。

### 测试与稳定性风险

1. 当前主要验证是 pnpm typecheck、cargo check 和手工运行，缺少页面级、调用契约级和桥接端到端测试。
2. 年度报告曾出现 undefined.slice 崩溃，说明页面输入模型和空数据保护需要统一。
3. 下载通知依赖 PowerShell 异步进程，系统通知是否显示很难从前端确认。
4. 多处缓存 invalidate 是手工维护，新增字段时容易漏更新。
5. 构建产物、调试日志和源码目录目前混在项目树中，后续应明确边界。

## 12. 建议的前端重构目标架构

建议分四层，不改变 Rust command 名称作为第一阶段兼容层：

~~~text
app/
  router
  shell
  window
  notifications

domain/
  games
  collections
  metadata
  downloads
  installs
  stats
  settings

ui/
  primitives
  layout
  cards
  lists
  dialogs
  feedback

infra/
  tauri commands
  browser bridge
  query cache
  persistence
~~~

每个 domain 建议固定：api.ts、queries.ts、mutations.ts、model.ts、selectors.ts、components/。页面只负责组合 domain hooks 和 layout，不直接知道 Rust command 字符串。

## 13. 推荐重构顺序

1. 先建立 app 壳层：统一窗口、导航、页面容器、错误边界、加载态和通知。
2. 把所有直接 invoke 收口到 typed service，先不改 command 名称。
3. 把游戏库查询、缓存 patch、显示转换收口为 games domain。
4. 将详情页、编辑页、评价页和待玩页共用表单 schema 与字段组件。
5. 把首页改成固定 grid contract：每个 panel 声明 minWidth、minHeight、gridArea，禁止页面间互相覆盖。
6. 把下载页与浏览器桥接整合为 downloads domain，统一线程数、任务排序、通知和 badge。
7. 把集合、统计、安装任务、设置按 domain 迁移。
8. 最后移除旧的页面直调、重复样式和兼容层。

## 14. 推荐安装的 Skill / 工具

### 当前重构最需要

- 浏览器控制 skill：验证开发版窗口、下载桥接、通知和截图。
- 可视化 skill：对比首页、游戏库、详情页和下载页布局状态。
- OpenAI 文档 skill：只在查询 Codex/OpenAI 产品或 API 时需要，普通前端重构不是必需。

### 代码质量工具

- Biome 或 ESLint 规则收紧：禁止页面直接 invoke、统一 import、限制超长 JSX、检查 hooks 依赖。
- Vitest：测试 model、selector、缓存 patch、协议 payload 构造。
- React Testing Library：测试页面交互、空态、加载态、错误态和编辑保存。
- Playwright：测试桌面开发页面与浏览器扩展桥接。
- Storybook：为卡片、按钮、评分标签、表单、空态、下载任务行建立视觉基线。

### Rust/Tauri 侧

- cargo test：协议解析、下载去重、线程设置、任务状态转换。
- cargo clippy：Rust command 和异步任务质量。
- Tauri API 类型封装：将 command 名称和 payload 生成或集中管理。

## 15. 重构验收清单

### 功能

- 游戏库增删改、中文名保存后立即刷新
- 详情页和待玩页名称、封面、评分、评价统一
- 数据源搜索、混合搜索、数据源更新正常
- 首页在最小窗口和大窗口均无卡片覆盖或异常空白
- 年度报告空数据、缺失字段不会崩溃
- 下载手动添加、浏览器接管、去重、线程数持久化正常
- Skerry 在前台时不弹下载通知，其他程序在前台时弹 Windows 通知
- 安装任务、存档、统计、集合和 OAuth 不回归

### 视觉

- 统一页面内容宽度、边距、间距和响应式断点
- 统一卡片圆角、边框、玻璃底、按钮尺寸和评分标签
- 所有固定格式封面使用明确 aspect-ratio
- 下载任务行的文件名、进度条和操作区在不同窗口宽度下不跳动
- 主题切换、中文、英文、日文下文字不溢出

### 工程

- pnpm typecheck
- pnpm lint
- pnpm build
- cargo check --manifest-path src-tauri/Cargo.toml
- cargo clippy --manifest-path src-tauri/Cargo.toml
- Playwright 或手工回归关键流程
- debug build 和安装包各验证一次

## 16. 关键文件入口

- 应用入口：src/main.tsx
- 路由：src/providers/router.tsx
- 主布局：src/components/AppLayout.tsx
- 全局状态：src/store/appStore.ts
- 游戏查询：src/hooks/queries/useGames.ts
- 游戏 service：src/services/invoke/gameService.ts
- 元数据架构：src/metadata/sourceRegistry.ts
- 下载页：src/pages/Downloads.tsx
- 下载服务：src/services/embeddedDownloads.ts
- 浏览器接管：src/components/BrowserDownloadHandler.tsx
- Tauri command 注册：src-tauri/src/lib.rs
- 下载协议：src-tauri/src/install/protocol.rs
- 游戏库数据流：docs/game-library-data-flow.md
- 元数据适配器：docs/metadata-adapter-architecture.md

## 17. 结论

Skerry 的核心能力已经比较完整，当前最大的重构价值不在于更换 UI 库，而在于把页面布局、领域状态、Tauri 调用、缓存更新和协议事件重新分层。第一阶段应保持后端 command 和数据模型兼容，只收口调用和缓存；第二阶段再统一页面壳、表单、卡片和下载任务视觉；第三阶段才适合调整 Rust command 或数据库边界。

后续真正开始重构时，建议从 AppLayout、router、games domain 和 common UI primitives 开始，先建立稳定的页面骨架，再迁移首页、游戏库、详情页和下载页。

## 附录 A：当前前端直接调用入口

这些调用没有经过 src/services/invoke 的 BaseService，是第一批收口对象：

| 文件 | 调用 | 用途 |
|---|---|---|
| src/components/BrowserDownloadHandler.tsx | notify_browser_download_added | 浏览器下载加入后的 Windows 通知 |
| src/components/BrowserDownloadHandler.tsx | take_pending_browser_downloads | 读取浏览器桥接队列 |
| src/pages/Downloads.tsx | get_download_thread_count | 读取下载线程数 |
| src/pages/Downloads.tsx | set_download_thread_count | 保存下载线程数 |
| src/services/embeddedDownloads.ts | ensure_embedded_downloader | 初始化/确认内嵌下载核心 |
| src/services/embeddedDownloads.ts | add_embedded_download | 创建下载任务 |
| src/services/embeddedDownloads.ts | suggest_embedded_download_name | 根据响应头或 URL 推断文件名 |
| src/services/embeddedDownloads.ts | list_embedded_downloads | 读取下载任务 |
| src/services/embeddedDownloads.ts | control_embedded_download | 暂停、继续、删除任务 |

建议重构后由 downloadsApi.ts 统一封装以上调用，页面只使用 useDownloads、useDownloadSettings 和 downloadNotification 服务。

## 附录 B：前端事件入口

| 事件 | 生产者 | 消费者 | 语义 |
|---|---|---|---|
| browser-download-requested | Rust HTTP bridge / deep-link | BrowserDownloadHandler | 有新的浏览器下载请求 |
| game-install-requested | Rust install protocol | InstallRequestHandler | 有新的游戏安装协议请求 |
| game-install-request-rejected | Rust install protocol | InstallRequestHandler | 安装协议参数无效 |
| Tauri window focus events | Tauri window | BrowserDownloadHandler、窗口组件 | 判断 Skerry 是否在前台 |
| Tauri close-requested | Tauri window | Windows.tsx | 自绘关闭确认与托盘行为 |
| Tauri resize events | Tauri window | AppLayout | 更新最大化按钮状态 |

当前事件消费主要使用组件挂载时 listen，并在卸载时取消监听。重构时应建立 app/events 目录，集中定义事件名、payload 类型和订阅生命周期。

## 附录 C：持久化边界

### Zustand persist

浏览器端持久化 appStore，包括搜索、筛选、排序、待玩/心愿计划、启动页、窗口关闭偏好、自动备份偏好和数据源选择。

### Tauri Store

settings.json 由 Rust Tauri Store 管理，包含用户设置以及当前下载线程数 download_thread_count。它与 Zustand 是两套持久化系统，不能在重构时直接互换。

### SQLite / SeaORM

游戏、游戏源、集合、统计、游戏会话、存档记录、安装任务等核心业务数据进入 SQLite。数据库迁移位于 src-tauri/migration/src，实体位于 src-tauri/src/entity。

### 文件系统

封面、云缓存、存档备份、下载目录、安装临时文件和 7-Zip 工具资源位于应用数据目录或用户配置的目录。路径解析和安全校验集中在 src-tauri/src/utils/fs.rs。

## 附录 D：外部请求边界

| 边界 | 前端入口 | 后端/客户端 | 备注 |
|---|---|---|---|
| BGM/VNDB/Ymgal/Kungal | src/metadata | src/metadata/api + adapters | 有 token、代理、限流和混合搜索 |
| Hikarinagi | src/metadata/api/hikarinagi.ts、OAuth | Rust OAuth + 前端 API | 有独立登录会话 |
| DLsite/Erogamescape | src/metadata/api | HTTP 客户端 | 作为元数据来源或补充来源 |
| Steam | fileService | Rust scan/steam 模块 | 本地快捷方式和启动目标解析 |
| Chrome | chrome-extension/skerry-download-redirect | localhost HTTP / skerry scheme | 发送 URL、Cookie、UA、请求头和线程数 |
| Windows 通知 | BrowserDownloadHandler | Rust PowerShell NotifyIcon | 依赖前台窗口焦点判断 |

## 附录 E：重构时不应直接做的事情

- 不要先改 Tauri command 名称，再同时改页面和缓存；这会让问题无法定位。
- 不要让页面直接读写 FullGameData 的 sources 或 custom_data；应经过 domain selector。
- 不要把 NextUpVirtualGame 当作普通数据库游戏传给所有详情 mutation。
- 不要把浏览器扩展的 threadCount 和 Skerry settings.json 无条件互相覆盖。
- 不要仅用 CSS 缩放解决首页卡片压缩，应先定义 grid 的最小轨道和面板尺寸契约。
- 不要把通知、下载队列、任务 badge 分别实现三套状态；它们应共享 downloads domain 的任务快照。
