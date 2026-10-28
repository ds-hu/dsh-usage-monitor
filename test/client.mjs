import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import React from "react";
import { create, act } from "react-test-renderer";

const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
/** 使用实际无构建客户端与真实 React，仅替换宿主槽位、网络、时钟和本地存储。 */
function client(fetch, { storage = new Map(), search = "", clock = null, mobile = false } = {}) {
  let plugin, dictionary;
  const locales = {};
  const slots = {}, timers = [], listeners = {}, cleanups = [];
  const subscribe = (type, fn) => (listeners[type] ||= new Set()).add(fn);
  const unsubscribe = (type, fn) => listeners[type]?.delete(fn);
  const document = { querySelector: () => true, body: {}, visibilityState: "visible", addEventListener: subscribe, removeEventListener: unsubscribe };
  const window = {
    __ModuleLoader__: { load({ factory }) { plugin = factory((id) => id === "react" ? React : { createPortal: (child) => child }); } },
    location: { search }, addEventListener: subscribe, removeEventListener: unsubscribe,
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    // 视口断点替身：mobile 决定 matchMedia 的结果，宿主浏览器才有真实实现。
    matchMedia: (query) => ({ matches: mobile, media: query,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  };
  const context = {
    window, document, fetch, console, location: window.location, AbortController, AbortSignal,
    requestAnimationFrame(fn) { fn(); return 0; },
    setTimeout(fn, ms) { const handle = { fn, ms }; timers.push(handle); return handle; },
    clearTimeout(handle) { const index = timers.indexOf(handle); if (index >= 0) timers.splice(index, 1); },
  };
  context.globalThis = context;
  // 只在测试进程内替换这个 context 的时钟：倒计时文案依赖「现在」，用真实时钟会让断言随运行时刻抖动。
  if (clock !== null) {
    const fixed = { Now: clock };
    context.Date = Object.assign(class extends Date {
      constructor(...args) { if (args.length === 0) super(fixed.Now); else super(...args); }
      static now() { return fixed.Now; }
    }, { parse: Date.parse, UTC: Date.UTC });
    context.__setNow = (value) => { fixed.Now = value; };
  }
  // 只为纯展示函数提供测试访问点，不修改生产导出或加载方式。
  vm.runInNewContext(source.replace("exports.apply = apply;", "exports.__test = { buildEntryView, selectPrimaryMetric, supplierStatus, connStateOf, seasonCountdown, seasonSplitText, fmtBig, weeklyEntryOf, selectBarMetrics, usageRatioOf, ratioPartsOf, splitPartsOf, chartDomainOf, quotaSegmentsOf, quotaLegendOf, quotaUsedAt, clockOf, dayStartOf }; exports.apply = apply;"), context);
  plugin.apply({ locale: { register(ns, locales_) { Object.assign(locales, locales_); dictionary = locales_.zh; } }, effect(fn) { cleanups.push(fn()); }, slots: {
    inject(name, fn) { return fn(); }, register(descriptor, component) { slots[descriptor.name ?? descriptor.key] = component; },
  } });
  const t = (key, params = {}) => String(dictionary[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => params[k] ?? `{${k}}`);
  return { Footer: slots["sidebar.footer.action"], Page: slots["settings.section"], t, locales, timers, storage, helpers: plugin.__test, setNow: context.__setNow };
}
const textOf = (node) => {
  const walk = (child) => Array.isArray(child) ? child.map(walk).join("") : typeof child === "string" || typeof child === "number" ? String(child) : child?.children ? walk(child.children) : "";
  return walk(node.children ?? node);
};
const line = (tree, name) => textOf(tree.root.findByProps({ className: name }));
/** 进度条节点（唯一）：不存在表示这一行回落成了主指标文字。 */
const barNode = (tree) => tree.root.findAllByProps({ "data-qm-bar": "" })[0] ?? null;
const button = (tree, name) => tree.root.findAllByType("button").find((node) => textOf(node) === name || node.props["aria-label"] === name);
const tab = (tree, name) => tree.root.findAllByProps({ role: "tab" }).find((node) => textOf(node) === name);
const mount = async (host, props = {}, Component = host.Footer) => {
  let tree;
  await act(async () => { tree = create(React.createElement(Component, { wide: true, t: host.t, ...props })); });
  return tree;
};
const open = async (tree) => act(async () => { tree.root.findByProps({ "data-qm-entry": "" }).props.onClick(); });
/** 等首帧 /state 落地并触发依赖它的 effect（globalForm 就在 effect 里初始化）。 */
const flush = async () => { await act(async () => { await Promise.resolve(); }); };
const response = (data) => ({ ok: true, status: 200, json: async () => data });
const payload = (name, suppliers = []) => ({ ok: true, traffic: { channelAlive: true }, suppliers, active: { supplierId: suppliers[0]?.id, name, model: "model", at: Date.now() } });
const supplier = (entries, extra = {}) => ({ id: "opencode", name: "OpenCode", current: true, added: true, enabled: true, state: "ok", todayTokens: 0, entries, ...extra });

for (const wide of [true, false]) test(`${wide ? "expanded" : "rail"} sidebar opens a usage popover before independent details`, async () => {
  const host = client(async () => response(payload("A")));
  let tree;
  try {
    tree = await mount(host, { wide });
    await open(tree);
    assert.equal(tree.root.findAllByProps({ role: "dialog" }).length, 1);
    assert.equal(tree.root.findByProps({ role: "dialog" }).props["aria-label"], "用量");
    assert.equal(tree.root.findAllByProps({ role: "tab" }).length, 0);
    assert.equal(tree.root.findAllByProps({ className: "qm-pop" }).length, 1);
    await act(async () => button(tree, "详情").props.onClick());
    assert.equal(tree.root.findAllByProps({ className: "qm-pop" }).length, 0);
    assert.equal(tree.root.findByProps({ role: "dialog" }).props["aria-label"], "供应商限额明细");
    await act(async () => button(tree, "关闭").props.onClick());
    assert.equal(tree.root.findAllByProps({ role: "dialog" }).length, 0);
  } finally { await act(async () => tree?.unmount()); }
});

for (const wide of [true, false]) test(`mobile layout (${wide ? "expanded" : "rail"}) opens the details dialog on the first tap`, async () => {
  const host = client(async () => response(payload("A")), { mobile: true });
  let tree;
  try {
    tree = await mount(host, { wide });
    await open(tree);
    assert.equal(tree.root.findAllByProps({ className: "qm-pop" }).length, 0, "手机端不再先弹浮卡");
    assert.equal(tree.root.findByProps({ role: "dialog" }).props["aria-label"], "供应商限额明细");
    assert.equal(tree.root.findByProps({ "data-qm-entry": "" }).props["aria-expanded"], true);
    // 详情头部保留「设置」：直达详情不是死路，配置面板仍能打开。
    await act(async () => button(tree, "设置").props.onClick());
    assert.equal(tree.root.findByProps({ role: "dialog" }).props["aria-label"], "用量监控");
  } finally { await act(async () => tree?.unmount()); }
});

test("late state responses cannot overwrite a newer poll", async () => {
  const calls = [];
  const host = client((url) => new Promise((resolve) => calls.push({ url: String(url), resolve })));
  let tree;
  try {
    tree = await mount(host);
    assert.equal(calls.length, 1);
    assert.ok(host.timers.some((timer) => timer.ms === 30_000), "在途 GET 有 30s 上限");
    await act(async () => calls[0].resolve(response(payload("first"))));
    const poll = host.timers.find((timer) => timer.ms === 10_000);
    assert.ok(poll);
    await act(async () => poll.fn());
    assert.equal(calls.length, 2);
    await act(async () => calls[1].resolve(response(payload("new"))));
    await act(async () => calls[0].resolve(response(payload("old"))));
    assert.ok(line(tree, "qm-l1").includes("new"));
    assert.ok(!line(tree, "qm-l1").includes("old"));
  } finally { await act(async () => tree?.unmount()); }
});

test("expanded sidebar shows the plan name and the weekly bar, and scopes today's total to current suppliers", async () => {
  const state = payload("OpenCode", [
    supplier([{ name: "5 小时", kind: "win", pct: 5, reset: "约 2 小时后重置" }, { name: "周用量", kind: "win", pct: 2, reset: "下周重置" }], { todayTokens: 64_429_367 }),
    supplier([{ name: "CNY", kind: "bal", remain: "¥41.99" }], { id: "deepseek", name: "DeepSeek", todayTokens: 1_318_275 }),
    supplier([], { id: "historic", name: "Historical", current: false, todayTokens: 100_000_000 }),
  ]);
  state.active.model = "deepseek-v4.1-flash-with-a-long-model-name";
  const host = client(async () => response(state));
  let tree;
  try {
    tree = await mount(host);
    // 标题行（进统计的入口）左侧是 plan 名：插件标题、连接圆点与模型名都不进卡片
    assert.equal(textOf(tree.root.findByProps({ className: "qm-plan" })), "OpenCode");
    // 右侧是同一名供应商的今日数；今日数挂在标题行，不再与监控条挤一行
    assert.equal(textOf(tree.root.findByProps({ className: "qm-today-chip" })), "今日 64.4M");
    // 第 2 行是周窗口（2%），而不是更紧的 5 小时窗口（5%）
    const row = barNode(tree);
    assert.equal(row.props["data-qm-window"], "week");
    assert.equal(row.props["data-qm-tone"], "ok");
    assert.equal(row.props.role, "progressbar");
    assert.equal(row.props["aria-valuenow"], 2);
    assert.match(textOf(tree.root.findByProps({ className: "qm-bars" })), /^周2%下周重置$/, "标签是「周」，数字是 2%，倒计时跟着同一条");
    assert.equal(row.find((n) => /qm-bar-fill/.test(n.props.className || "")).props.style.width, "2%");
    // 第 3 行（今日用量）已取消：卡片只留监控项，今日移到详情弹窗按供应商展示
    assert.equal(tree.root.findAllByProps({ className: "qm-l3" }).length, 0);
    const entry = tree.root.findByProps({ "data-qm-entry": "" });
    assert.ok(!textOf(entry).includes("tokens"), "卡片正文不再出现今日用量：" + textOf(entry));
    assert.match(entry.props.title, /65\.7M tokens/, "今日用量仍进无障碍标签/悬停");
    assert.match(entry.props["aria-label"], /当前供应商.*今日.*Token.*本地日/);
    assert.ok(entry.props.title.includes("OpenCode"));
    assert.ok(!entry.props.title.includes(state.active.model), "模型名不再进卡片：" + entry.props.title);
    assert.equal(tree.root.findAll((n) => /(^|\s)qm-dot(\s|$)/.test(n.props.className || "")).length, 0, "卡片不再有阈值圆点");
  } finally { await act(async () => tree?.unmount()); }
});

test("a page with no calls never borrows another page's supplier but retains scoped daily tokens", async () => {
  const state = { ...payload("", [supplier([{ kind: "win", name: "周期", pct: 3 }], { name: "DeepSeek", todayTokens: 1200 })]), active: null };
  const host = client(async () => response(state));
  let tree;
  try {
    tree = await mount(host);
    assert.equal(line(tree, "qm-l1"), "暂无调用");
    assert.equal(barNode(tree), null, "没有在用供应商就不画条");
    assert.ok(!line(tree, "qm-l2").includes("3%"), "不得借用他页供应商的百分比");
    assert.ok(!line(tree, "qm-l1").includes("DeepSeek"));
    // 今日用量不再常显在卡片上，但无障碍标签仍要读得到（1.20K，3 位有效数字）
    assert.match(tree.root.findByProps({ "data-qm-entry": "" }).props.title, /1\.20K tokens/);
  } finally { await act(async () => tree?.unmount()); }
});

test("sidebar density is a versioned local preference; obsolete layout queries have no effect", async () => {
  const storage = new Map();
  for (const [search, initial, choose] of [["?qm-strip=B", "expanded", "收起"], ["?qm-strip=C", "compact", "展开"]]) {
    const host = client(async () => response(payload("A")), { storage, search });
    let tree;
    try {
      tree = await mount(host);
      assert.equal(tree.root.findAllByProps({ "data-qm-density": initial }).length, 1);
      assert.equal(tree.root.findAll((node) => node.props["data-qm-variant"] !== undefined).length, 0);
      await act(async () => button(tree, choose).props.onClick());
      assert.deepEqual(JSON.parse(storage.get("dsh-token-quota.ui.v1")), { sidebarDensity: initial === "expanded" ? "compact" : "expanded" });
    } finally { await act(async () => tree?.unmount()); }
  }
});

test("A1 pure display table separates percentages, balances, report periods, zero and unknown", () => {
  const { helpers, t } = client(async () => response(payload("A")));
  const cases = [
    [{ kind: "win", name: "5 小时", pct: 63 }, {}, "quota", "63%", "ok"],
    [{ kind: "win", name: "5 小时", pct: 0 }, {}, "quota", "0%", "ok"],
    [{ kind: "win", name: "未知", pct: null, used: null }, {}, "quota", "—", "neutral"],
    [{ kind: "win", name: "未知", pct: NaN, used: undefined }, {}, "quota", "—", "neutral"],
    [{ kind: "bal", name: "USD", remain: "$3", pct: null }, {}, "balance", "$3", "neutral"],
    [{ kind: "bal", name: "CNY", remain: 0 }, {}, "balance", "0", "neutral"],
    [{ kind: "cost", name: "最近完整 UTC 日", used: "$1.25", note: "2026-10-01 UTC" }, {}, "cost", "$1.25", "neutral"],
    [{ kind: "usage", name: "最近完整 UTC 日", used: "12K tokens" }, {}, "usage", "12K tokens", "neutral"],
    [{ kind: "win", name: "旧数据", pct: 98 }, { state: "err" }, "quota", "98%", "neutral"],
    [{ kind: "win", name: "已停用", pct: 98 }, { enabled: false }, "quota", "98%", "neutral"],
  ];
  for (const [entry, overrides, kind, value, tone] of cases) {
    const view = helpers.buildEntryView(entry, supplier([entry], overrides), t);
    assert.equal(view.kind, kind, entry.name);
    assert.equal(view.value, value, entry.name);
    assert.equal(view.tone, tone, entry.name);
    assert.equal(view.name, entry.name);
    if (["cost", "usage"].includes(kind)) assert.ok(!view.label.includes("余额") && !view.name.includes("今日"));
    if (overrides.state === "err") assert.equal(view.warning, null, "旧数据不得继续显示告警颜色或告警判断");
  }
  const currencies = supplier([{ kind: "bal", name: "USD", remain: "$3" }, { kind: "bal", name: "CNY", remain: "¥7" }]);
  const metric = helpers.selectPrimaryMetric(currencies, t);
  assert.equal(metric.value, "$3");
  assert.equal(metric.more, 1);
  assert.ok(!metric.text.includes("10"), "多币种不相加");
  assert.equal(helpers.supplierStatus(supplier([], { state: "err" }), t), "暂时无法获取");
  assert.equal(helpers.supplierStatus(supplier([{ kind: "bal", remain: "$3" }], { state: "err" }), t), "更新失败 · 上次数据");
  assert.equal(helpers.supplierStatus(supplier([], { enabled: false }), t), "未启用");
  assert.equal(helpers.supplierStatus(supplier([]), t), "尚未查询");
});

test("selected primary window owns its reset time and unknown reset does not borrow headline", () => {
  const { helpers, t } = client(async () => response(payload("A")));
  const resetAt = Date.now() + (2 * 60 + 13) * 60_000 + 30_000;
  const state = supplier([{ kind: "win", name: "5 小时", pct: 63, resetAt }, { kind: "win", name: "周用量", pct: 90, reset: "下周重置" }]);
  assert.equal(helpers.selectPrimaryMetric(state, t).name, "周用量");
  assert.equal(helpers.selectPrimaryMetric(state, t).reset, "下周重置");
  assert.match(helpers.buildEntryView(state.entries[0], state, t).reset, /2h1[23]m 后重置/);
  assert.equal(helpers.selectPrimaryMetric(supplier([{ kind: "win", name: "未提供时刻", pct: 95 }], { headline: { resetAt, reset: "错误窗口的重置" } }), t).reset, null);
  assert.equal(helpers.buildEntryView({ kind: "win", name: "占位", pct: 4, resetAt: 0, reset: "原始文案" }, state, t).reset, "原始文案");
  assert.equal(helpers.buildEntryView({ kind: "win", name: "错误单位", pct: 4, resetAt: 1791129600, reset: "—" }, state, t).reset, null);
  assert.equal(helpers.buildEntryView({ kind: "win", name: "已到期", pct: 4, resetAt: Date.now() - 1 }, state, t).reset, "即将重置");
  assert.equal(helpers.buildEntryView({ kind: "win", name: "长周期", pct: 4, resetAt: Date.now() + 43 * 60 * 60_000 + 30_000 }, state, t).reset, "1d19h 后重置");
});

test("the card bar prefers the weekly window, then the tightest window, then falls back to text", () => {
  const { helpers, t } = client(async () => response(payload("A")));
  const entry = (name, pct) => ({ kind: "win", name, pct, reset: `${name} 重置` });
  const bar = (sup) => helpers.selectBarMetrics(sup, t)[0] ?? null;
  // 周窗口优先于更紧的 5 小时窗口：卡片要回答的是「这周的套餐还剩多少」
  const weekly = bar(supplier([entry("5 小时", 71), entry("周窗口 · GOAT", 12)]));
  assert.equal(weekly.weekly, true);
  assert.equal(weekly.label, "周");
  assert.equal(weekly.entry.name, "周窗口 · GOAT");
  assert.equal(weekly.entry.pct, 12);
  assert.equal(weekly.reset, "周窗口 · GOAT 重置", "重置时间必须属于同一个窗口");
  // 没有周窗口 → 最紧的有效窗口，标签用它自己的名字（不冒充「周」）
  const tightest = bar(supplier([entry("5 小时", 12), entry("月额度 · GOAT", 71)]));
  assert.equal(tightest.weekly, false);
  assert.equal(tightest.label, "月额度 · GOAT");
  // 周窗口没给百分比 → 不回落到 0%，改报能报数的窗口
  const missing = bar(supplier([{ kind: "win", name: "Token 用量（周）" }, entry("5 小时", 12)]));
  assert.equal(missing.weekly, false);
  assert.equal(missing.label, "5 小时");
  assert.equal(helpers.weeklyEntryOf([{ kind: "win", name: "Token 用量（周）" }]), null);
  // 只有余额/报告 → 空数组：调用方回落成文字，绝不画一条 0% 的空条
  assert.equal(bar(supplier([{ kind: "bal", name: "CNY", remain: "¥41.99" }])), null);
  assert.equal(bar(null), null);
});

test("the bar follows the real Command Code shape: the month window is tighter but the week wins", () => {
  const { helpers, t } = client(async () => response(payload("A")));
  // 本机真实读数：5h 0% / 周 31% / 月额度 61%。最紧的是月额度，但卡片要报的是这一周。
  const commandCode = supplier([
    { kind: "win", name: "5h 窗口 · GOAT", pct: 0, limit: "$14.00", used: "$0.03", remain: "$13.97", reset: "约 5 小时后重置" },
    { kind: "win", name: "周窗口 · GOAT", pct: 31, limit: "$35.00", used: "$10.99", remain: "$24.01", reset: "10月11日 重置" },
    { kind: "win", name: "月额度 · GOAT", pct: 61, limit: "$70.00", used: "$42.62", remain: "$27.38", reset: "10月17日 重置" },
  ], { id: "commandcode", name: "Command Code" });
  const weekBar = helpers.selectBarMetrics(commandCode, t)[0];
  assert.equal(weekBar.entry.name, "周窗口 · GOAT", "月额度更紧也不许顶掉周窗口");
  assert.equal(weekBar.entry.pct, 31);
  assert.equal(weekBar.label, "周");
  assert.equal(weekBar.reset, "10月11日 重置", "重置时间跟着周窗口，不借月额度的");
  assert.equal(weekBar.tone, "ok");
  // 智谱 Coding Plan 的真实形状：5h 15% / 周 18%，周窗口胜出
  const zai = supplier([
    { kind: "win", name: "Token 用量（5 小时）", pct: 15, reset: "约 3 小时后重置", note: "官方插件字段" },
    { kind: "win", name: "Token 用量（周）", pct: 18, reset: "10月12日 重置", note: "官方插件字段" },
  ], { id: "zai-cn", name: "智谱 Coding Plan" });
  assert.equal(helpers.selectBarMetrics(zai, t)[0].entry.name, "Token 用量（周）");
});

test("the card bar takes its colour from the supplier thresholds and claims none for stale data", () => {
  const { helpers, t } = client(async () => response(payload("A")));
  const entry = (pct) => ({ kind: "win", name: "周用量", pct });
  const bar = (sup) => helpers.selectBarMetrics(sup, t)[0] ?? null;
  assert.equal(bar(supplier([entry(79)])).tone, "ok");
  assert.equal(bar(supplier([entry(80)])).tone, "warn");
  assert.equal(bar(supplier([entry(94)])).tone, "warn");
  assert.equal(bar(supplier([entry(95)])).tone, "crit");
  assert.equal(bar(supplier([entry(80)], { warnPct: 50, critPct: 70 })).tone, "crit", "阈值按供应商生效");
  assert.equal(bar(supplier([entry(60)], { warnPct: 50, critPct: 70 })).tone, "warn");
  assert.equal(bar(supplier([entry(80)], { state: "err" })).tone, "neutral", "旧数据不得继续报警");
  assert.equal(bar(supplier([entry(80)], { enabled: false })).tone, "neutral");
  assert.equal(bar(supplier([{ kind: "win", name: "周用量", pct: NaN }])), null, "未知百分比不画条");
});

test("watched limits keep their configured order and fall back to the default rule only on an empty intersection", () => {
  const { helpers, t } = client(async () => response(payload("A")));
  const bar = (sup) => helpers.selectBarMetrics(sup, t);
  const entries = [
    { kind: "win", key: "window.rolling", short: "5h", name: "5h 滚动", pct: 63, resetAt: Date.now() + 3_600_000 },
    { kind: "win", key: "window.weekly", short: "周", name: "周用量", pct: 40, resetAt: Date.now() + 40 * 3_600_000 },
    { kind: "win", key: "window.monthly", short: "月", name: "月用量", pct: 85, resetAt: Date.now() + 200 * 3_600_000 },
  ];
  // 配置顺序 = 排列顺序（不是按百分比排序）；每条按自己的百分比分档
  const watched = bar(supplier(entries, { displayKeys: ["window.monthly", "window.weekly"] }));
  const keysOf = (bars) => Array.from(bars, (b) => b.entry.key);
  assert.deepEqual(keysOf(watched), ["window.monthly", "window.weekly"]);
  assert.deepEqual(Array.from(watched, (b) => b.label), ["月", "周"]);
  assert.deepEqual(Array.from(watched, (b) => b.tone), ["warn", "ok"]);
  assert.match(watched[0].reset, /^\d+d\d+h$/, "卡片条上的倒计时是裸时长，不带「后重置」");
  // 配了但这一项当前没有数据 → 交集自清，只画剩下那条，不报错也不补假条
  const partial = bar(supplier(entries.slice(0, 2), { displayKeys: ["window.monthly", "window.weekly"] }));
  assert.deepEqual(keysOf(partial), ["window.weekly"]);
  // 交集为空 → 默认规则（周优先）；配置值本身不影响回落
  assert.deepEqual(keysOf(bar(supplier(entries, { displayKeys: ["gone.key"] }))), ["window.weekly"]);
  // 没有配置 → 默认规则
  assert.deepEqual(keysOf(bar(supplier(entries))), ["window.weekly"]);
});

test("the card draws one bar per watched limit with its own countdown and no today row", async () => {
  const state = payload("OpenCode", [supplier([
    { kind: "win", key: "window.weekly", short: "周", name: "周用量", pct: 40, resetAt: Date.now() + (2 * 24 + 5) * 3_600_000 + 30 * 60_000 },
    { kind: "win", key: "window.monthly", short: "月", name: "月用量", pct: 78, resetAt: Date.now() + (12 * 24 + 3) * 3_600_000 + 30 * 60_000 },
  ], { displayKeys: ["window.monthly", "window.weekly"], todayTokens: 1_240_000 })]);
  const host = client(async () => response(state));
  let tree;
  try {
    tree = await mount(host);
    const bars = tree.root.findAllByProps({ "data-qm-bar": "" });
    assert.equal(bars.length, 2, "两条关注限额各画一条");
    assert.deepEqual(bars.map((b) => b.props["data-qm-window"]), ["other", "week"]);
    assert.deepEqual(tree.root.findAllByProps({ className: "qm-bar-label" }).map(textOf), ["月", "周"]);
    assert.deepEqual(tree.root.findAllByProps({ className: "qm-bar-pct" }).map(textOf), ["78%", "40%"]);
    // 倒计时跟着各自那条窗口，不互借
    assert.deepEqual(tree.root.findAllByProps({ className: "qm-bar-reset" }).map(textOf), ["12d3h", "2d5h"]);
    assert.equal(tree.root.findAllByProps({ className: "qm-l3" }).length, 0, "卡片不再有今日行");
    // 今日用量搬进详情弹窗的供应商栏
    await act(async () => tree.root.findByProps({ "data-qm-entry": "" }).props.onClick());
    await act(async () => button(tree, "详情").props.onClick());
    assert.match(textOf(tree.root.findByProps({ className: "qm-today-line" })), /今日用量 1\.24M tokens/);
  } finally { await act(async () => tree?.unmount()); }
});

test("the ratio normalizes to cache misses and refuses to invent one from nothing", async () => {
  const host = client(async () => response(payload("A")));
  const { usageRatioOf, ratioPartsOf, splitPartsOf } = host.helpers;
  // 30 倍命中、0.15 倍输出：归一到未命中 = 1；每段都是 3 位有效数字（与卡片量级同口径）
  const ratio = usageRatioOf({ cacheReadTokens: 3_000_000, inputTokens: 100_000, outputTokens: 15_000 });
  assert.equal(ratio.text, "30.0 : 1.00 : 0.150");
  assert.equal(ratio.miss, "1.00");
  // 未命中为 0 时改按最大分量归一（不除零），未命中那段如实显示 0.00
  assert.equal(usageRatioOf({ cacheReadTokens: 1_000, inputTokens: 0, outputTokens: 10 }).text, "1.00 : 0.00 : 0.0100");
  // 三分量全 0、或只有未细分（旧版合并数据）→ null：没有分量就不编比例
  assert.equal(usageRatioOf({ inputTokens: 0 }), null);
  assert.equal(usageRatioOf({ unsplitTokens: 500 }), null);
  // 小于显示精度的段落显式给 <0.0001，不四舍五入成 0
  assert.equal(usageRatioOf({ cacheReadTokens: 1, inputTokens: 1_000_000, outputTokens: 1 }).text, "<0.0001 : 1.00 : <0.0001");
  // 详情行的分布条只取三分量；统计页取全部五分量；零分量都不出现
  //（返回数组来自 vm realm，按字符串比较，避免跨 realm 的原型差异）
  const usage = { cacheReadTokens: 30, inputTokens: 10, outputTokens: 5, cacheWriteTokens: 99, unsplitTokens: 7 };
  assert.equal(ratioPartsOf(usage).map((part) => part.cls).join(","), "hit,miss,out");
  assert.equal(splitPartsOf(usage).map((part) => part.cls).join(","), "hit,miss,out,write,unsplit");
  await act(async () => {});
});

test("details show the colored ratio next to today's total, and only when components exist", async () => {
  const state = payload("OpenCode", [supplier([{ name: "周用量", kind: "win", pct: 2 }], {
    todayTokens: 3_155_000,
    todayUsage: { inputTokens: 100_000, outputTokens: 15_000, cacheReadTokens: 3_000_000, cacheWriteTokens: 40_000, unsplitTokens: 0 },
  })]);
  const host = client(async () => response(state));
  let tree;
  try {
    tree = await mount(host);
    await open(tree);
    await act(async () => button(tree, "详情").props.onClick());
    const line = tree.root.findByProps({ className: "qm-today-line" });
    assert.match(textOf(line), /今日用量 3\.15M tokens/, "总量仍按供应商口径");
    assert.match(textOf(line), /30\.0 : 1\.00 : 0\.150/, "比例挨着总量：命中 : 未命中 : 输出，未命中 = 1");
    // 三个数字分别着段色，与三段分布条一一对应
    const ratio = line.findByProps({ className: "qm-ratio" });
    assert.deepEqual(ratio.findAllByType("b").map((node) => node.props.className), ["r-hit", "r-miss", "r-out"]);
    assert.equal(line.findAllByProps({ className: "qm-split-bar" }).length, 1);
    await act(async () => tree.unmount()); tree = null;

    // 旧载荷没有 todayUsage：只显示总量，不画空条、不编比例
    const legacy = client(async () => response(payload("OpenCode", [supplier([{ name: "周用量", kind: "win", pct: 2 }], { todayTokens: 500 })])));
    tree = await mount(legacy);
    await open(tree);
    await act(async () => button(tree, "详情").props.onClick());
    const bare = tree.root.findByProps({ className: "qm-today-line" });
    assert.match(textOf(bare), /今日用量 500 tokens/);
    assert.equal(bare.findAllByProps({ className: "qm-split-bar" }).length, 0);
    assert.equal(bare.findAllByProps({ className: "qm-ratio" }).length, 0);
  } finally { await act(async () => tree?.unmount()); }
});

test("the card head opens the statistics view with the ratio, legend and one combined chart", async () => {
  const start = (day) => new Date(...day.split("-").map((part, i) => (i === 1 ? Number(part) - 1 : Number(part)))).getTime();
  const usageDays = [
    { day: "2026-10-21", inputTokens: 50_000, outputTokens: 8_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 10_000, unsplitTokens: 0, total: 1_068_000 },
    { day: "2026-10-22", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, unsplitTokens: 0, total: 0 },
    { day: "2026-10-23", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, unsplitTokens: 0, total: 0 },
    { day: "2026-10-24", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, unsplitTokens: 0, total: 0 },
    { day: "2026-10-25", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, unsplitTokens: 0, total: 0 },
    { day: "2026-10-26", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, unsplitTokens: 0, total: 0 },
    { day: "2026-10-27", inputTokens: 100_000, outputTokens: 15_000, cacheReadTokens: 3_000_000, cacheWriteTokens: 40_000, unsplitTokens: 0, total: 3_155_000 },
  ];
  // 5h 窗口在 10-26 用满后重置（pct 90 → 8），周窗口一路缓升
  const quotaHistory = {
    "window.5h": [[start("2026-10-25"), 30], [start("2026-10-26"), 90], [start("2026-10-26") + 3_600_000, 8], [start("2026-10-27"), 62]],
    "window.weekly": [[start("2026-10-21"), 0], [start("2026-10-27") + 3_600_000, 20]],
  };
  const state = payload("OpenCode", [
    supplier([{ name: "5h 滚动", key: "window.5h", short: "5h", kind: "win", pct: 62 },
      { name: "周用量", key: "window.weekly", short: "周", kind: "win", pct: 20 }], {
      todayTokens: 3_155_000,
      todayUsage: { inputTokens: 100_000, outputTokens: 15_000, cacheReadTokens: 3_000_000, cacheWriteTokens: 40_000, unsplitTokens: 0 },
      usageDays,
      quotaHistory,
    }),
  ]);
  state.poll = { intervalSeconds: 60, retentionDays: 7, usageHistoryDays: 7, quotaHistoryDays: 7 };
  const host = client(async () => response(state));
  let tree;
  try {
    tree = await mount(host);
    // 标题行 = 名字 + 今日数，点击进入统计
    const head = tree.root.findByProps({ "data-qm-stats-entry": "" });
    assert.match(textOf(head), /OpenCode/);
    assert.match(textOf(head), /今日 3\.15M/);
    assert.equal(head.props["aria-haspopup"], "dialog");
    await act(async () => head.props.onClick());
    await flush();
    const dialog = tree.root.findByProps({ role: "dialog", "aria-modal": true });
    assert.equal(dialog.props["aria-label"], "用量统计");
    assert.equal(head.props["aria-expanded"], true);
    // 今日比例与窗口比例分开：今日 30.0:1.00:0.150，近 7 天合计 26.7:1.00:0.153
    assert.match(textOf(tree.root.findByProps({ className: "qm-stats-ratio" })), /30\.0 : 1\.00 : 0\.150/);
    assert.match(textOf(tree.root.findByProps({ className: "qm-stats-foot" })), /近 7 天 4\.22M/);
    assert.match(textOf(tree.root.findByProps({ className: "qm-stats-foot" })), /26\.7 : 1\.00 : 0\.153/);
    // 图例逐分量给数（未细分为 0 不出现）
    const legend = textOf(tree.root.findByProps({ className: "qm-stats-legend" }));
    assert.match(legend, /缓存命中 3\.00M/);
    assert.match(legend, /缓存未命中 100K/);
    assert.match(legend, /输出 15\.0K/);
    assert.match(legend, /缓存写入 40\.0K/);

    // 一张图：柱 = 每日 token（左轴顶端刻度 = 最高的那根柱），线 = 剩余额度
    const caption = textOf(tree.root.findByProps({ className: "qm-chart-cap" }));
    assert.match(caption, /3\.15M token/, "左轴顶端是最高柱值，不是窗口合计");
    // 日期刻度每天一个：柱在哪天一眼可见（含没有消耗的日子，时间轴才是连续的）
    const ticks = tree.root.findByProps({ className: "qm-chart-ticks" });
    assert.equal(ticks.findAllByProps({ className: "qm-chart-tick" }).length, 7);
    assert.equal(ticks.findAllByProps({ className: "qm-chart-tick" }).map(textOf).join(","),
      "10-21,10-22,10-23,10-24,10-25,10-26,10-27");
    const plot = tree.root.findByProps({ "data-qm-chart": "opencode" });
    const bars = plot.findAll((node) => node.type === "rect" && node.props.className === "qm-chart-bar");
    assert.equal(bars.length, 2, "只有两天有消耗，就只画两根柱");
    // 5h 用满后重置 → 两段折线（不把两次窗口连成一条斜线）；周窗口一段
    const lines = plot.findAll((node) => node.props.className === "qm-chart-line");
    const polylines = lines.filter((node) => node.type === "polyline");
    assert.equal(polylines.length, 3, "5h 两段 + 周一段");
    // 每个采样点一个锚点（5h 4 个 + 周 2 个）；换窗口处一条虚线把两段接上，
    // 否则稀疏时段看起来就是「线画断了」。
    const overlay = plot.findByProps({ className: "qm-chart-overlay" });
    assert.equal(overlay.findAllByProps({ className: "qm-chart-dot" }).length, 6);
    assert.equal(overlay.findAllByProps({ className: "qm-chart-drop" }).length, 1, "5h 换了一次窗口");
    // 剩余额度 = 100 − 已用：5h 当前 38%，周 80%
    const keys = tree.root.findAllByProps({ className: "qm-chart-key" }).map(textOf);
    assert.deepEqual(keys, ["5h 剩余 38%", "周 剩余 80%"]);
    // 折线纵坐标必须落在图内，且「已用越多越靠下」
    const ys = polylines.map((node) => node.props.points.split(" ").map((pair) => Number(pair.split(",")[1])));
    for (const row of ys) for (const y of row) assert.ok(y > 0 && y < 120, "折线不越出画布：" + y);
    // 悬停：十字线落在某一刻，浮层给那一刻的读数（最近一次采样，不插值）
    await act(async () => plot.props.onPointerMove({
      clientX: 570, currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 600 }) },
    }));
    const tip = textOf(tree.root.findByProps({ className: "qm-chart-tip" }));
    assert.match(tip, /10-27/, "浮层标明时刻");
    assert.match(tip, /3\.15M token/, "那一刻所在那天的柱值");
    assert.match(tip, /5h 剩余 38%/);
    assert.match(tip, /周 剩余 80%/);
    assert.ok(tree.root.findByProps({ className: "qm-chart-cursor" }), "有十字线");
    await act(async () => plot.props.onPointerLeave({ pointerType: "mouse" }));
    assert.equal(tree.root.findAllByProps({ className: "qm-chart-tip" }).length, 0, "移开收起");
    await act(async () => tree.unmount()); tree = null;

    // 没有额度历史（旧数据 / 刚开始记录）：只画柱，不画空折线、不出现空图例
    const noQuota = payload("OpenCode", [supplier([{ name: "周用量", kind: "win", pct: 2 }], {
      todayTokens: 3_155_000, todayUsage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 0, unsplitTokens: 0 }, usageDays,
    })]);
    noQuota.poll = { intervalSeconds: 60, retentionDays: 7, usageHistoryDays: 7 };
    const bare = client(async () => response(noQuota));
    tree = await mount(bare);
    await act(async () => tree.root.findByProps({ "data-qm-stats-entry": "" }).props.onClick());
    await flush();
    const barePlot = tree.root.findByProps({ "data-qm-chart": "opencode" });
    assert.equal(barePlot.findAll((node) => node.props.className === "qm-chart-bar").length, 2);
    assert.equal(barePlot.findAll((node) => node.props.className === "qm-chart-line").length, 0);
    assert.equal(tree.root.findAllByProps({ className: "qm-chart-key" }).length, 0);
    await act(async () => tree.unmount()); tree = null;

    // 一个有量的供应商都没有：空态一句话，不画空图表
    const empty = client(async () => response(payload("OpenCode", [supplier([{ name: "周用量", kind: "win", pct: 2 }])])));
    tree = await mount(empty);
    await act(async () => tree.root.findByProps({ "data-qm-stats-entry": "" }).props.onClick());
    await flush();
    assert.match(textOf(tree.root.findByProps({ className: "qm-empty" })), /暂无本地用量数据/);
    assert.equal(tree.root.findAllByProps({ "data-qm-chart": "opencode" }).length, 0);
  } finally { await act(async () => tree?.unmount()); }
});

