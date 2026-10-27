import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, Config } from "../lib/index.js";
import { createCtx } from "./harness.mjs";
import { PROVIDERS } from "../lib/providers.js";
import * as season from "../lib/season.js";
import { dayLabelOf } from "../lib/storage.js";

test("plugin instances do not share traffic and dispose releases event handlers", async () => {
  const originalHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), "qm-runtime-"));
  process.env.DSH_HOME = home;
  const instances = [];
  function mount() {
    const { ctx, configRef, routes, events } = createCtx({ schema: Config, config: {} });
    const dispose = apply(ctx, configRef);
    instances.push(dispose);
    return { events, state() {
      let state;
      routes.get("/api/dsh-token-quota/state")({ method: "GET", headers: {}, url: "/api/dsh-token-quota/state" },
        { writeHead() {}, end(value) { state = JSON.parse(value); } });
      return state;
    } };
  }
  try {
    const first = mount();
    first.events.get("session/event")[0]({ id: "a" }, { type: "request/header", data: {
      config: { provider: "deepseek-official", model: "one" },
    } });
    const second = mount();
    assert.equal(first.state().active.model, "one");
    assert.equal(second.state().active, null);
    instances[0]();
    assert.equal(first.events.size, 0);
  } finally {
    for (const dispose of instances) dispose();
    if (originalHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = originalHome;
    rmSync(home, { force: true, recursive: true });
  }
});

test("state reports the last successful query time and never substitutes a failed attempt", async (t) => {
  const previousHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), "qm-state-time-"));
  process.env.DSH_HOME = home;
  let time = 1_800_000_000_000;
  let queryResult = { state: "err", error: { code: "network", message: "offline" }, entries: [] };
  const success = { state: "ok", entries: [{ type: "balance", remain: "10", unit: "CNY" }], headline: { kind: "amt", amt: "¥10" } };
  t.mock.method(Date, "now", () => time);
  t.mock.method(PROVIDERS.deepseek, "query", async () => queryResult);
  const harness = createCtx({ schema: Config, config: {
    suppliers: { deepseek: { enabled: true, apiKey: "saved" } },
  } });
  const dispose = apply(harness.ctx, harness.configRef);
  t.after(() => {
    dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  const supplier = (payload) => payload.suppliers.find((s) => s.id === "deepseek");

  const failedFirst = supplier(await harness.call("/api/dsh-token-quota/refresh", {}));
  assert.equal(failedFirst.state, "err");
  assert.equal(Object.hasOwn(failedFirst, "lastSuccessAt"), false, "没有成功数据时省略成功时间");

  time += 5_000;
  queryResult = success;
  const succeeded = supplier(await harness.call("/api/dsh-token-quota/refresh", {}));
  assert.equal(succeeded.lastSuccessAt, time, "成功时间来自调度器的查询完成时刻");
  assert.equal(supplier(await harness.call("/api/dsh-token-quota/state")).lastSuccessAt, time);

  time += 5_000;
  queryResult = { state: "err", error: { code: "network", message: "offline again" }, entries: [] };
  const failedAgain = supplier(await harness.call("/api/dsh-token-quota/refresh", {}));
  assert.equal(failedAgain.state, "err");
  assert.deepEqual(failedAgain.entries, success.entries, "失败时继续提供上次有效数据");
  assert.equal(failedAgain.lastSuccessAt, succeeded.lastSuccessAt, "失败时间不得覆盖成功数据时间");
  assert.match(failedAgain.fetchedAt, /失败/);

  const changed = await harness.call("/api/dsh-token-quota/settings", {
    suppliers: { deepseek: { apiKey: "replacement", enabled: false } },
  });
  assert.equal(changed.ok, true);
  const reset = supplier(await harness.call("/api/dsh-token-quota/state"));
  assert.equal(Object.hasOwn(reset, "lastSuccessAt"), false, "配置变更后不得沿用旧凭据的数据时间");
  assert.equal(reset.error.code, "no-run");
});

