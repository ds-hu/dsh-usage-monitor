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
  vm.runInNewContext(source.replace("exports.apply = apply;", "exports.__test = { buildEntryView, selectPrimaryMetric, supplierStatus, connStateOf, seasonCountdown, seasonSplitText, fmtBig, weeklyEntryOf, selectBarMetric }; exports.apply = apply;"), context);
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
    // 第 1 行是 plan 名：插件标题、连接圆点与模型名都不再进卡片
    assert.equal(line(tree, "qm-l1"), "OpenCode");
    // 第 2 行是周窗口（2%），而不是更紧的 5 小时窗口（5%）
    const row = barNode(tree);
    assert.equal(row.props["data-qm-window"], "week");
    assert.equal(row.props["data-qm-tone"], "ok");
    assert.equal(row.props.role, "progressbar");
    assert.equal(row.props["aria-valuenow"], 2);
    assert.match(textOf(tree.root.findByProps({ className: "qm-l2" })), /^周2%$/, "标签是「周」，数字是 2%");
    assert.equal(row.find((n) => /qm-bar-fill/.test(n.props.className || "")).props.style.width, "2%");
    // 第 3 行：今日用量（3 位有效数字）+ 第 2 行那个窗口自己的重置时间
    assert.match(line(tree, "qm-l3"), /65\.7M tokens/);
    assert.match(line(tree, "qm-l3"), /下周重置/);
    assert.ok(!line(tree, "qm-l3").includes("约 2 小时后重置"), "重置时间必须属于第 2 行那个窗口");
    const entry = tree.root.findByProps({ "data-qm-entry": "" });
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
    assert.match(line(tree, "qm-l3"), /1\.20K tokens/);
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
  // 周窗口优先于更紧的 5 小时窗口：卡片要回答的是「这周的套餐还剩多少」
  const weekly = helpers.selectBarMetric(supplier([entry("5 小时", 71), entry("周窗口 · GOAT", 12)]), t);
  assert.equal(weekly.weekly, true);
  assert.equal(weekly.label, "周");
  assert.equal(weekly.entry.name, "周窗口 · GOAT");
  assert.equal(weekly.entry.pct, 12);
  assert.equal(weekly.reset, "周窗口 · GOAT 重置", "重置时间必须属于同一个窗口");
  // 没有周窗口 → 最紧的有效窗口，标签用它自己的名字（不冒充「周」）
  const tightest = helpers.selectBarMetric(supplier([entry("5 小时", 12), entry("月额度 · GOAT", 71)]), t);
  assert.equal(tightest.weekly, false);
  assert.equal(tightest.label, "月额度 · GOAT");
  // 周窗口没给百分比 → 不回落到 0%，改报能报数的窗口
  const missing = helpers.selectBarMetric(supplier([{ kind: "win", name: "Token 用量（周）" }, entry("5 小时", 12)]), t);
  assert.equal(missing.weekly, false);
  assert.equal(missing.label, "5 小时");
  assert.equal(helpers.weeklyEntryOf([{ kind: "win", name: "Token 用量（周）" }]), null);
  // 只有余额/报告 → null：调用方回落成文字，绝不画一条 0% 的空条
  assert.equal(helpers.selectBarMetric(supplier([{ kind: "bal", name: "CNY", remain: "¥41.99" }]), t), null);
  assert.equal(helpers.selectBarMetric(null, t), null);
});

test("the bar follows the real Command Code shape: the month window is tighter but the week wins", () => {
  const { helpers, t } = client(async () => response(payload("A")));
  // 本机真实读数：5h 0% / 周 31% / 月额度 61%。最紧的是月额度，但卡片要报的是这一周。
  const commandCode = supplier([
    { kind: "win", name: "5h 窗口 · GOAT", pct: 0, limit: "$14.00", used: "$0.03", remain: "$13.97", reset: "约 5 小时后重置" },
    { kind: "win", name: "周窗口 · GOAT", pct: 31, limit: "$35.00", used: "$10.99", remain: "$24.01", reset: "10月11日 重置" },
    { kind: "win", name: "月额度 · GOAT", pct: 61, limit: "$70.00", used: "$42.62", remain: "$27.38", reset: "10月17日 重置" },
  ], { id: "commandcode", name: "Command Code" });
  const bar = helpers.selectBarMetric(commandCode, t);
  assert.equal(bar.entry.name, "周窗口 · GOAT", "月额度更紧也不许顶掉周窗口");
  assert.equal(bar.entry.pct, 31);
  assert.equal(bar.label, "周");
  assert.equal(bar.reset, "10月11日 重置", "重置时间跟着周窗口，不借月额度的");
  assert.equal(bar.tone, "ok");
  // 智谱 Coding Plan 的真实形状：5h 15% / 周 18%，周窗口胜出
  const zai = supplier([
    { kind: "win", name: "Token 用量（5 小时）", pct: 15, reset: "约 3 小时后重置", note: "官方插件字段" },
    { kind: "win", name: "Token 用量（周）", pct: 18, reset: "10月12日 重置", note: "官方插件字段" },
  ], { id: "zai-cn", name: "智谱 Coding Plan" });
  assert.equal(helpers.selectBarMetric(zai, t).entry.name, "Token 用量（周）");
});

test("the card bar takes its colour from the supplier thresholds and claims none for stale data", () => {
  const { helpers, t } = client(async () => response(payload("A")));
  const entry = (pct) => ({ kind: "win", name: "周用量", pct });
  assert.equal(helpers.selectBarMetric(supplier([entry(79)]), t).tone, "ok");
  assert.equal(helpers.selectBarMetric(supplier([entry(80)]), t).tone, "warn");
  assert.equal(helpers.selectBarMetric(supplier([entry(94)]), t).tone, "warn");
  assert.equal(helpers.selectBarMetric(supplier([entry(95)]), t).tone, "crit");
  assert.equal(helpers.selectBarMetric(supplier([entry(80)], { warnPct: 50, critPct: 70 }), t).tone, "crit", "阈值按供应商生效");
  assert.equal(helpers.selectBarMetric(supplier([entry(60)], { warnPct: 50, critPct: 70 }), t).tone, "warn");
  assert.equal(helpers.selectBarMetric(supplier([entry(80)], { state: "err" }), t).tone, "neutral", "旧数据不得继续报警");
  assert.equal(helpers.selectBarMetric(supplier([entry(80)], { enabled: false }), t).tone, "neutral");
  assert.equal(helpers.selectBarMetric(supplier([{ kind: "win", name: "周用量", pct: NaN }]), t), null, "未知百分比不画条");
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