test("the quota line breaks at resets and normalizes to a day-aligned axis", async () => {
  const host = client(async () => response(payload("A")));
  const { chartDomainOf, quotaSegmentsOf, quotaLegendOf, quotaUsedAt, clockOf, dayStartOf } = host.helpers;
  assert.equal(dayStartOf("2026-10-27"), new Date(2026, 9, 27).getTime());
  assert.ok(Number.isNaN(dayStartOf("2026/10/27")), "格式不对就是 NaN，不猜");

  // 时间轴左缘 = 第一天 00:00（柱是整天一格，线必须落在同一把尺子上）
  const days = [{ day: "2026-10-25" }, { day: "2026-10-26" }, { day: "2026-10-27" }];
  const now = new Date(2026, 9, 27, 12).getTime();
  const domain = chartDomainOf(days, now);
  assert.equal(domain.start, new Date(2026, 9, 25).getTime());
  assert.equal(domain.end, now, "今天还没过完，右缘就是此刻");
  // 未来日（时钟漂移）不让右缘越过后一天 00:00
  assert.equal(chartDomainOf(days, new Date(2026, 10, 5).getTime()).end, new Date(2026, 9, 28).getTime());
  assert.equal(chartDomainOf([], now), null, "没有日期就没有图");

  // 断开规则：pct 下降 = 换了新窗口；上升/持平都算同一条线
  //（返回值来自 vm realm，按字符串比较，避免跨 realm 的原型差异）
  assert.equal(quotaSegmentsOf([[1, 10], [2, 20], [3, 20], [4, 5], [5, 8]]).length, 2);
  assert.equal(quotaSegmentsOf([[1, 10], [2, 20], [3, 20], [4, 5], [5, 8]]).map((s) => s.length).join(","), "3,2");
  assert.equal(quotaSegmentsOf([[1, 5]]).length, 1, "单点也是一段（渲染成圆点）");
  assert.equal(quotaSegmentsOf([["x", 5], [2, NaN]]).length, 0, "坏点整段丢弃");

  // 悬停读数：取最近一次采样（保持到下一次变化），不插值 —— 插值会造出没采样到的数字
  assert.equal(quotaUsedAt([[1, 10], [3, 30]], 2), 10);
  assert.equal(quotaUsedAt([[1, 10], [3, 30]], 3), 30);
  assert.equal(quotaUsedAt([[1, 10]], 0), null, "第一个采样之前没有读数");
  assert.equal(quotaUsedAt([["x", 1], [2, NaN]], 5), null, "坏点不算读数");
  assert.equal(clockOf(new Date(2026, 9, 27, 8, 5).getTime()), "10-27 08:05");

  // 图例：名称取当前条目的短标签，剩余 = 100 − 最后一个 pct；没有样本的指标不出现
  const entries = [{ key: "window.5h", short: "5h" }, { key: "window.weekly", name: "周用量" }];
  const legend = quotaLegendOf({ "window.5h": [[1, 62]], "window.weekly": [[1, 20], [2, 21]], "gone.key": [] }, entries);
  assert.equal(legend.map((item) => `${item.label}:${item.remaining}`).join(","), "5h:38,周用量:79");
  assert.ok(colorUnique(legend), "同一张图里每条线颜色都不同");
  assert.equal(quotaLegendOf({}, entries).length, 0);
});