test("season rides on /state as a host verdict; the holiday override round-trips through /settings", async (t) => {
  const previousHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), "qm-season-"));
  process.env.DSH_HOME = home;
  const harness = createCtx({ schema: Config, config: { suppliers: {} } });
  const warnings = [];
  harness.ctx.logger = { info() {}, warn: (...args) => warnings.push(args.join(" ")), error() {} };
  const dispose = apply(harness.ctx, harness.configRef);
  t.after(() => {
    dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  const beijingDayKey = (at) => new Date(at.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
  const weekdayNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const now = new Date();

  // 1) 宿主下发结论，客户端不需要自己判定
  const first = await harness.call("/api/dsh-token-quota/state");
  assert.equal(typeof first.season.peak, "boolean");
  assert.equal(first.season.tier, first.season.peak ? "peak" : "valley");
  assert.ok(["weekday", "weekend", "holiday"].includes(first.season.kind));
  // 成因只可能出现在谷价里，且必须与 kind 一致
  assert.equal(first.season.valleyReason, first.season.peak ? null : (first.season.kind === "weekday" ? null : first.season.kind));
  assert.match(first.season.beijing.clock, /^\d{2}:\d{2}$/);
  assert.equal(first.season.beijing.weekday, weekdayNames[new Date(now.getTime() + 8 * 3600_000).getUTCDay()]);
  assert.equal(first.season.beijing.dayKey, beijingDayKey(now));
  if (first.season.flipAt !== null) assert.ok(first.season.flipAt > now.getTime(), "切换时刻必须在未来");
  assert.match(first.season.warning, /2027/, "缺次年必须在载荷里点名");
  assert.equal(first.season.warning,
    "节假日表缺少 2027 年的安排，工作日假期会被误判为峰价；可在用量监控设置里粘贴节假日覆盖表（已覆盖：2026）。");
  assert.ok(warnings.some((line) => /2027/.test(line)), "启动自检也要留一条日志：" + warnings.join(" | "));
  // 拆分只给 DeepSeek，其他供应商恒为 null（峰谷价只对 DeepSeek 成立）
  assert.deepEqual(first.suppliers.find((s) => s.id === "deepseek").seasonSplit,
    { peakTokens: 0, valleyTokens: 0, unknownTokens: 0 });
  assert.equal(first.suppliers.find((s) => s.id === "openrouter").seasonSplit, null);

  // 2) 合法覆盖表写入后立刻生效（热更新走 loader/volatile-update）。
  //    用「把今天标成放假日」做探针，并按今天在**内置表**里的客观身份推期望：
  //    工作日本来峰价 → 必须翻成谷价并报「节假日」；本来就放假（周末或内置节假日）→ 仍是谷价，
  //    但成因必须从原来的 weekend/内置 holiday 变成覆盖表命中的 holiday。
  const today = beijingDayKey(now);
  const builtinSaysHoliday = season.isBuiltinHoliday(today);
  const builtinDow = new Date(now.getTime() + 8 * 3600_000).getUTCDay();
  const builtinSaysWeekend = builtinDow === 0 || builtinDow === 6;
  const saves = await harness.call("/api/dsh-token-quota/settings", { holidays: [today] });
  assert.equal(saves.ok, true);
  const overridden = await harness.call("/api/dsh-token-quota/state");
  assert.equal(overridden.season.peak, false, `${today} 被标为放假日，不得再报峰价`);
  assert.equal(overridden.season.kind, "holiday", "覆盖表命中的那天成因必须是节假日");
  assert.equal(overridden.season.valleyReason, "holiday");
  assert.equal(overridden.season.warning, null, "用户自己贴了覆盖表就不再提示缺次年");
  assert.deepEqual(harness.settings.writes.at(-1).patch.holidays, [today]);
  if (!builtinSaysHoliday && !builtinSaysWeekend) {
    // 对照组不能假设「跑到这句时正好落在峰价窗口」（北京 19:00 跑必然失败）：
    // 改成同一瞬间的内置判定必须与 /state 一致，真处在峰价时再顺带钉住成因。
    assert.equal(first.season.peak, season.isPeak(now), "对照组：内置表对同一瞬间的峰谷结论必须与 /state 一致");
    if (first.season.peak) assert.equal(first.season.kind, "weekday");
  }

  // 3) 坏日期在写入前被拒绝，且不能污染已保存的配置
  const rejected = await harness.call("/api/dsh-token-quota/settings", { holidays: ["2027-02-30"] });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /非法日期/);
  const notArray = await harness.call("/api/dsh-token-quota/settings", { holidays: "2027-01-01" });
  assert.equal(notArray.ok, false);
  assert.deepEqual(harness.settings.userLayer.holidays, [today], "被拒绝的写入不得落盘");

  // 4) 配置被手工改坏时读取侧静默回落内置表，判定不消失
  harness.settings.userLayer.holidays = "not-an-array";
  const salvaged = await harness.call("/api/dsh-token-quota/state");
  assert.equal(salvaged.season.peak, first.season.peak, "坏配置回落到内置表，而不是让时段判定消失");
  assert.equal(salvaged.season.kind, first.season.kind);
});

