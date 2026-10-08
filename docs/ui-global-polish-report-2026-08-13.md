# Skerry 全局 UI 优化工作报告

日期：2026-08-13

## 本轮目标

- 不改 UI 排版、页面结构、信息架构和业务逻辑，只优化样式、材质、色彩与动效层。
- 放弃上个窗口“已完成”的主观判断，重新按当前代码状态审查和执行。
- 视觉方向改为：白色 / 蓝色 / 清爽玻璃感，加入少量玫粉、暖金、紫蓝点缀，避免绿色主视觉和单调蓝色堆叠。
- 重点增强：卡片质感、液态玻璃 / 毛玻璃、阴影、高亮、发光、二级菜单厚度、全局交互动效和返回动画。

## Skill 审查结论

- impeccable：本轮属于 scoped polish，不做布局重构；最后跑 detector，避免廉价渐变、性能差动画和无意义装饰。
- finesse-ui：Skerry 是 product/workbench UI，表达应服务管理和启动游戏，不走 landing page 英雄区语法；玻璃材质用于信息层和浮层厚度。
- interface-design：真实用户任务是浏览、筛选、启动、管理、查看统计；视觉应清爽、可扫读、可长期使用。
- ui-ux-pro-max：采用 Liquid Glass 方向，但保留对比度、reduced motion、稳定尺寸和 150-300ms 的短反馈。
- gsap：GSAP 用于页面进入/返回、浮层入场和全局交互反馈；小状态仍以 CSS transition 为主。

## 历史备份基线核对

- 本次核对的历史备份：`WangyManager-backup-ui-polish-202608121252`、`WangyManager-backup-before-takanawa-20260811-183313`、`WangyManager-backup-takanawa-ab-switch-20260811-193027`、`WangyManager-backup-refactor-baseline-20260812-022432`。
- `WangyManager-backup-ui-polish-202608121252` 已经包含 GSAP 全局页面切换的 `SkerryMotionOutlet`，但不包含 `src/components/motion/detailLaunch.ts`；备份中的 `DetailPage.tsx` 也没有详情卡片专用的 GSAP 打开/关闭链路。
- 更早的 `before-takanawa`、`takanawa-ab-switch` 和 `refactor-baseline` 同样没有 `detailLaunch.ts` 或 `animateDetailLaunch` / `animateDetailClose` 引用。
- 结论：这些备份可作为详情专用动画重建前的历史基线，不能直接作为当前详情退出动画的正确实现恢复源。当前详情卡片专用 GSAP 动画是在这些基线之后建立的。
- 之前报告只记录了“按当前代码重新审查”，没有记录上述备份与动画阶段的对应关系；本节补充这一事实，避免后续误把旧备份当成重建后的版本。

## 已完成