/** 图例配色不重复（同一张图里两条同色线等于没有图例）。 */
function colorUnique(legend) {
  return new Set(legend.map((item) => item.color)).size === legend.length;
}

test("the supplier page lists watched limits in check order, moves them, and saves displayKeys", async () => {
  const posts = [];
  const state = payload("OpenCode", [supplier([
    { kind: "win", key: "window.5h", short: "5h", name: "5h 滚动", pct: 63 },
    { kind: "win", key: "window.weekly", short: "周", name: "周用量", pct: 40 },
    { kind: "win", key: "window.monthly", short: "月", name: "月用量", pct: 78 },
  ], { displayKeys: [] })]);
  const host = client(async (url, opts) => {
    if (opts?.method !== "POST") return response(state);
    posts.push(JSON.parse(opts.body));
    return response({ ok: true });
  });
  let tree;
  try {
    tree = await mount(host, {}, host.Page);
    await act(async () => tab(tree, "供应商").props.onClick());
    await act(async () => button(tree, "配置").props.onClick());
    const rows = () => tree.root.findAll((node) => /^w-row/.test(node.props.className || ""));
    assert.equal(rows().length, 3);
    const check = (name, on) => {
      const row = rows().find((r) => textOf(r).includes(name));
      return act(async () => row.findByType("input").props.onChange({ target: { checked: on } }));
    };
    await check("月用量", true);
    await check("周用量", true);
    // 勾选顺序 = 排列顺序：先勾的在前
    assert.deepEqual(rows().filter((r) => /watched/.test(r.props.className)).map((r) => textOf(r).match(/月用量|周用量|5h 滚动/)[0]),
      ["月用量", "周用量"]);
    const up = tree.root.findAllByProps({ className: "w-move" })
      .flatMap((node) => node.findAllByType("button"))
      .find((b) => b.props["aria-label"] === "上移" && !b.props.disabled);
    assert.ok(up, "已勾选且非首位的行要有可用的上移按钮");
    await act(async () => up.props.onClick());
    await act(async () => button(tree, "保存").props.onClick());
    assert.deepEqual(posts[0].suppliers.opencode.displayKeys, ["window.weekly", "window.monthly"]);
  } finally { await act(async () => tree?.unmount()); }
});