test("today's usage carries the five-part breakdown and a seven-day history", async (t) => {
  const previousHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), "qm-split-"));
  process.env.DSH_HOME = home;
  const harness = createCtx({ schema: Config, config: { suppliers: { deepseek: { enabled: true, apiKey: "saved" } } } });
  const dispose = apply(harness.ctx, harness.configRef);
  t.after(() => {
    dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  // 走真实事件通道喂一条带齐四项分量的 usage（与 usage-saves.mjs 同一形状）
  harness.emit("session/event", { id: "s1" }, { type: "assistant/chunk", data: {
    provider: "deepseek-official", turn: 1, step: 1,
    chunk: { type: "usage", usage: {
      inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 50,
    } },
  } });
  const state = await harness.call("/api/dsh-token-quota/state");
  const deepseek = state.suppliers.find((s) => s.id === "deepseek");
  const split = deepseek.seasonSplit;
  assert.ok(deepseek.todayTokens > 0, "同一轮事件应已计入今日用量：" + deepseek.todayTokens);
  assert.equal(split.peakTokens + split.valleyTokens + split.unknownTokens, deepseek.todayTokens,
    "三段之和必须等于今日总量，不能因为拆分丢数");
  assert.deepEqual(deepseek.todayUsage, {
    inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 50, unsplitTokens: 0,
  }, "今日分布必须逐项等于事件里的互不相交分量");
  assert.equal(deepseek.todayUsage.inputTokens + deepseek.todayUsage.outputTokens + deepseek.todayUsage.cacheReadTokens
    + deepseek.todayUsage.cacheWriteTokens + deepseek.todayUsage.unsplitTokens, deepseek.todayTokens,
  "五项之和必须等于 todayTokens");
  assert.equal(state.poll.usageHistoryDays, 7, "默认保留期 7 天 → 历史窗口 7 天");
  assert.equal(deepseek.usageDays.length, 7, "历史窗口按天给满，包含没有记录的日子");
  assert.deepEqual(deepseek.usageDays.map((row) => row.day).slice().sort(), deepseek.usageDays.map((row) => row.day),
    "历史按日期升序");
  assert.equal(deepseek.usageDays.at(-1).day, dayLabelOf(new Date()), "最后一行必须是今天");
  assert.equal(deepseek.usageDays.at(-1).total, deepseek.todayTokens);
  assert.deepEqual(deepseek.usageDays.slice(0, -1).map((row) => row.total), [0, 0, 0, 0, 0, 0],
    "没有记录的日子保留 0 行（不伪造数据）");
  assert.equal(state.suppliers.find((s) => s.id === "openrouter").seasonSplit, null, "非 DeepSeek 供应商不挂拆分");
  assert.equal(state.suppliers.find((s) => s.id === "openrouter").usageDays.length, 7,
    "但每个供应商都有自己的分量历史");
  // 今天的桶落在今天：断言两个各自独立计算的数字确实对得上，而不是各算各的
  assert.equal(split.unknownTokens, 0, "今天的桶晚于峰谷定价实施日，不该落进未知段");

  // 保留期缩短 → 历史窗口跟着缩到 min(7, retention)，不展示已修剪之外的天数
  await harness.ctx.settings.update("dsh-token-quota", { retentionDays: 2 });
  const shrunk = await harness.call("/api/dsh-token-quota/state");
  assert.equal(shrunk.poll.usageHistoryDays, 2);
  assert.equal(shrunk.suppliers.find((s) => s.id === "deepseek").usageDays.length, 2);
  assert.equal(shrunk.suppliers.find((s) => s.id === "deepseek").usageDays.at(-1).total, deepseek.todayTokens);
});

