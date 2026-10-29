# 单一面板重构执行记录

日期：2026-10-29（Asia/Shanghai）。源码版本：2.3.0（未发版）。

## 目标与结果

把 4 个浮层、8 个视图收敛为「侧栏卡片 + 用量监控面板（概览 / 供应商）+ 供应商配置子页」：

- 删除 `UsagePopover`、`DetailModal`、`StatsModal` 及对应 CSS/词典键；
- 概览改为可展开的供应商行，一次只展开一行；明细、今日五分量、时段拆分、额度历史图与刷新历史都在概览内；
- 原「设置」页签并入供应商页底部的折叠「全局设置」；
- 卡片单击直接打开面板，移动端不再有独立分支；
- 侧栏卡片内容区 6px 横向、8px 顶部/底部内边距；标题行与进度条间距额外 +3px，进度条行间 6px；窗口标签 10px，长倒计时不再贴边被裁；
- 可见文案预算：默认视图 0 个 `.pnote`，说明移入收起的 `InfoHint`；关键告警保持可见。

设计与取舍见 [ADR-0002](adr/0002-single-monitor-surface.md)。

## 代码结构

- `createMonitorSurface`：`host`（dialog/page/null）+ `tab` + `editing` 的单一状态机，替代 `panelSnapshot` 的五个布尔值。
- `PanelHost`：dialog（遮罩 + 焦点陷阱）与 page（宿主设置内嵌）两个 adapter，共用面板内容。
- `usePanelController`：草稿、editorId/opSeq/revision、pendingSave、settingsWrites 与保存/测试/扫描动作；视图只消费其返回值。
- `metricRowsOf` + `MetricTable`：额度/余额/报告分组与表格列语义集中在一处，概览与编辑页预览复用。
- `UsageChart`、`WatchedLimits`、`TodayLine`、`SeasonBlock`、`HistoryTable` 保持行为不变，只换容器。
- 仍为手写无构建单文件 `lib/client.js`；未拆文件、未引入打包。

## 验证

| 检查 | 结果 |
| --- | --- |
| `node --check lib/client.js` | 通过 |
| `npm test` | 131 个测试全部通过 |
| `npm run test:browser` | 33 个 Chromium 测试全部通过 |
| `npm run test:pack` | 60 个文件，253,591 字节 |
| `git diff --check` | 通过 |
| 行尾 | 修改文件统一 LF（与原索引一致） |

浏览器测试覆盖：卡片入口、卡片留白（标题/倒计时与边缘的距离、长倒计时不被裁切）、单一面板不变量、浮层几何（遮罩铺满视口、960px 卡片居中、24px 内边距）、概览展开行、指标表格、图表与悬停读数、供应商页、全局设置折叠、草稿/保存身份、原生页接管、焦点返回、390px 窄屏、密度断言。

`test/css.mjs` 另守一条注入完整性：顶层不允许出现无选择器的声明。清理旧浮层时若只删选择器、留下换行后的声明，CSS 解析会把它们当作下一条规则的选择器，静默吞掉 `.qm-overlay`、`.qm-pill`、`.qm-watch`、`.qm-chart` 的基础规则——本轮就曾因此让面板退化成贴在文档流左侧、失去遮罩的卡片。

## 视觉证据

以下截图来自 Playwright 测试壳（`.scratch` 同源页面 + 固定夹具），不是真实 DSH 桌面截图，也不代表真实账户数据：

- [概览折叠](evidence/panel-refactor/overview-collapsed.png)
- [概览展开（图与表格）](evidence/panel-refactor/overview-expanded.png)
- [图表悬停读数](evidence/panel-refactor/chart-hover.png)
- [供应商页](evidence/panel-refactor/suppliers.png)
- [390px 窄屏](evidence/panel-refactor/narrow-dark.png)
- [侧栏卡片留白（6px 横向、8px 上下）](evidence/panel-refactor/sidebar-card.png)

## 边界

- 未在真实 DSH Desktop/Web 上重跑安装、扫描、真实供应商凭据；本轮验证为源码、真实 React 渲染器与 Chromium 测试壳。
- 未发版、未改版本号、未更新 CHANGELOG 的发布条目。
- 输入框内的秘密草稿仍只存在于面板会话；页面卸载时按现有边界清理。