test("token magnitudes always keep three significant digits", () => {
  const { helpers } = client(async () => response(payload("A")));
  assert.equal(helpers.fmtBig(1_318_275), "1.32M");
  assert.equal(helpers.fmtBig(64_429_367), "64.4M");
  assert.equal(helpers.fmtBig(193_090_302), "193M");
  assert.equal(helpers.fmtBig(1200), "1.20K");
  assert.equal(helpers.fmtBig(12_000), "12.0K");
  assert.equal(helpers.fmtBig(999), "999", "千位以下不补小数：token 计数没有小数意义");
  assert.equal(helpers.fmtBig(999_600), "1.00M", "进位后仍是 3 位有效数字，不是 1000K");
  assert.equal(helpers.fmtBig(1_999_999_999), "2.00B");
  assert.equal(helpers.fmtBig(null), "—");
  assert.equal(helpers.fmtBig(NaN), "—");
});

test("connection observation ignores disabled failures and distinguishes unconfigured and degraded states", () => {
  const { helpers } = client(async () => response(payload("A")));
  assert.equal(helpers.connStateOf({ traffic: { channelAlive: true }, suppliers: [supplier([], { state: "err" })] }).key, "warn");
  assert.equal(helpers.connStateOf({ traffic: { channelAlive: false }, suppliers: [] }).key, "err");
  assert.equal(helpers.connStateOf({ traffic: { channelAlive: false }, suppliers: [supplier([])] }).key, "off");
  assert.equal(helpers.connStateOf({ traffic: { channelAlive: true }, suppliers: [supplier([], { state: "err", enabled: false, added: false })] }).key, "ok");
});