- 主页大卡片横幅优先：focusGame 主大图改为 banner-first，不再回退成 2:3 封面。
- 主页大卡片内嵌小卡片横幅优先：previousPlayedGame 同样改为 banner-first，小列表缩略图保持封面逻辑。
- 全局调色：MUI theme 和 CSS token 已切到蓝白清爽体系，主色为蓝，辅以紫蓝、玫粉、暖金点缀，背景为冰白 / 深夜蓝。
- 旧色清理：扫描并移除旧绿色、旧亮绿、旧紫主色硬编码残留；dock 激活/hover、仓库页主按钮 hover、右键菜单勾选图标绿色残留已修复。
- 按钮与进度条：主按钮、启动按钮、下载启动按钮、LinearProgress 改为蓝 -> 浅蓝 -> 紫蓝渐变，关键 hover 尾部加入玫粉点缀。
- 液态玻璃：全局 glass liquid、rim、soft glow、primary glow 改成蓝白玻璃体系，并加入更细的暖金/玫粉边缘光。
- 菜单 / 二级菜单：右键菜单与 submenu 去掉顶部粗彩条，改为 1px 内发光玻璃边、角落光斑和蓝白/玫粉毛玻璃阴影。
- 小卡片静止态噪点：用户确认更可能是图片本身问题，本轮任务已移除；不再继续修改卡片图片渲染。
- 路由动效：进入 / 返回增加方向感；返回、POP、层级回退使用反向横向位移和轻微模糊，首屏加载避免误判为返回。追加 GSAP 全局页面切换过场：同级页面按导航顺序判断方向，使用短暂玻璃光扫、页面根层位移/缩放/模糊，以及标题、工具条、首批卡片/任务行的柔和入场；详情页专属打开/关闭动画继续跳过路由级过场，避免双重动画。
- 全局交互：按钮 hover / press、浮层入场动画增强，检测并修掉 transition: width 性能警告。
- 页面内部状态动画：全局 MutationObserver 追加新增节点入场，覆盖收藏夹分组/分类/游戏切换、下载任务行/空状态、游戏卡片、加载状态，以及弹窗标题/内容/按钮的分段入场；路由切换后 480ms 内跳过内部节点动画，避免与跨页面过场叠加。
- 状态切换动效：设置页 Accordion 展开时增加轻微裁切展开、内容分段入场和自然收束；下载中心与添加游戏弹窗的 Tabs 切换增加选中反馈和任务/内容短入场，不改变 MUI 的布局测量和默认关闭行为。
- 全局控件命中修正：Switch、Checkbox、Radio、Slider、AccordionSummary 优先以外层视觉控件作为 GSAP 反馈目标，避免动画只打在内部 input 上导致感知偏弱。
- 动画性能清理：主题 IconButton 和 SearchBox 输入框移除 `transition: all`，改为明确的背景、边框、颜色、阴影和 transform 属性，减少无意触发的过渡。
- 动画增强记录：返回 / 进入动画位移从 14px 提升到 20px、时长从 0.28s 提升到 0.34s；全局按钮 hover / press 监听扩展到 document，使菜单、弹窗、选择器等 portal 浮层里的按钮也能获得一致反馈。
- 游戏详情横幅开场：将横幅和封面阴影拆到外层 shell，并在横幅裁切展开区域临时铺同源模糊背景图层；该兜底层只在展开前半段出现，随后由 GSAP 淡出到 0，避免透明图或特殊横幅长期吃到底层色调。内层横幅背景改为透明，主横幅图片使用 eager/high priority 加载，减少黑色占位和阴影后加载的突兀感。
- 游戏详情关闭动画：针对用户反馈的尾帧卡顿，将详情层收尾改为真正淡出后再导航，跳过下一次路由级动画，并用双 requestAnimationFrame 把导航提交推迟到关闭动画完成绘制后；同时在详情页卸载时跳过入场 GSAP context 的 revert，避免最后一帧被反向拉回。随后将最后的位移、缩放和淡出合并为 GSAP sine.inOut 收尾曲线，消除末尾加速造成的突兀感。
- 游戏详情关闭白屏修复：确认白屏来自关闭根层完全透明后、导航提交前的双帧空窗；将关闭末帧保留为极低透明度，并改为单 requestAnimationFrame 提交导航，保证详情层与下一页之间始终有背景衔接，同时保留已通过的收尾曲线。

## 修改范围

- src/components/motion/detailLaunch.ts
- src/providers/skerryTheme.ts
- src/App.css
- src/components/SkerryMotionOutlet.tsx
- src/components/SearchBox.tsx
- src/components/ui/GradientActionButton.tsx
- src/components/RightMenu/PlayStatusSubmenu.tsx
- src/pages/Home/HomePage.tsx
- src/pages/Home/HomeStats.tsx
- src/pages/Detail/DetailPage.tsx
- src/pages/Detail/stats/GameStatsOverview.tsx
- docs/ui-global-polish-report-2026-08-13.md

## 待视觉确认

- 主页主卡片和内嵌小卡片：确认 banner-first 的显示位置和裁切观感。
- 全局配色：当前蓝白清爽方向已冻结，不再主动二次调色；后续只修明确残留色或状态异常。
- 菜单 / 二级菜单：确认玻璃厚度、发光和入场动画是否有感知但不过火。
- 返回动画：确认返回方向感是否明显，是否需要再加大/减小位移。
- Accordion / Tabs：确认设置页折叠、下载中心筛选和添加游戏弹窗的状态切换是否自然；若视觉上已经足够，后续不再继续叠加动效。
- 游戏库卡片状态：继续审查筛选、排序和卡片视图切换时的连续性，优先处理内容瞬切或布局重排没有反馈的区域。

