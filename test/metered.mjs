import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, Config } from "../lib/index.js";
import { createCtx } from "./harness.mjs";
import { ledgerKeyOf, meteredIdOf, meteredNameOf, isMeteredId, routeOfMeteredId } from "../lib/ledger.js";
import { createUsageRecorder } from "../lib/usage.js";
import { PROVIDERS } from "../lib/providers.js";
import { supplierForRoute } from "../lib/detect.js";

// ---------- 归属判据（纯函数） ----------

test("a route lands on exactly one ledger: registered supplier, explicit alias, or a metered row", () => {
  const owner = supplierForRoute;
  const cases = [
    // 注册表：精确表与前缀表都算「已注册」，账本 key 就是供应商 id
    ["deepseek-official", "deepseek"],
    ["deepseek", "deepseek"],
    ["commandcode-goat", "commandcode"],
    // 显式并表：桌面登录与 API Key 是同一账户的两条路，并成一行
    ["deepseek-account", "deepseek"],
    // 不认识的路由：自成一行，key 带 local: 前缀
    ["siliconflow", "local:siliconflow"],
    ["pi-ai-openai-compatible-2", "local:pi-ai-openai-compatible-2"],
  ];
  for (const [route, expected] of cases) {
    assert.equal(ledgerKeyOf(route, owner), expected, route);
  }
  // 扫描期 discovery 的结果优先于静态表
  assert.equal(ledgerKeyOf("my-opencode", (r) => (r === "my-opencode" ? "opencode" : null)), "opencode");
  // 非法路由不落账（事件里 provider 缺失时不制造空行）
  assert.equal(ledgerKeyOf(null, owner), null);
  assert.equal(ledgerKeyOf("", owner), null);
  assert.equal(ledgerKeyOf(42, owner), null);
});

test("metered ids round-trip and never collide with registry ids", () => {
  assert.equal(meteredIdOf("a:b/c"), "local:a:b/c");
  assert.equal(isMeteredId("local:x"), true);
  assert.equal(isMeteredId("deepseek"), false);
  assert.equal(routeOfMeteredId("local:pi-ai/x"), "pi-ai/x");
  assert.equal(routeOfMeteredId("deepseek"), null);
});

test("a metered row is named by the user's rename first, then the DSH display name, then the route", () => {
  assert.equal(meteredNameOf("siliconflow", { siliconflow: " 硅基流动 " }, {}), "硅基流动");
  assert.equal(meteredNameOf("siliconflow", { siliconflow: "   " }, { siliconflow: "SiliconFlow" }), "SiliconFlow");
  assert.equal(meteredNameOf("siliconflow", {}, {}), "siliconflow");
  // 名字是显示文本：超长截断，不把整段配置塞进侧栏
  assert.equal(meteredNameOf("x", { x: "长".repeat(200) }, {}).length, 60);
});

// ---------- 跨 key 替换不双计（I1） ----------

test("a sample that changes ledger moves its tokens instead of counting twice", () => {
  const buckets = {};
  const record = createUsageRecorder(buckets);
  const session = { id: "s" };
  const sample = { inputTokens: 100, outputTokens: 20 };
  // 早期样本报在未映射路由上，最终样本报在注册表供应商上（同一 turn/step）
  assert.equal(record(session, "local:siliconflow", sample, 1, 1), true);
  assert.equal(record(session, "deepseek", sample, 1, 1), true);
  assert.equal(JSON.stringify(buckets["local:siliconflow"]), "{}", "旧 key 的桶被扣空");
  assert.equal(Object.keys(buckets["local:siliconflow"]).length, 0);
  const total = Object.values(buckets).flatMap((hours) => Object.values(hours))
    .reduce((sum, bucket) => sum + (bucket.inputTokens || 0) + (bucket.outputTokens || 0), 0);
  assert.equal(total, 120, "同一 (session, turn, step) 只算一次");
});

test("after a ledger move, the replacement subtracts from the new key instead of adding twice", () => {
  const buckets = {};
  const movedTo = {};
  const record = createUsageRecorder(buckets, movedTo);
  const session = { id: "s" };
  const sample = { inputTokens: 600 };
  assert.equal(record(session, "local:r", sample, 1, 1), true);
  // 收编：桶搬进 deepseek，旧 key 删除，并登记搬家
  buckets.deepseek = { ...buckets["local:r"] };
  delete buckets["local:r"];
  movedTo["local:r"] = "deepseek";
  // 同一步骤的下一份样本报到新 key：扣减要落在搬过去的桶里
  assert.equal(record(session, "deepseek", sample, 1, 1), true);
  const total = Object.values(buckets).flatMap((hours) => Object.values(hours))
    .reduce((sum, bucket) => sum + (bucket.inputTokens || 0), 0);
  assert.equal(total, 600, "搬家后的替换仍然是替换，不是第二次累加");
});