for (const [warnPct, critPct, tones] of [[undefined, undefined, ["ok", "ok", "ok", "ok"]], [50, 70, ["ok", "warn", "warn", "crit"]]]) {
  test(`overview and supplier preview share threshold classification ${warnPct ?? "default"}/${critPct ?? "default"}`, async () => {
    const state = payload("OpenCode", [supplier([49, 50, 60, 70].map((pct) => ({ kind: "win", name: `e${pct}`, pct, used: String(pct), limit: "100" })), { warnPct, critPct })]);
    const host = client(async () => response(state));
    let tree;
    const renderedTones = () => tree.root.findAll((node) => /^ci-big /.test(node.props.className || "")).map((node) => node.props.className);
    try {
      tree = await mount(host);
      await open(tree);
      await act(async () => button(tree, "详情").props.onClick());
      assert.deepEqual(renderedTones(), tones.map((tone) => `ci-big ${tone}`));
      const card = tree.root.findByProps({ "data-supplier": "opencode" });
      assert.ok(textOf(card).includes(tones.at(-1) === "crit" ? "临界" : "正常"));
      await act(async () => button(tree, "设置").props.onClick());
      await act(async () => button(tree, "配置").props.onClick());
      assert.deepEqual(renderedTones(), tones.map((tone) => `ci-big ${tone}`));
      assert.ok(textOf(tree.root.findByProps({ className: "qm-page-head" })).includes(tones.at(-1) === "crit" ? "临界" : "正常"));
    } finally { await act(async () => tree?.unmount()); }
  });
}