test("quota history reaches /state only on demand, clipped to the usage window", async (t) => {
  const previousHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), "qm-quota-runtime-"));
  process.env.DSH_HOME = home;
  // 预置一份额度历史（等价于「插件已经跑过一段时间」）：窗口内 2 点 + 窗口外 1 点
  const dir = join(home, "dsh-token-quota");
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const day = 24 * 3600_000;
  writeFileSync(join(dir, "quota.json"), JSON.stringify({
    version: 1,
    suppliers: {
      deepseek: { "window.5h": [[now - 20 * day, 5], [now - 2 * day, 60], [now - 3600_000, 62]] },
      opencode: { "window.weekly": [[now - day, 10], [now - 60_000, 40]] },
    },
  }));

  const harness = createCtx({ schema: Config, config: { suppliers: { deepseek: { enabled: true, apiKey: "saved" } } } });
  const dispose = apply(harness.ctx, harness.configRef);
  t.after(() => {
    dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  // 默认不带：卡片轮询不背这份历史
  const plain = await harness.call("/api/dsh-token-quota/state");
  assert.equal(plain.suppliers.every((s) => s.quotaHistory === undefined), true,
    "不带 ?quota=1 时任何供应商都不回传额度历史");
  assert.equal(plain.poll.quotaHistoryDays, plain.poll.usageHistoryDays, "折线与柱共用同一条时间轴");

  const withQuota = await harness.call("/api/dsh-token-quota/state?quota=1");
  const deepseek = withQuota.suppliers.find((s) => s.id === "deepseek");
  const series = deepseek.quotaHistory["window.5h"];
  assert.deepEqual(series, [[now - 2 * day, 60], [now - 3600_000, 62]],
    "窗口外的点被裁掉，窗口内保持升序 [时刻, 已用百分比]");
  const opencode = withQuota.suppliers.find((s) => s.id === "opencode");
  assert.deepEqual(opencode.quotaHistory["window.weekly"], [[now - day, 10], [now - 60_000, 40]]);
  // 没有采样点的供应商不挂空对象：客户端据此判断「没有折线可画」
  assert.equal(withQuota.suppliers.find((s) => s.id === "openrouter").quotaHistory, undefined);

  // 保留期缩短 → 额度折线的窗口同步缩短（跟随 token 历史，而不是磁盘的 14 天）
  await harness.ctx.settings.update("dsh-token-quota", { retentionDays: 2 });
  const shrunk = await harness.call("/api/dsh-token-quota/state?quota=1");
  assert.equal(shrunk.poll.quotaHistoryDays, 2);
  assert.deepEqual(shrunk.suppliers.find((s) => s.id === "deepseek").quotaHistory["window.5h"],
    [[now - 2 * day, 60], [now - 3600_000, 62]],
    "窗口左缘多留一个切点之前的锚点，折线才能从边缘进入；更早的点仍然裁掉");
});