// ---------- 宿主侧集成 ----------
function mount({ config = {}, foreign = [] } = {}) {
  const home = mkdtempSync(join(tmpdir(), "qm-metered-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const harness = createCtx({ schema: Config, config, foreign });
  const dispose = apply(harness.ctx, harness.configRef);
  const state = async () => harness.call("/api/dsh-token-quota/state");
  // 同一个会话对象跨事件复用：记录器按对象身份记步骤状态，每次新建对象就测不出替换语义了。
  const session = { id: "page" };
  const emit = (event) => harness.emit("session/event", session, event);
  return {
    harness, emit, state,
    cleanup() {
      dispose();
      if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const usageEvent = (provider, usage, turn = 1, step = 1) => ({
  type: "assistant/message",
  data: { turn, step, message: { source: { provider, model: "m" } }, usage },
});

test("an unknown route's tokens become a read-only metered row, not a dropped event", async () => {
  const host = mount();
  try {
    host.emit(usageEvent("siliconflow", { inputTokens: 300, outputTokens: 60, cacheReadTokens: 1_000 }));
    host.emit(usageEvent("deepseek-official", { inputTokens: 40, outputTokens: 10 }, 2, 1));

    const payload = await host.state();
    const metered = payload.suppliers.find((s) => s.id === "local:siliconflow");
    assert.ok(metered, "未映射路由应当出现在供应商列表里");
    assert.equal(metered.queryable, false);
    assert.equal(metered.state, "metered");
    assert.equal(metered.current, true, "恒进今日总量");
    assert.equal(metered.added, true);
    assert.equal(metered.route, "siliconflow");
    assert.equal(metered.todayTokens, 1_360);
    const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, unsplitTokens } = metered.todayUsage;
    assert.deepEqual({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, unsplitTokens }, {
      inputTokens: 300, outputTokens: 60, cacheReadTokens: 1_000, cacheWriteTokens: 0, unsplitTokens: 0,
    });
    assert.deepEqual(metered.entries, [], "没有可查询指标");
    assert.equal(Object.hasOwn(metered, "quotaHistory"), false, "也不取额度历史");
    assert.equal(Object.hasOwn(metered, "lastSuccessAt"), false, "从不查询，没有成功数据时间");

    // 注册表供应商照旧，且没有被未映射路由污染
    const deepseek = payload.suppliers.find((s) => s.id === "deepseek");
    assert.equal(deepseek.queryable, true);
    assert.equal(deepseek.todayTokens, 50);
    assert.equal(payload.active.supplierId, "deepseek", "当前在用取最近一次调用");

    // 今日总量 = 列表里每一行之和：有用量就算已添加，谁也藏不住（注册表行与仅计量行同一口径）。
    assert.equal(deepseek.added, true, "有 token 的行必须出现在列表里");
    assert.equal(deepseek.addedReason, "usage");
    assert.equal(deepseek.current, false, "「当前」仍按流量判，不因为有用量就冒充在用");
    const total = payload.suppliers.filter((s) => s.added !== false)
      .reduce((sum, s) => sum + (Number(s.todayTokens) || 0), 0);
    assert.equal(total, 1_410, "未启用的注册表行与仅计量行都计入总量");
  } finally { host.cleanup(); }
});

test("a desktop-login route with no API key still lands on a row the overview shows and counts", async () => {
  // deepseek-account 并进 deepseek 是没错的（同一账户），错的是「没配 Key 时那一行不算已添加」：
  // 那会把登录态的 token 记进一行既不展示、也不计入今日总量的账本，比整条丢掉更难发现。
  const host = mount();
  try {
    host.emit(usageEvent("deepseek-account", { inputTokens: 1_000 }));
    const payload = await host.state();
    assert.equal(payload.suppliers.some((s) => s.id.startsWith("local:")), false, "并表路由不另开仅计量行");
    const deepseek = payload.suppliers.find((s) => s.id === "deepseek");
    assert.equal(deepseek.todayTokens, 1_000);
    assert.equal(deepseek.added, true, "有用量 ⇒ 概览可见");
    assert.equal(deepseek.queryable, true, "仍是注册表供应商（可查额度），不是仅计量行");
    const total = payload.suppliers.filter((s) => s.added !== false)
      .reduce((sum, s) => sum + (Number(s.todayTokens) || 0), 0);
    assert.equal(total, 1_000, "小组件与概览读到同一个今日总量");
  } finally { host.cleanup(); }
});

test("refreshing never queries a metered row and never guesses a percentage for it", async (t) => {
  // 真实网络在这里没有意义：只钉「刷新只走注册表供应商」这一件事。
  t.mock.method(PROVIDERS.deepseek, "query", async () => ({
    state: "ok", entries: [{ name: "可用余额", kind: "bal", remain: "¥10", pct: null }],
    headline: { kind: "amt", amt: "¥10" },
  }));
  const host = mount({ config: { suppliers: { deepseek: { enabled: true, apiKey: "saved" } } } });
  try {
    host.emit(usageEvent("siliconflow", { inputTokens: 10 }));
    // 只让 deepseek 真的去查询：刷新后仅计量行仍然是 metered，没有 state/err 之类的查询状态
    const payload = await host.harness.call("/api/dsh-token-quota/refresh", {});
    const metered = payload.suppliers.find((s) => s.id === "local:siliconflow");
    assert.equal(metered.state, "metered");
    assert.equal(metered.headline.kind, "amt");
    assert.equal(metered.headline.amt, "—");
    assert.deepEqual(metered.entries, []);
    assert.equal(payload.suppliers.filter((s) => s.id.startsWith("local:")).length, 1);
  } finally { host.cleanup(); }
});

test("renaming a metered row writes only meteredNames, and the sanitizer keeps values bounded", async () => {
  const host = mount();
  try {
    host.emit(usageEvent("siliconflow", { inputTokens: 10 }));
    const saved = await host.harness.call("/api/dsh-token-quota/settings", {
      meteredNames: { siliconflow: "  硅基流动  ", "": "ignored", junk: 42 },
    });
    assert.equal(saved.ok, true);
    assert.equal(host.harness.settings.userLayer.meteredNames.siliconflow, "硅基流动");
    assert.equal(host.harness.settings.userLayer.meteredNames.junk, "", "非字符串收敛成空串（回到默认名）");
    assert.ok(!Object.hasOwn(host.harness.settings.userLayer.meteredNames, ""), "空路由键被丢弃");

    const payload = await host.state();
    assert.equal(payload.suppliers.find((s) => s.id === "local:siliconflow").name, "硅基流动");

    // 坏形状直接拒绝，不落盘
    const rejected = await host.harness.call("/api/dsh-token-quota/settings", { meteredNames: [] });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /meteredNames/);
  } finally { host.cleanup(); }
});

test("a route later recognised by the registry takes its metered history with it", async () => {
  const host = mount();
  try {
    host.emit(usageEvent("proxied-deepseek", { inputTokens: 500, outputTokens: 100 }));
    const before = await host.state();
    assert.equal(before.suppliers.find((s) => s.id === "local:proxied-deepseek").todayTokens, 600);

    // DSH 侧给这条路由配了一个指向 DeepSeek 官方主机的 profile：扫描按主机把它归给 deepseek
    host.harness.settings.foreign.push({
      ns: "llm-pi-ai",
      value: { providers: { "proxied-deepseek": { baseURL: "https://api.deepseek.com", apiKeyEnv: "DSH_KEY" } } },
      user: {},
    });
    const rescanned = await host.harness.call("/api/dsh-token-quota/rescan", {});
    assert.equal(rescanned.ok, true, "重扫应成功");

    const after = await host.harness.call("/api/dsh-token-quota/state");
    assert.equal(after.suppliers.some((s) => s.id === "local:proxied-deepseek"), false, "仅计量行不再存在");
    const deepseek = after.suppliers.find((s) => s.id === "deepseek");
    assert.equal(deepseek.todayTokens, 600, "历史并入正式供应商，不从 0 开始");
    // 收编不能把 token 搬出「计入总量」的范围：今日总量在收编前后必须一样。
    const total = after.suppliers.filter((s) => s.added !== false)
      .reduce((sum, s) => sum + (Number(s.todayTokens) || 0), 0);
    assert.equal(total, 600, "收编前后今日总量不变");

    // 仍在流式里的同一步骤再报一次相同样本：扣减必须跟着搬家走到新 key，否则整份样本会再加一遍。
    host.emit(usageEvent("proxied-deepseek", { inputTokens: 500, outputTokens: 100 }));
    const settled = await host.harness.call("/api/dsh-token-quota/state");
    assert.equal(settled.suppliers.find((s) => s.id === "deepseek").todayTokens, 600, "替换样本不双计");
  } finally { host.cleanup(); }
});