test("unknown percentage and healthy balance remain neutral; failed old values show their last success time", async () => {
  const state = payload("OpenCode", [supplier([{ kind: "bal", name: "USD", remain: "$3", pct: null }, { kind: "win", name: "未知", pct: undefined, used: null }], { state: "err", lastSuccessAt: Date.now() - 60_000, error: { message: "quota endpoint unavailable" } })]);
  const host = client(async () => response(state));
  let tree;
  try {
    tree = await mount(host);
    assert.match(line(tree, "qm-l1"), /更新失败 · 上次数据/);
    // 没有可报的窗口 → 第 2 行回落成主指标文字（余额 $3），不画条
    assert.match(line(tree, "qm-l2"), /\$3/);
    assert.equal(barNode(tree), null, "未知百分比不画条");
    await open(tree);
    await act(async () => button(tree, "详情").props.onClick());
    const card = tree.root.findByProps({ "data-supplier": "opencode" });
    assert.ok(textOf(card).includes("quota endpoint unavailable"));
    assert.ok(textOf(card).includes("数据时间"));
    assert.ok(textOf(card).includes(new Date(state.suppliers[0].lastSuccessAt).toLocaleString()));
    assert.ok(!textOf(card).includes("0%"));
    assert.ok(!textOf(card).includes("无限额概念"));
    assert.deepEqual(card.findAll((node) => /^ci-big /.test(node.props.className || "")).map((node) => node.props.className), ["ci-big neutral", "ci-big neutral"]);
  } finally { await act(async () => tree?.unmount()); }
});

