// test/smoke.mjs — 数据层冒烟测试（Mock fetch，无网络）
// 覆盖 Token-Consumption-Monitoring docs/query-coverage.md 移植的查询方法：
// DeepSeek 多币种余额、OpenRouter Key 额度/今日费用与 Management credits、
// Moonshot 国内/国际余额、Z.ai/智谱 Coding Plan 窗口、MiniMax Token Plan 窗口、
// OpenAI/Anthropic 组织 AdminKey 用量与费用、OpenCode/Command Code 兼容来源。
// 用法：node test/smoke.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROVIDERS, resetAtMs } from "../lib/providers.js";

let fetchCount = 0;
const JSON_HEAD = { ok: true, status: 200, text: async () => "" };

// 组织统计接口只接受「最近已完成的 UTC 日」时间桶 → 夹具按当前时间生成
const orgNow = new Date();
const orgEnd = new Date(orgNow); orgEnd.setUTCHours(0, 0, 0, 0);
const orgStart = new Date(orgEnd.getTime() - 24 * 3600_000);
const orgEpoch = (d) => Math.floor(d.getTime() / 1000);
const orgOpenAi = (rows, more = false, next = null) => ({
  data: [{ start_time: orgEpoch(orgStart), end_time: orgEpoch(orgEnd), results: rows }], has_more: more, next_page: next,
});
const orgClaude = (rows) => ({
  data: [{ starting_at: orgStart.toISOString(), ending_at: orgEnd.toISOString(), results: rows }],
});
// 智谱/Z.ai 的 nextResetTime（周窗口原始 epoch-毫秒，2026-10-12 实测值）
const ZAI_RESET = 1791781957965;

// 端点 → 响应体（URL 后缀匹配；同路径不同主机用数组形式分别命中）
const ROUTES = [
  // path, matcher(url), body
  ["/user/balance", (u) => true, { balance_infos: [
    { currency: "CNY", total_balance: "100.00", granted_balance: "20.00", topped_up_balance: "80.00" },
    { currency: "USD", total_balance: "12.50", granted_balance: "2.50", topped_up_balance: "10.00" },
  ] }],
  ["/zen/go/v1/usage", (u) => u.includes("opencode.ai"), {
    usage: {
      rolling: { status: "ok", percent: 72, resetsAt: "2025-08-26T10:00:00Z" },
      weekly: { status: "ok", percent: 85, resetsAt: "2025-08-28T00:00:00Z" },
      monthly: { status: "ok", percent: 41, resetsAt: "2025-08-31T16:00:00Z" },
    },
  }],
  ["/api/go/status", (u) => u.includes("opencode.ai"), { meters: [{ kind: "auto", resetsAt: "2025-09-01T00:00:00Z", limitMicroCents: 50_000_000, remainingMicroCents: 26_500_000 }] }],
  ["/api/v1/key", (u) => true, { data: { limit: 20, limit_remaining: 15, limit_reset: "monthly", usage: 10000, usage_daily: 2.5 } }],
  ["/api/v1/credits", (u) => true, { data: { total_credits: 100, total_usage: 30 } }],
  ["/v1/users/me/balance", (u) => u.includes("api.moonshot.cn"), { code: 0, status: true, data: { available_balance: 8.5 } }],
  ["/v1/users/me/balance", (u) => u.includes("api.moonshot.ai"), { code: 0, status: true, data: { available_balance: 42.25 } }],
  // Z.ai / 智谱实测载荷（2026-10-06）：用量桶已由 TOKENS_LIMIT 改名为 CREDIT_LIMIT，
  // 窗口身份由 unit 决定（3 = 5 小时窗口，6 = 周窗口），TIME_LIMIT 是月度 MCP 上限。
  ["/api/monitor/usage/quota/limit", (u) => true, { code: 200, msg: "Operation successful", success: true,
    data: { limits: [
      { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 2000, currentValue: 0, remaining: 2000, percentage: 0 },
      { type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 10000, currentValue: 1533, remaining: 8466, percentage: 15, nextResetTime: ZAI_RESET },
      { type: "TIME_LIMIT", unit: 5, number: 1, usage: 1000, currentValue: 0, remaining: 1000, percentage: 10, nextResetTime: ZAI_RESET },
      { type: "FUTURE_LIMIT", percentage: 99 },
    ], level: "lite" } }],
  ["/v1/token_plan/remains", (u) => true, { base_resp: { status_code: 0 }, model_remains: [
    { model_name: "general",
      current_interval_remaining_percent: 80, current_interval_usage_count: 900, current_interval_total_count: 1000,
      start_time: 1788825600000, end_time: 1788843600000,
      current_weekly_remaining_percent: 50, weekly_boost_permille: 1500,
      weekly_start_time: 1788739200000, weekly_end_time: 1789344000000 },
  ] }],
  ["/organization/usage/completions", (u) => true, orgOpenAi([
    { model: "gpt-5", input_tokens: 100, output_tokens: 32, input_cached_tokens: 85, num_model_requests: 2 },
  ])],
  ["/organization/costs", (u) => true, orgOpenAi([
    { amount: { value: 4, currency: "usd" } },
  ])],
  ["/organizations/usage_report/messages", (u) => true, orgClaude([
    { model: "claude-sonnet", uncached_input_tokens: 10, cache_read_input_tokens: 20,
      cache_creation: { ephemeral_1h_input_tokens: 30, ephemeral_5m_input_tokens: 40 }, output_tokens: 5 },
  ])],
  ["/organizations/cost_report", (u) => true, orgClaude([
    { amount: "123.78912", currency: "USD" },
  ])],
  ["/alpha/whoami", (u) => true, { org: { id: "org_1" } }],
  ["/alpha/billing/credits", (u) => true, {
    credits: { planId: "individual-pro", monthlyCredits: 12.5 },
    // 真实样本：窗口 resetAt 为 epoch-毫秒数字（上游夹具 FromUnixTimeMilliseconds 转录）；
    // weekly 用 ISO 字符串覆盖另一容忍路径
    windowLimits: {
      fiveHour: { used: 2.0, cap: 10.0, resetAt: Date.UTC(2025, 7, 26, 5) },
      weekly: { used: 8.5, cap: 30.0, resetAt: "2025-09-01T00:00:00Z" },
    },
  }],
  ["/alpha/billing/subscriptions", (u) => true, { data: { planId: "individual-pro", status: "active", currentPeriodStart: "2025-08-01T00:00:00Z", currentPeriodEnd: "2025-09-01T00:00:00Z" } }],
  ["/alpha/usage/summary", (u) => true, { totalCost: 17.5 }],
];