test("a successful query appends a quota sample, and an unchanged value does not", async (t) => {
  const previousHome = process.env.DSH_HOME;
  const previousFetch = globalThis.fetch;
  const home = mkdtempSync(join(tmpdir(), "qm-quota-sample-"));
  process.env.DSH_HOME = home;
  let percent = 12;
  // opencode 的 usage 端点替身：rolling/weekly/monthly 各给一个百分比
  globalThis.fetch = async (url) => {
    if (!String(url).includes("/zen/go/v1/usage")) return { ok: false, status: 401, text: async () => "" };
    return { ok: true, status: 200, text: async () => JSON.stringify({ usage: {
      rolling: { percent, resetsAt: new Date(Date.now() + 3600_000).toISOString() },
      weekly: { percent: percent + 10, resetsAt: new Date(Date.now() + 86400_000).toISOString() },
    } }) };
  };
  const harness = createCtx({ schema: Config, config: { suppliers: { opencode: { enabled: true, apiKey: "sk-test" } } } });
  const dispose = apply(harness.ctx, harness.configRef);
  t.after(() => {
    dispose();
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  await harness.call("/api/dsh-token-quota/refresh", {});
  const first = (await harness.call("/api/dsh-token-quota/state?quota=1")).suppliers.find((s) => s.id === "opencode");
  assert.deepEqual(first.quotaHistory["window.rolling"].map(([, pct]) => pct), [12],
    "查到的百分比按 key 落进历史");
  assert.deepEqual(first.quotaHistory["window.weekly"].map(([, pct]) => pct), [22]);

  // 值没变：不产生新点（额度在窗口内单调，重复点只是体积）
  await harness.call("/api/dsh-token-quota/refresh", {});
  const unchanged = (await harness.call("/api/dsh-token-quota/state?quota=1")).suppliers.find((s) => s.id === "opencode");
  assert.equal(unchanged.quotaHistory["window.rolling"].length, 1, "同一个百分比不重复记");

  // 值变了：追加一个点，且严格升序
  percent = 40;
  await harness.call("/api/dsh-token-quota/refresh", {});
  const grown = (await harness.call("/api/dsh-token-quota/state?quota=1")).suppliers.find((s) => s.id === "opencode");
  const series = grown.quotaHistory["window.rolling"];
  assert.deepEqual(series.map(([, pct]) => pct), [12, 40]);
  assert.ok(series[1][0] > series[0][0], "时刻严格升序");

  // 真正落盘：quota.json 与 usage.json 同目录，dispose 时同步冲刷
  dispose();
  const saved = JSON.parse(readFileSync(join(home, "dsh-token-quota", "quota.json"), "utf8"));
  assert.equal(saved.version, 1);
  assert.deepEqual(saved.suppliers.opencode["window.rolling"].map(([, pct]) => pct), [12, 40]);
});

test("a retried attempt adds to the same step instead of replacing it", async (t) => {
  const previousHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), "qm-retry-"));
  process.env.DSH_HOME = home;
  const harness = createCtx({ schema: Config, config: { suppliers: { deepseek: { enabled: true, apiKey: "saved" } } } });
  const dispose = apply(harness.ctx, harness.configRef);
  t.after(() => {
    dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  const usage = (inputTokens) => ({ type: "assistant/chunk", data: {
    provider: "deepseek-official", turn: 2, step: 1,
    chunk: { type: "usage", usage: { inputTokens } },
  } });
  harness.emit("session/event", { id: "s1" }, usage(100));
  harness.emit("llm/retry-started", { id: "s1" }, { type: "llm/retry-started", data: { turn: 2, step: 1 } });
  harness.emit("session/event", { id: "s1" }, usage(40));
  const state = await harness.call("/api/dsh-token-quota/state");
  const deepseek = state.suppliers.find((s) => s.id === "deepseek");
  assert.equal(deepseek.todayTokens, 140, "重试是另一次计费尝试：两次都计入，而不是后一次替换前一次");
  assert.equal(deepseek.todayUsage.inputTokens, 140);
});

test("凭据引用在宿主侧解析，密钥本体不进配置文档", async (t) => {
  const previousHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), "qm-key-ref-"));
  process.env.DSH_HOME = home;
  const seen = [];
  t.mock.method(PROVIDERS.deepseek, "query", async (cfg) => {
    seen.push(cfg.apiKey);
    return { state: "ok", entries: [], headline: { kind: "amt", amt: "¥0" } };
  });
  const harness = createCtx({
    schema: Config,
    config: { suppliers: { deepseek: { enabled: true, apiKeyEnv: "DEEPSEEK_API_KEY" } } },
    credentials: {
      resolve: async (ref) => (ref === "DEEPSEEK_API_KEY" ? { value: "ref-key", source: "credentials" } : null),
    },
  });
  const dispose = apply(harness.ctx, harness.configRef);
  t.after(() => {
    dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  const supplier = (payload) => payload.suppliers.find((s) => s.id === "deepseek");

  await harness.call("/api/dsh-token-quota/refresh", {});
  assert.equal(seen.at(-1), "ref-key", "配置里的凭据引用在宿主侧解析后用于查询");
  assert.equal(seen.includes(""), false, "引用解析完成前不得用空密钥打供应商接口");
  const byRef = supplier(await harness.call("/api/dsh-token-quota/state"));
  assert.equal(byRef.apiKeyEnv, "DEEPSEEK_API_KEY");
  assert.equal(byRef.keyRefResolved, true);
  assert.equal(byRef.keyRefSource, "credentials");
  assert.equal(byRef.keySet, false, "配置文档里没有密钥本体");
  assert.equal(byRef.added, true, "只有引用也算已添加");

  seen.length = 0;
  await harness.call("/api/dsh-token-quota/settings", { suppliers: { deepseek: { apiKey: "literal-key" } } });
  await harness.call("/api/dsh-token-quota/refresh", {});
  assert.equal(seen.at(-1), "literal-key", "配置里的密钥本体优先于引用");
});
