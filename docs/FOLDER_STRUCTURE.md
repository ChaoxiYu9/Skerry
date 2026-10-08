# Skerry 工作区与代码目录整理说明

> **最后整理日期**：2026-10-03  
> **整理目标**：剔除冗余临时脚本与过期历史碎片，确立清晰的代码开发、上游比对、归档备份与编译发布目录层级。

---

## 1. 根目录结构全景 (`E:\galgame\Codex_xm\Wangy`)

```text
E:\galgame\Codex_xm\Wangy\
├── Skerry\                           # 主工程入口
│   └── Skerry\                      # [核心开发工程] Skerry 桌面端完整源码 (Vite+React + Tauri v2+Rust)
│       ├── src\                     # 前端 React / TypeScript 核心源码
│       ├── src-tauri\               # 后端 Rust 原生系统与 Tauri 核心
│       ├── public\                  # 静态公共资源与源图标
│       ├── scripts\                 # 构建与维护辅助脚本
│       ├── docs\                    # 工程内嵌技术文档与功能清单
│       ├── package.json             # 前端依赖配置 (当前版本 v1.0.0-beta)
│       └── 直通安装包目录.lnk         # 桌面快捷方式，直达 release/bundle 安装包目录
│
├── backups\                          # [统一备份中心] 所有历史源码版本与里程碑备份归档
│   ├── Skerry_v1.0.0-beta_source_20261003.zip   # 【当前最新全量源码包】(约 8.1MB，不含几百兆编译缓存)
│   ├── Skerry-v1.0.0-beta-source-20261003\     # 【当前最新源码解压目录】(便于快速查验与 diff 比对)
│   └── Skerry-src-pre-kun-v1-20261003\     # Kun v1 接入前的关键节点备份
│
├── 0.31\                             # [上游基准参考]
│   └── ReinaManager-main\            # 原作者 0.31.0 最新架构（多选状态、LE/Magpie默认启用、UI缩放、云端收藏等实现参考）
│
├── ReinaManager-main0.29\            # [上游历史参考] 原作者 0.29 稳定版代码底座
├── WangyManager\                     # 早期历史参考工程
├── workspace-reports\                # 历史工作分析与测试汇总报告
├── FOLDER_STRUCTURE.md              # [本文档] 整理后的目录结构总览
├── FEATURES.md                      # [产品文档] Skerry 工具功能全景介绍
└── ROADMAP.md                       # [规划文档] 后续功能规划、维护与待办清单
```

---

## 2. 核心工程内部架构剖析 (`Skerry\Skerry`)

### 2.1 前端代码 (`src/`)
- `components/`：所有通用 UI 组件与二级弹窗
  - `AddModal/`：添加游戏模态框（单游戏添加、批量本地扫描导入、云端收藏导入）
  - `PathSettingsModal/`：全局路径设置弹窗（LE 转区路径、Magpie 路径、备份路径等）
  - `FilterSort/`：游戏仓库专属的排序筛选、多选批量操作组件
- `pages/`：一级主页面
  - `Home/`：Play Deck 主页，包含 16:9 响应式上次游玩主卡片、31天本月点亮热力图、统计指标小卡片、随机推荐卡片与最近轨迹
  - `Libraries/`：游戏仓库主页面（网格/列表流式展示、收藏夹管理、拖拽排序）
  - `Detail/`：游戏详情页（横幅底图、制作人员、多源评分胶囊徽标、截图画廊、分段统计）
  - `AnnualReport/`：游戏总结（原年度报告，涵盖全时间段与单年度游玩节奏分析）
  - `Downloads/`：多线程内置下载任务管理器
  - `Settings/`：全局外观、数据备份、刮削配置与行为设置
- `metadata/`：多源元数据聚合引擎
  - `api/`：各大源客户端封装（含最新的 `kun.ts` OpenAPI v1 客户端、`bgm.ts`、`vndb.ts` 等）
  - `adapters/`：标准化元数据适配器（各源数据到统一展示模型的转换器）
  - `constants.ts`：刮削源注册与可用性门控
- `hooks/` & `stores/`：React Query 缓存机制、游戏状态池与全局设置状态管理

### 2.2 后端原生与安装包输出 (`src-tauri/`)
- `src/`：Rust 模块（游戏运行监听器、本地文件读写、存档自动压缩备份、原生多线程下载器）
- `target/release/bundle/`：构建产物输出目录
  - `nsis/Skerry_1.0.0-beta_x64-setup.exe`：标准 Windows 安装向导可执行程序
  - `msi/Skerry_1.0.0-beta_x64.msi`：企业级 Windows Installer 安装包
  *(可通过工程根目录下的 `直通安装包目录.lnk` 快捷方式一键直达)*

---

## 3. 本次清理与优化总结

1. **清除临时测试脚本**：移除了开发迭代过程中留下的 106 个 `test*.py`、临时 dump 文件与临时日志，保持工程根目录清爽。
2. **清除过剩臃肿备份**：删除了根目录下早期带有编译冗余或体积高达数百兆的历史无用 zip 包，统一迁移并在 `backups/` 下建立规范的纯源码备份。
3. **备份轻量化**：当前全量代码备份压缩包仅 **8.10 MB**，绝不打包数十 GB 的 `node_modules`、Rust `target` 缓存或本地数据库文件，确保备份高效轻盈。