function installFetch() {
  fetchCount = 0;
  globalThis.fetch = async (url, opts) => {
    fetchCount += 1;
    const u = String(url);
    const hit = ROUTES.find(([path, match]) => u.includes(path) && match(u));
    if (!hit) return { ok: false, status: 404, text: async () => "not found" };
    return { ...JSON_HEAD, text: async () => JSON.stringify(hit[2]) };
  };
}

const cfg = (over = {}) => ({ apiKey: "sk-test", warnPct: 80, critPct: 95, ...over });

installFetch();

// 条目名与供应商名的「词典键 + 参数」必须与宿主发的旧文案逐字一致（双写期契约）：
// 这里按客户端字典独立实现一次替换来核对，两边各写一份实现正是要证明的事。
const clientSource = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const dictionaryOf = (lang, end) => {
  const from = clientSource.indexOf(`        ${lang}: {`, clientSource.indexOf("const LOCALES = {"));
  const to = end === "en" ? clientSource.indexOf("\n      };", from) : clientSource.indexOf("\n        en: {", from);
  return new Map([...clientSource.slice(from, to).matchAll(/^\s{10}(\w+):\s*"((?:[^"\\]|\\.)*)"/gm)].map((m) => [m[1], m[2]]));
};
const zhAtoms = dictionaryOf("zh");
const enAtoms = dictionaryOf("en", "en");
const composedZh = (spec) => {
  const template = spec?.atom ? zhAtoms.get(spec.atom) : undefined;
  if (!template) return null;
  let missing = false;
  const text = template.replace(/\{(\w+)\}/g, (whole, name) => {
    const value = spec.args?.[name];
    const resolved = value && typeof value === "object" ? composedZh(value) : value;
    if (resolved === undefined || resolved === null) { missing = true; return whole; }
    return String(resolved);
  });
  return missing ? null : text;
};
/** 每个带 nameSpec 的条目名，都必须等于客户端字典此刻会渲染出的文案。 */
const checkNames = (result, where = "") => {
  for (const entry of result?.entries || []) {
    if (!entry.nameSpec) continue;
    const composed = composedZh(entry.nameSpec);
    assert.ok(composed, `${where} 缺少词典键：${entry.nameSpec.atom}`);
    assert.equal(entry.name, composed, `${where} 词典文案与旧文案不一致：${entry.nameSpec.atom}`);
  }
};
const run = async (id, config = cfg()) => {
  const result = await PROVIDERS[id].query(config);
  checkNames(result, id);
  return result;
};
for (const [id, meta] of Object.entries(PROVIDERS)) {
  if (!meta.nameSpec) continue;
  assert.equal(meta.name, composedZh(meta.nameSpec), `供应商名与词典不一致：${id}`);
}