test("embedded settings preserves non-secret fields and retains rejected drafts", async () => {
  const posts = [];
  const data = payload("OpenCode", [supplier([], { orgId: "org-original", meta: { needs: [{ key: "apiKey", secret: true }, { key: "orgId", secret: false }] } })]);
  const host = client(async (url, opts) => {
    if (opts?.method !== "POST") return response(data);
    posts.push(JSON.parse(opts.body));
    return { ok: false, status: 400, json: async () => ({ ok: false, error: "validation rejected" }) };
  });
  let tree;
  try {
    tree = await mount(host, {}, host.Page);
    assert.equal(tree.root.findAllByProps({ role: "dialog" }).length, 0);
    await act(async () => tab(tree, "供应商").props.onClick());
    await act(async () => button(tree, "配置").props.onClick());
    assert.ok(tree.root.findAllByType("input").some((input) => input.props.value === "org-original"));
    await act(async () => button(tree, "保存").props.onClick());
    assert.equal(posts[0].suppliers.opencode.orgId, "org-original");
    assert.ok(!Object.hasOwn(posts[0].suppliers.opencode, "apiKey"));
    assert.equal(tree.root.findAllByProps({ className: "qm-page-head" }).length, 1);
    assert.equal(tree.root.findAllByProps({ className: "s-saved" }).length, 0);
    assert.equal(textOf(tree.root.findByProps({ role: "alert" })), "validation rejected");
    assert.ok(tree.root.findAllByType("input").some((input) => input.props.value === "org-original"));
  } finally { await act(async () => tree?.unmount()); }
});

// ---------- 峰谷计费时段（宿主下结论，客户端只展示） ----------

/** 直接问纯函数要倒计时文案：占位时刻必须得到 null（渲染路径之外的独立入口）。 */
const seasonCountdownOf = (host, flipAt, now) => host.helpers.seasonCountdown({ flipAt }, host.t, now);

/** 固定 flipAt 的时段载荷：避免用真实时钟导致倒计时文案随运行时刻抖动。 */
const seasonPayload = (season, suppliers = [supplier([])]) => ({
  ...payload("DeepSeek", suppliers),
  season: { peak: false, tier: "valley", kind: "weekday", valleyReason: null, beijing: { weekday: "周二", clock: "10:00", dayKey: "2026-10-13" }, warning: null, ...season },
});

test("expanded sidebar renders the billing tier with a live countdown; compact keeps it in the label only", async () => {
  const now = Date.UTC(2026, 9, 13, 2, 0, 0); // 北京时间 2026-10-13 10:00
  const flipAt = now + (3 * 3600 + 2 * 60) * 1000;
  const host = client(async () => response(seasonPayload({ flipAt, peak: true, tier: "peak" })), { clock: now });
  let tree, compactTree;
  try {
    tree = await mount(host);
    const row = tree.root.findByProps({ "data-qm-season": "peak" });
    assert.match(textOf(row), /峰价/);
    assert.match(textOf(row), /3h02m 后切换/, "倒计时由 flipAt 本地算出：" + textOf(row));
    assert.equal(row.findAll((node) => /qm-season-dot peak/.test(node.props.className || "")).length, 1);
    // 宿主时区为 +08:00（测试进程）时不加「按北京时间」后缀，避免噪音
    assert.ok(!textOf(row).includes("按北京时间"));
    const title = tree.root.findByProps({ "data-qm-entry": "" }).props.title;
    assert.ok(title.includes("北京时间"), "title 必须点名北京时间：" + title);
    await act(async () => tree.unmount());

    // 紧凑模式：行内不出现时段文案，但无障碍标签仍然带着它。
    // 必须换一个独立的 storage：density 是客户端模块级偏好，同一进程复用会让第二次挂载沿用第一次的展开态。
    const compactHost = client(async () => response(seasonPayload({ flipAt, peak: true, tier: "peak" })), {
      clock: now, storage: new Map([["dsh-token-quota.ui.v1", JSON.stringify({ sidebarDensity: "compact" })]]),
    });
    compactTree = await mount(compactHost);
    assert.equal(compactTree.root.findAllByProps({ "data-qm-density": "compact" }).length, 1, "先确认真的进了紧凑态");
    assert.equal(compactTree.root.findAllByProps({ "data-qm-season": "peak" }).length, 0, "紧凑模式不占字符");
    assert.ok(compactTree.root.findByProps({ "data-qm-entry": "" }).props.title.includes("峰价"));
    await act(async () => compactTree.unmount()); compactTree = null;

    // 切回完整：同一个宿主上按偏好恢复，证明这不是「一次性的查询参数」
    await act(async () => host.storage.set("dsh-token-quota.ui.v1", JSON.stringify({ sidebarDensity: "expanded" })));
    const expandedHost = client(async () => response(seasonPayload({ flipAt, peak: true, tier: "peak" })), {
      clock: now, storage: new Map([["dsh-token-quota.ui.v1", JSON.stringify({ sidebarDensity: "expanded" })]]),
    });
    tree = await mount(expandedHost);
    assert.equal(tree.root.findAllByProps({ "data-qm-season": "peak" }).length, 1);
  } finally { await act(async () => { compactTree?.unmount(); tree?.unmount(); }); }
});