## 旧色残留扫描记录

- 扫描范围：src 与 docs 内的 css / ts / tsx 文件，排除 dist、node_modules、src-tauri/target 和本地化文本。
- 旧绿色扫描：text-green、bg-green、border-green、green-、emerald、teal、lime、#22c55e、#10b981、#34d399、#16a34a、#059669、#84cc16、#14b8a6、对应 rgba 绿色值均无命中。
- 旧紫色扫描：#7c3aed、#8b5cf6、#a855f7、#9333ea、#6d28d9、violet-500、purple-500、fuchsia-500、from/to purple/violet 均无命中。
- 当前命中的色值均属于已冻结的新色系：#2f7df6、#70c7ff、#7d74ff、#ff7aa8、#f4b96d、#185ec9。

## 验证结果

- pnpm run typecheck：通过。
- 关闭动画尾帧修复后 pnpm run typecheck：通过。
- pnpm run build：通过。
- impeccable detect --json：通过，返回 []。
- 本轮新增 Accordion / Tabs / 控件命中动画后 impeccable detect --json：通过，返回 []。
- `transition: all` 扫描：src 内无命中。
- 游戏详情关闭白屏修复后 pnpm run typecheck：通过。
- 游戏详情关闭白屏修复后 pnpm run build：通过；Vite 仍仅保留既有 chunk 体积提示。
- 旧绿色 / 旧紫色硬编码扫描：目标旧色无命中；额外确认 dock 激活态、仓库页主按钮 hover 和二级菜单勾选态无绿色残留。
- 构建提示：Vite 仍提示部分 chunk 大于 500 kB，这是既有打包体积提示，不是本轮 UI 改动导致的失败。

## 详情退出动画验收与冻结

- 用户已确认当前游戏详情页退出动画通过：横幅收缩、封面列和操作按钮收尾、背景衔接均按当前效果保留。
- 当前版本已建立精简源代码备份：E:/galgame/Codex_xm/Wangy/WangyManager-backup-ui-global-20260813-source-baseline。
- 备份统计：391 个文件，约 8 MB；已排除 node_modules、dist、.project-cache、.codex-tmp、src-tauri/target、日志和其他编译产物。
- 详情退出动画相关实现从现在起冻结：后续全局 UI 优化不修改 src/components/motion/detailLaunch.ts、详情路由交接逻辑和详情横幅收尾逻辑。
- 后续若全局样式检查触及详情层，只允许修复明确的构建、可访问性或颜色残留问题，不改变已验收的退出时间轴。

## 睡眠期间自动执行规则

- 不等待逐项视觉确认，按既定大纲继续推进全局 UI 优化。
- 保持现有页面排版、信息架构、banner-first 图片逻辑和业务逻辑不变。
- 优先处理全局材质层级、卡片状态、按钮和浮层反馈、颜色残留、动画性能与 reduced-motion。
- 全部修改完成后统一进行代码审查、旧色扫描、动画属性扫描、类型检查、构建检查和 detector 检查，并把遗漏项补入本报告。

## 睡眠期间自动执行补充审查

- 本轮没有重新调主题，也没有改变页面排版、路由结构、业务逻辑或图片选择逻辑；蓝白清爽配色继续冻结。
- 清理全局样式中残留的深绿感暗部：主页主舞台、Atlas 当前游戏层、Atlas 暗色遮罩、传输区阴影、dock 图标阴影和 tooltip / alert 阴影统一转为冷蓝中性色，避免蓝白体系在暗部泛绿。
- 主题中的唯一灰绿按钮 hover 背景改为主色 token 混合，保证 MUI outlined 主按钮和全局 CSS 的状态一致。
- 删除全屏背景饱和度滤镜、输入标签常驻 will-change 和游戏卡片图片常驻 will-change；这些属性只应在真实过渡期间存在，避免长期占用合成层或增加滤镜开销。详情路由光扫的过渡期 will-change 保留。
- 共享 MutationObserver 改为按 requestAnimationFrame 批量消费新增节点，限制单帧处理数量，并在处理前确认节点仍挂在文档中；连续列表提交、下载队列更新和浮层挂载不再为每条 mutation 各自触发布局读取和 GSAP 入场。
- 为链接、原生表单控件和自定义 [role="button"] 补充统一的 :focus-visible 焦点环；不改变鼠标操作外观，只补齐键盘可见状态。
- 小卡片静止态噪点任务仍保持移除；详情页横幅、封面列与退出时间轴仍保持冻结，没有被本轮改动。