// 静态扫描：查询层发出的每个词典键都必须在两本词典里存在。没有夹具覆盖的供应商
// （例如只在真实账号下才出现的窗口）也不会带着一个坏键上线。
const hostSource = readFileSync(new URL("../lib/providers.js", import.meta.url), "utf8");
const atomsFromHost = new Set([
  ...[...hostSource.matchAll(/nameKey\("(\w+)"/g)].map((m) => m[1]),
  ...[...hostSource.matchAll(/atom: "(\w+)"/g)].map((m) => m[1]),
]);
// 说明与分解的原子写在两张表里（NOTES / PARTS），不是 nameKey 的字面量实参：
// 只扫 nameKey 会漏掉它们，于是「宿主的词表都在词典里」这条保证就只剩夹具兜底。
for (const table of ["NOTES", "PARTS"]) {
  const from = hostSource.indexOf(`const ${table} = {`);
  assert.ok(from > 0, `找不到 ${table} 原子表`);
  const block = hostSource.slice(from, hostSource.indexOf("\n};", from));
  for (const m of block.matchAll(/:\s*"(\w+)"/g)) atomsFromHost.add(m[1]);
}
assert.ok(atomsFromHost.size > 40, `扫描到的词典键太少（${atomsFromHost.size}），匹配失效了`);
for (const atom of atomsFromHost) {
  assert.ok(zhAtoms.has(atom), `宿主发出的词典键不在中文词典里：${atom}`);
  assert.ok(enAtoms.has(atom), `宿主发出的词典键不在英文词典里：${atom}`);
}

// DeepSeek：多币种余额
const ds = await run("deepseek", cfg());
assert.equal(ds.state, "ok");
assert.equal(ds.entries.length, 2, "多币种保留全部币种");
assert.equal(ds.headline.amt, "¥100.00 · $12.50");
assert.match(ds.entries[0].note, /到账/);
console.log("✓ deepseek 多币种余额:", ds.headline.amt);

// OpenRouter：普通 Key 周期额度 + 今日费用
const or = await run("openrouter", cfg());
const quota = or.entries.find((e) => e.name.includes("周期额度"));
assert.equal(quota.remain, "$15.00");
assert.equal(quota.used, "$5.00");
assert.equal(quota.pct, 25);
assert.equal(or.state, "ok");
const daily = or.entries.find((e) => e.name === "今日费用");
assert.equal(daily.used, "$2.50");
console.log("✓ openrouter Key 额度 + 今日费用:", quota.remain, "/", daily.used);

// OpenRouter：Management Key 账户 credits
const orAcc = await run("openrouter-account", cfg());
assert.equal(orAcc.entries[0].remain, "$70.00");
console.log("✓ openrouter-account credits:", orAcc.entries[0].remain);

// Moonshot 国内/国际：币种随地域
const msCn = await run("moonshot-cn", cfg());
assert.equal(msCn.entries[0].remain, "¥8.50");
const msIntl = await run("moonshot-intl", cfg());
assert.equal(msIntl.entries[0].remain, "$42.25");
console.log("✓ moonshot-cn ¥8.50 / moonshot-intl $42.25");

// Z.ai / 智谱：Coding Plan 窗口按 unit 分类（CREDIT_LIMIT 改名后的实测载荷）
const zai = await run("zai", cfg());
assert.equal(zai.entries.length, 3, "5 小时 / 周 / MCP 三个窗口");
assert.deepEqual(zai.entries.map((e) => e.name),
  ["Token 用量（5 小时）", "Token 用量（周）", "MCP 用量（月）"], "展示顺序固定，与数组位置无关");
assert.deepEqual(zai.entries.map((e) => e.pct), [0, 15, 10]);
assert.equal(zai.state, "ok");
assert.equal(zai.entries[1].resetAt, ZAI_RESET, "周窗口下发原始 epoch-毫秒重置时刻");
assert.match(zai.entries[1].reset, /重置$/);
assert.equal(zai.entries[0].resetAt, null, "未提供 nextResetTime 的窗口不伪造时刻");
assert.equal(zai.entries[0].reset, "—");
console.log("✓ zai Coding Plan 窗口:", zai.entries.map((e) => `${e.name}=${e.pct}%`).join(" | "));

// 滚动发布：旧拼写 TOKENS_LIMIT 与 CREDIT_LIMIT 混用仍按 unit 取值，不按数组位置
const zaiRoute = ROUTES.find(([p]) => p === "/api/monitor/usage/quota/limit");
zaiRoute[2].data.limits = [
  { type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 42, nextResetTime: ZAI_RESET },
  { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 7 },
];
const zaiCn = await run("zai-cn", cfg());
assert.equal(zaiCn.state, "ok");
assert.deepEqual(zaiCn.entries.map((e) => e.name), ["Token 用量（5 小时）", "Token 用量（周）"]);
assert.deepEqual(zaiCn.entries.map((e) => e.pct), [7, 42], "周窗口排在数组前面也不得串到 5 小时标签下");
console.log("✓ zai-cn 旧拼写 + 乱序:", zaiCn.entries.map((e) => `${e.name}=${e.pct}%`).join(" | "));

// MiniMax：Token Plan 窗口（显式剩余百分比取反为已用）
const mm = await run("minimax", cfg());
assert.equal(mm.entries.length, 2);
const cur = mm.entries.find((e) => e.name.includes("当前窗口"));
assert.equal(cur.pct, 20);
const wk = mm.entries.find((e) => e.name.includes("周窗口"));
assert.equal(wk.pct, 50);
assert.match(wk.note, /1.5×/);
console.log("✓ minimax Token Plan 窗口:", mm.entries.map((e) => `${e.name}=${e.pct}%`).join(" | "));

// OpenAI 组织：用量 + 费用（同供应商合并）
const oai = await run("openai-org", cfg());
assert.equal(oai.state, "ok");
assert.equal(oai.entries.filter((e) => e.kind === "usage").length, 2, "汇总 + 模型明细");
assert.equal(oai.entries.find((e) => e.name.includes("汇总")).used, "132");
assert.equal(oai.entries.find((e) => e.name.includes("gpt-5")).used, "132");
assert.ok(oai.entries.some((e) => e.kind === "cost" && e.used === "$4.00"));
console.log("✓ openai-org 用量(132 tokens)+费用($4.00):", oai.entries.map((e) => e.name).join(" | "));

// Anthropic 组织：缓存写入口径求和 + 美分转美元
const ant = await run("anthropic-org", cfg());
assert.equal(ant.state, "ok");
assert.equal(ant.entries.find((e) => e.name.includes("汇总")).used, "105");
assert.equal(ant.entries.find((e) => e.kind === "cost").used, "$1.24");
console.log("✓ anthropic-org 用量(105)+费用($1.24)");

// OpenCode：3 窗口 + allowance
const oc = await run("opencode", cfg({ allowanceToken: "oatok", orgId: "org-x" }));
assert.equal(oc.entries.length, 4);
assert.equal(oc.state, "warn");
assert.equal(oc.entries.find((e) => e.name.startsWith("allowance")).remain, "$26.50");
console.log("✓ opencode 窗口 + allowance:", oc.headline.pct);

// Command Code：窗口 + 月额度（保留兼容来源；重置时间补齐：epoch-ms / ISO / 诚实缺省）
const cc = await run("commandcode", cfg());
assert.equal(cc.entries.length, 3);
assert.equal(cc.state, "ok");
const monthly = cc.entries.find((e) => e.name.startsWith("月额度"));
assert.equal(monthly.remain, "$12.50");
for (const e of cc.entries) {
  assert.notEqual(e.reset, "—", `${e.name} 应带重置时间`);
  assert.match(e.reset, /重置$/);
  assert.equal(e.note.includes("未提供重置时刻"), false);
  // 原始时刻随条目下发（客户端据此算精确倒计时 *h*m / *d*h）；文案是四舍五入过的，时刻不是
  assert.ok(Number.isFinite(e.resetAt), `${e.name} 应带 epoch-毫秒 resetAt`);
}
assert.equal(cc.entries.find((e) => e.name.includes("5h")).resetAt, Date.UTC(2025, 7, 26, 5),
  "5h 窗口的 resetAt 应是原始 epoch-毫秒（不被 formatReset 的整小时取整影响）");
assert.ok(Number.isFinite(cc.headline.resetAt), "headline 也应镜像最紧条目的 resetAt");
assert.match(monthly.note, /订阅 active/);
console.log("✓ commandcode:", cc.entries.map((e) => `${e.name}:${e.pct}% (${e.reset})`).join(" | "));

// 窗口缺 resetAt 的真实缺省路径：如实标注「未提供重置时刻」，不伪造时刻
const ccRoute = ROUTES.find(([p]) => p === "/alpha/billing/credits");
ccRoute[2].windowLimits = { fiveHour: { used: 2.0, cap: 10.0 }, weekly: { used: 8.5, cap: 30.0 } };
const ccNoReset = await run("commandcode", cfg());
for (const e of ccNoReset.entries.filter((x) => x.kind === "win" && !x.name.startsWith("月额度"))) {
  assert.equal(e.reset, "—");
  assert.equal(e.note, "未提供重置时刻");
  assert.equal(e.resetAt, null, "没有时刻就是 null——不能伪造，客户端据此回落宿主文案");
}
console.log("✓ commandcode 缺 resetAt → 诚实标注:", ccNoReset.entries.filter((e) => e.name.startsWith("5h")).map((e) => `${e.name}:${e.note}`).join(" | "));

// 端点校验：非官方主机/非默认端口/路径越界 → 不发请求
for (const [id, badBase] of [
  ["deepseek", "https://api.deepseek.com.evil.invalid"],
  ["deepseek", "https://api.deepseek.com:8443"],
  ["moonshot-cn", "https://evil.invalid/v1"],
  ["openrouter", "https://openrouter.ai?secret=x"],
  ["zai", "https://api.z.ai/not-allowed"],
]) {
  const before = fetchCount;
  const bad = await run(id, cfg({ baseUrl: badBase }));
  assert.equal(bad.state, "err");
  assert.equal(bad.error.code, "endpoint", `${id} ${badBase} 应报 endpoint`);
  assert.equal(fetchCount, before, `${id} 地址越界时不得发起网络请求`);
}
console.log("✓ 官方主机/路径/端口/查询串校验（无网络请求）");

// 失败路径：401 → err/auth；未配置 Key → off
installFetch();
globalThis.fetch = async (url) => ({ ok: false, status: 401, text: async () => "" });
const dsBad = await run("deepseek", cfg());
assert.equal(dsBad.state, "err");
assert.equal(dsBad.error.code, "auth");
const dsOff = await run("deepseek", { apiKey: "" });
assert.equal(dsOff.state, "off");
console.log("✓ 401 → err/auth；无 Key → off");

// 格式化
import { formatBig, formatMoney } from "../lib/providers.js";
assert.equal(formatBig(1_234_567), "1.2M");
assert.equal(formatBig(999), "999");
assert.equal(formatMoney(12.5, "USD"), "$12.50");
assert.equal(formatMoney(88.4, "CNY"), "¥88.40");
console.log("✓ 格式化：1.2M / 999 / $12.50 / ¥88.40");

console.log("\n数据层冒烟测试全部通过 ✔");

// 占位时刻（上游用 0 表示「无重置时刻」）必须等价于「没给」，不能被当成 1970 年的合法时刻
assert.equal(resetAtMs(new Date(0)), null, "epoch 0 是占位，不是时刻");
assert.equal(resetAtMs(0), null);
assert.equal(resetAtMs(-1), null);
assert.equal(resetAtMs(Date.UTC(2025, 7, 26, 5)), Date.UTC(2025, 7, 26, 5));
console.log("✓ resetAtMs：占位/秒级值判为无时刻，真时刻原样通过");