test("season never invents a switch time: a placeholder flipAt shows the tier without a countdown", async () => {
  const host = client(async () => response(seasonPayload({ flipAt: 0 })));
  let tree;
  try {
    tree = await mount(host);
    const row = tree.root.findByProps({ "data-qm-season": "valley" });
    // 整行必须只有档位本身：出现任何倒计时文案（含「即将切换」）都是把占位时刻当成了真时刻
    assert.equal(textOf(row), "谷价", "占位 flipAt 只能渲染档位：" + textOf(row));
    assert.equal(seasonCountdownOf(host, 0, 1_800_000_000_000), null, "seasonCountdown 对占位时刻必须返回 null");
    assert.equal(seasonCountdownOf(host, 1_700_000_000, 1_800_000_000_000), null, "秒级值同样是占位，不得换算成倒计时");
    assert.equal(seasonCountdownOf(host, 1_800_000_600_000, 1_800_000_000_000), "10 分钟后切换", "合法时刻仍要给出倒计时");
    assert.equal(seasonCountdownOf(host, 1_800_000_600_000 + 2 * 3600_000, 1_800_000_000_000), "2h10m 后切换", "超过 1 小时用 h m");
    const title = tree.root.findByProps({ "data-qm-entry": "" }).props.title;
    assert.ok(!title.includes("切换"), "title 也不得出现切换文案：" + title);
  } finally { await act(async () => tree?.unmount()); }
});

test("the peek popover no longer repeats the tier; the coverage warning lives where it can be fixed", async () => {
  const now = Date.UTC(2026, 9, 13, 2, 0, 0);
  const flipAt = now + 65 * 60_000;
  const deepseek = { ...supplier([{ kind: "bal", remain: "¥8.22" }]), id: "deepseek", name: "DeepSeek",
    seasonSplit: { peakTokens: 0, valleyTokens: 3_400_000, unknownTokens: 0 } };
  const opencode = { ...supplier([]), todayTokens: 1 };
  const state = seasonPayload({ flipAt, valleyReason: "holiday", kind: "holiday", beijing: { weekday: "周六", clock: "11:20" }, warning: "节假日表缺少 2027 年的安排" }, [deepseek, opencode]);
  const host = client(async () => response(state), { clock: now });
  let tree, pageTree;
  try {
    tree = await mount(host);
    // 常驻卡片只报档位与倒计时：成因不进卡片行（明细里仍有）
    const row = tree.root.findByProps({ "data-qm-season": "valley" });
    assert.match(textOf(row), /^谷价 · 1h05m 后切换/, "卡片只报档位与倒计时：" + textOf(row));
    assert.ok(!textOf(row).includes("法定节假日"), "卡片不再合成因：" + textOf(row));
    await open(tree);
    assert.equal(tree.root.findAllByProps({ "data-qm-season-block": "valley" }).length, 0, "浮卡不再重复时段块");
    const split = tree.root.findByProps({ "data-qm-season-split": "deepseek" });
    assert.match(textOf(split), /空闲 3\.40M（100%）/);
    assert.equal(tree.root.findAllByProps({ "data-qm-season-split": "opencode" }).length, 0, "其他供应商不串峰谷口径");
    await act(async () => button(tree, "详情").props.onClick());
    const detail = tree.root.findByProps({ className: "qm-cols" });
    assert.equal(detail.findAllByProps({ "data-qm-season-block": "valley" }).length, 1, "详情只给适用的供应商挂时段块");
    assert.match(textOf(detail), /法定节假日/, "成因仍然可查");
    assert.match(textOf(detail), /节假日表缺少 2027 年/, "告警仍出现在明细里");
    await act(async () => tree.unmount()); tree = null;

    // 缺次年必须点名，且要点在能粘贴覆盖表的地方（浮卡已经不再承担这件事）
    const pageHost = client(async () => response(state), { clock: now });
    pageTree = await mount(pageHost, {}, pageHost.Page);
    await act(async () => tab(pageTree, "设置").props.onClick());
    await flush();
    const warning = pageTree.root.findByProps({ className: "qm-season-warn" });
    assert.equal(warning.props.role, "status", "告警要能被读屏读到");
    assert.match(textOf(warning), /2027/, "缺次年必须在设置页点名");
  } finally { await act(async () => { tree?.unmount(); pageTree?.unmount(); }); }
});

test("today's split sums to the reported total and hides itself when there is nothing to split", async () => {
  const splitOf = (peakTokens, valleyTokens, unknownTokens) => ({ peakTokens, valleyTokens, unknownTokens });
  const deepseek = { ...supplier([]), id: "deepseek", name: "DeepSeek", seasonSplit: splitOf(1_200_000, 3_600_000, 0) };
  const host = client(async () => response(seasonPayload({ flipAt: Date.now() + 60_000 }, [deepseek])));
  let tree;
  try {
    tree = await mount(host);
    await open(tree);
    const split = textOf(tree.root.findByProps({ "data-qm-season-split": "deepseek" }));
    assert.match(split, /高峰 1\.20M（25%）/);
    assert.match(split, /空闲 3\.60M（75%）/);
    await act(async () => tree.unmount());

    // 无用量 / 只有未知段（早于峰谷定价的旧桶）时不编造结论
    const empty = client(async () => response(seasonPayload({}, [{ ...supplier([]), id: "deepseek", name: "DeepSeek", seasonSplit: splitOf(0, 0, 0) }])));
    tree = await mount(empty);
    await open(tree);
    assert.equal(tree.root.findAllByProps({ "data-qm-season-split": "deepseek" }).length, 0);
  } finally { await act(async () => tree?.unmount()); }
});

test("settings paste an explicit holiday override; invalid dates are rejected before saving", async () => {
  const posts = [];
  const host = client(async (url, opts) => {
    if (opts?.method !== "POST") return response(seasonPayload({}, [supplier([])]));
    posts.push(JSON.parse(opts.body));
    return response({ ok: true });
  });
  let tree;
  try {
    tree = await mount(host, {}, host.Page);
    // 全局设置（含节假日覆盖表）在「设置」页签下，不在默认的概览页
    await act(async () => tab(tree, "设置").props.onClick());
    await flush();
    const box = tree.root.findByType("textarea");
    assert.equal(box.props.value, "", "未配置时留空 = 用内置表");
    // 逗号/换行混排都要能接受
    await act(async () => box.props.onChange({ target: { value: "2027-01-02, 2027-01-01\n2027-02-06" } }));
    await act(async () => button(tree, "保存").props.onClick());
    assert.deepEqual(posts[0].holidays, ["2027-01-01", "2027-01-02", "2027-02-06"]);
    // 非法日期在前端就拦下，不发给宿主
    const before = posts.length;
    await act(async () => tree.root.findByType("textarea").props.onChange({ target: { value: "2027-02-30" } }));
    await act(async () => button(tree, "保存").props.onClick());
    assert.equal(posts.length, before, "非法日期不得提交");
    assert.match(textOf(tree.root.findByProps({ role: "alert" })), /2027-02-30/);
  } finally { await act(async () => tree?.unmount()); }
});

test("both locale dictionaries stay complete and agree on placeholders", () => {
  const host = client(async () => response(seasonPayload({})));
  const { zh, en } = host.locales;
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), "新增文案必须中英双份");
  for (const key of Object.keys(zh)) {
    const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(placeholders(en[key]), placeholders(zh[key]), `占位符不一致：${key}`);
  }
});