## 最终核查

### 本轮后续补充

- 游戏库筛选、排序、删除和刷新后的连续落位：新增 `useFlipMotion`，只对带 `data-flip-key` 的内部内容层播放 GSAP FLIP 位移；拖拽外层和虚拟滚动测量没有被接管。
- 主页计划列表、活动轨迹、Next Up 横向列表、收藏夹分组/分类网格和下载任务队列都接入了 keyed FLIP，避免内容突然跳位。
- 卡片、主页焦点游戏、随机游戏、最近游玩、活动轨迹和 Next Up 图片统一使用 `RevealImage`，只做加载完成后的轻微 opacity 显影，不改变尺寸、裁剪、滤镜或阴影，避免首帧黑底和 POT 图片阴影再次被动画放大。
- 主页焦点游戏和随机游戏切换增加 `useContentSwapMotion`，用短时、低位移的 GSAP 内容交接保持当前内容区域连续。
- 全局动效审查覆盖路由切换、详情专用链路、菜单/弹窗、Accordion、Tabs、按钮 hover/press/focus、表单聚焦、下载行和列表状态更新；所有新增 motion helper 都含 `prefers-reduced-motion` 分支。
- 旧色复扫后清除了年度报告图表的明确绿色值，并把主页 Activity、Random Game、Next Up 的偏青暗底色收回到深蓝；蓝白主色与紫蓝、玫粉、暖金点缀保持冻结。
- 详情页冻结文件 `src/components/motion/detailLaunch.ts`、`src/providers/router.tsx`、`src/pages/Detail/DetailPage.tsx` 与源代码备份 SHA256 一致，本轮没有修改详情打开/退出时间轴。

## 本轮最终验证

- `pnpm run typecheck`：通过。
- `pnpm run build`：通过；Vite 仅保留已有的大 chunk 体积提示，没有构建失败。
- Impeccable detector（`App.css`、`SkerryMotionOutlet.tsx`、`skerryTheme.ts`）：返回 `[]`。
- 旧绿色目标值、`transition: all`：无命中。
- 常驻 `will-change`：仅保留路由 veil 的过渡属性；新增组件没有常驻合成层声明。
- 详情冻结文件 SHA256：全部匹配备份。
- 定向 Biome：未执行全仓格式化；剩余提示集中在既有压缩代码、导入顺序和格式规则，不影响类型检查或生产构建。
- 开发服务：`http://127.0.0.1:5173/` 返回 HTTP 200，当前监听进程保持运行，没有重复启动服务。
- 原生图片入口复查：剩余入口属于上传/预览、应用标识、工具栏图标或详情编辑场景；游戏卡片、主页内容、活动、最近游玩和 Next Up 已统一使用 `RevealImage`。
- 旧深绿 / 灰绿硬编码扫描：无目标命中；本地化标签词汇未作为视觉样式处理。
- `transition: all` 扫描：src 无命中。
- 常驻 `will-change` 扫描：仅保留 `.skerry-route-veil` 的路由过渡期属性；新增组件没有常驻合成层声明。
- 冻结详情文件：`src/components/motion/detailLaunch.ts`、`src/providers/router.tsx`、`src/pages/Detail/DetailPage.tsx` 与本轮源代码备份逐项核对，无差异。
- 精简源代码备份仍保留在 `E:/galgame/Codex_xm/Wangy/WangyManager-backup-ui-global-20260813-source-baseline`，不包含编译工具、依赖目录或构建产物。
