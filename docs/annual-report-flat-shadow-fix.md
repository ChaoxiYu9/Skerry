# 年度报告立体效果清除记录

## 背景

年度报告页重构后，部分卡片的视觉残留不是页面自身新增的样式，而是全局 MUI `Paper` 玻璃化规则继续作用在报告页卡片上。主要表现是外发光、玻璃模糊和投影叠加，看起来像一层立体阴影。

## 排查结论

- 年度报告 `Hero` 本体没有 `box-shadow`。
- 残留来源是 `MuiPaper-root` 的全局玻璃化样式，包括：
  - `box-shadow`
  - `filter`
  - `backdrop-filter`
  - `-webkit-backdrop-filter`
- 全局规则里包含多个 `:not(...)`，选择器优先级较高，普通 `!important` 覆盖不一定生效，所以必须用更高优先级的作用域选择器。

## 处理规则

年度报告页统一压平，禁止卡片和伪元素携带立体效果：

```css
html body .annual-report-stage .MuiPaper-root.MuiPaper-root.MuiPaper-root.MuiPaper-root.MuiPaper-root.MuiPaper-root.MuiPaper-root.MuiPaper-root,
html body .annual-report-stage .MuiPaper-root.MuiPaper-root.MuiPaper-root.MuiPaper-root.MuiPaper-root.MuiPaper-root.MuiPaper-root.MuiPaper-root *,
html body .annual-report-stage * {
	box-shadow: none !important;
	filter: none !important;
	backdrop-filter: none !important;
	-webkit-backdrop-filter: none !important;
}
```

位置：`src/App.css` 末尾。

## 验证方式

通过 Chromium DevTools Protocol 检查 `.annual-report-stage` 下所有元素的 computed style：

```js
for (const el of document.querySelectorAll('.annual-report-stage, .annual-report-stage *')) {
  const style = getComputedStyle(el);
  console.log(style.boxShadow, style.filter, style.backdropFilter);
}
```

本次处理后的结果：

```text
box-shadow: none
filter: none
backdrop-filter: none
残留数量: 0
```

## 当前补充

后续确认完全压平会显得过平，所以现在在压平规则之后针对报告页卡片重新加回了一层很轻的 `--annual-card-shadow`。该阴影只作用于 `Hero`、`Featured` 和报告页内的 MUI `Paper` 卡片，不会恢复全局玻璃模糊。

当前采用一套轻量双层数值，避免再出现旧版的大范围弥散：

```css
:root {
	--annual-card-shadow:
		0 1px 2px rgba(76, 64, 47, 0.07),
		0 6px 16px rgba(76, 64, 47, 0.07);
}

html[data-toolpad-color-scheme="dark"],
html[data-mui-color-scheme="dark"] {
	--annual-card-shadow:
		0 1px 2px rgba(0, 0, 0, 0.2),
		0 7px 18px rgba(0, 0, 0, 0.18);
}
```

应用范围是：

```css
html body .annual-report-stage .annual-report-hero,
html body .annual-report-stage .annual-report-featured,
html body .annual-report-stage
	.MuiPaper-root.MuiPaper-root.MuiPaper-root.MuiPaper-root.MuiPaper-root.MuiPaper-root.MuiPaper-root.MuiPaper-root.MuiPaper-root.MuiPaper-root.MuiPaper-root.MuiPaper-root {
	box-shadow: var(--annual-card-shadow) !important;
}
```

这套投影只做“轻微立体”，不启用 `backdrop-filter`，也不使用彩色发光。

## 后续使用

如果以后某个新页面也要完全压平 MUI 卡片，不要只写：

```css
.page-root .MuiPaper-root {
	box-shadow: none !important;
}
```

因为项目全局规则可能带有多个 `:not(...)`，优先级更高。应复制本报告里的高优先级作用域写法，把 `.annual-report-stage` 换成目标页面根 class，并同时清理四种立体效果。
