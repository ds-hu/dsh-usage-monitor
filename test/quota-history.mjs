// test/quota-history.mjs — 额度历史存储单元测试（真实临时目录，纯 fs）
// 用法：node test/quota-history.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  QUOTA_FILE_VERSION,
  QUOTA_MAX_SAMPLES,
  acquireQuotaStore,
  appendQuota,
  clipSamples,
  downsampleSamples,
  mergeQuota,
  normalizeQuota,
  pruneQuota,
  readQuotaFile,
} from "../lib/quota-history.js";

const dir = mkdtempSync(join(tmpdir(), "qm-quota-"));
const file = join(dir, "quota.json");
const cleanup = () => rmSync(dir, { recursive: true, force: true });

const entry = (pct, key = "window.5h") => ({ key, pct });
const T = 1_760_000_000_000; // 固定基准时刻（2025-10），避免用例随真实时钟漂移

try {
  // ---- 变化采样：同一个值不重复记 ----
  {
    const quota = {};
    assert.equal(appendQuota(quota, "opencode", [entry(40)], T), 1, "首次见到的值要记");
    assert.equal(appendQuota(quota, "opencode", [entry(40)], T + 60_000), 0, "值没变不产生新点");
    assert.equal(appendQuota(quota, "opencode", [entry(41)], T + 120_000), 1, "值变了要记");
    assert.deepEqual(quota.opencode["window.5h"], [[T, 40], [T + 120_000, 41]]);
    // 同一毫秒的重复写入顺延 1ms，保证严格升序（合并与降采样的前提）
    appendQuota(quota, "opencode", [entry(42)], T + 120_000);
    assert.deepEqual(quota.opencode["window.5h"].at(-1), [T + 120_001, 42]);
  }

  // ---- 只认带 key 且有合法 pct 的条目：余额类没有百分比，不进折线 ----
  {
    const quota = {};
    const skipped = appendQuota(quota, "deepseek", [
      { key: "balance.usd", remain: "$3.20", pct: null },
      { key: "balance.cny", remain: "¥41.99" },
      { key: "balance.eur", remain: "€1" , pct: "" },
      { pct: 50 },                       // 没有 key
      { key: "window.weekly", pct: NaN },
      { key: "window.weekly", pct: 120 }, // 超出 0–100
      { key: "window.weekly", pct: -1 },
    ], T);
    assert.equal(skipped, 0);
    assert.equal(quota.deepseek, undefined, "没有一条合法条目时不留空壳");
    // 数值字符串容忍：上游偶尔把百分比序列化成字符串，不必因此丢一整段历史
    assert.equal(appendQuota(quota, "deepseek", [{ key: "window.weekly", pct: "50" }], T), 1);
    assert.deepEqual(quota.deepseek["window.weekly"], [[T, 50]]);
  }

  // ---- 非法 key 与原型污染键一律拒绝 ----
  {
    const quota = {};
    assert.equal(appendQuota(quota, "opencode", [
      entry(10, "__proto__"), entry(10, "constructor"), entry(10, "有中文"), entry(10, "window 5h"),
    ], T), 0);
    assert.deepEqual(Object.keys(quota), []);
  }

  // ---- 单指标上限：超出后丢弃最旧的 ----
  {
    const quota = {};
    for (let i = 0; i <= QUOTA_MAX_SAMPLES + 5; i++) appendQuota(quota, "opencode", [entry(i % 100)], T + i * 1000);
    const samples = quota.opencode["window.5h"];
    assert.equal(samples.length, QUOTA_MAX_SAMPLES, "样本数被截到上限");
    assert.ok(samples.at(-1)[0] > T + QUOTA_MAX_SAMPLES * 1000, "保留的是近期形状");
  }

  // ---- 合并是幂等的并集（跨进程重复合并不会翻倍） ----
  {
    const a = { opencode: { "window.5h": [[T, 10], [T + 1000, 20]] } };
    const b = { opencode: { "window.5h": [[T + 1000, 20], [T + 2000, 30]] }, other: { "x.y": [[T, 5]] } };
    const once = mergeQuota(a, b);
    assert.deepEqual(once.opencode["window.5h"], [[T, 10], [T + 1000, 20], [T + 2000, 30]]);
    assert.deepEqual(once.other["x.y"], [[T, 5]]);
    const twice = mergeQuota(once, b);
    assert.deepEqual(twice, once, "同一份数据合并两次结果不变");
  }

  // ---- 保留期修剪 ----
  {
    const day = 24 * 3600_000;
    const quota = { opencode: { "window.5h": [[T - 20 * day, 10], [T - 2 * day, 20], [T, 30]] } };
    const trimmed = pruneQuota(quota, 14, T + day);
    assert.deepEqual(trimmed.opencode["window.5h"], [[T - 2 * day, 20], [T, 30]]);
    assert.deepEqual(pruneQuota(quota, 14, T + 30 * day), {}, "全部过期后连供应商一起移除");
  }

  // ---- 窗口裁剪：多留一个切点之前的点，折线才能从左缘进入 ----
  {
    const samples = [[T, 10], [T + 1000, 20], [T + 2000, 30]];
    assert.deepEqual(clipSamples(samples, T + 2000), [[T + 1000, 20], [T + 2000, 30]]);
    assert.deepEqual(clipSamples(samples, T - 5000), samples, "窗口早于全部数据时原样返回");
    assert.deepEqual(clipSamples(samples, T + 99_999), [], "窗口晚于全部数据时为空");
  }

  // ---- 降采样：保住首尾与重置落差 ----
  {
    // 200 个缓升点 + 一次重置（骤降）后再缓升
    const samples = [];
    for (let i = 0; i < 200; i++) samples.push([T + i * 60_000, i * 0.4]);
    for (let i = 0; i < 200; i++) samples.push([T + (200 + i) * 60_000, i * 0.4]);
    const thin = downsampleSamples(samples, 40);
    assert.ok(thin.length <= 80, "点数被压到上限内：" + thin.length);
    assert.deepEqual(thin[0], samples[0], "首点保留");
    assert.deepEqual(thin.at(-1), samples.at(-1), "末点保留");
    // 重置前后各有一个点落在相邻采样点上：落差仍可见
    const drops = thin.filter((point, i) => i > 0 && point[1] < thin[i - 1][1]);
    assert.equal(drops.length, 1, "降采样后仍只保留这一次重置");
    assert.ok(downsampleSamples(samples.slice(0, 10), 40).length === 10, "点数未超上限时不改动");
  }

  // ---- 读取：缺失 / 版本不符 / 坏点 ----
  {
    assert.equal(readQuotaFile(join(dir, "nope.json")).status, "missing");
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ version: 99, suppliers: { opencode: {} } }));
    const invalid = readQuotaFile(bad);
    assert.equal(invalid.status, "invalid");
    assert.deepEqual(invalid.quota, {});
    assert.match(invalid.error, /不受支持/);
    // 版本不符时原文件必须保留，绝不被后续写入覆盖成空
    assert.equal(JSON.parse(readFileSync(bad, "utf8")).version, 99);

    // 坏点被丢弃：非数组、时间非法、pct 越界、时间倒序
    const messy = join(dir, "messy.json");
    writeFileSync(messy, JSON.stringify({
      version: QUOTA_FILE_VERSION,
      suppliers: { opencode: { "window.5h": [[T, 10], [T + 1000, 20], "x", [T + 500, 30], [T + 2000, 200], [0, 5]] } },
    }));
    assert.deepEqual(readQuotaFile(messy).quota.opencode["window.5h"], [[T, 10], [T + 1000, 20]]);
  }

  // ---- 归一化：非法 id/key 不落进内存 ----
  {
    const normalized = normalizeQuota({ __proto__: { a: [[T, 1]] }, opencode: { "window.5h": [[T, 1]], "bad key": [[T, 2]] } });
    assert.deepEqual(Object.keys(normalized), ["opencode"]);
    assert.deepEqual(Object.keys(normalized.opencode), ["window.5h"]);
  }

  // ---- 存储：记录 → 冲刷 → 再读回；锁文件不残留 ----
  // 存储按 Date.now() 修剪保留期，因此这一段用相对当前时刻的时间戳（纯函数段用固定 T）。
  {
    const base = Date.now() - 3600_000;
    const store = acquireQuotaStore(file, 14);
    assert.equal(store.record("opencode", [entry(30), entry(0, "window.weekly")], base), 2);
    assert.equal(store.record("opencode", [entry(30)], base + 60_000), 0, "无变化不置脏");
    const flushed = store.flush();
    assert.equal(flushed.ok, true);
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(onDisk.version, QUOTA_FILE_VERSION);
    assert.deepEqual(onDisk.suppliers.opencode["window.5h"], [[base, 30]]);
    store.release();
    assert.throws(() => readFileSync(`${file}.lock`, "utf8"), "短写锁已释放");

    // 另一个进程（这里用直接改文件模拟）写入的点，下一次冲刷会并集合并保留
    const external = JSON.parse(readFileSync(file, "utf8"));
    external.suppliers.opencode["window.5h"].push([base + 5000, 55]);
    writeFileSync(file, JSON.stringify(external));
    const again = acquireQuotaStore(file, 14);
    again.record("opencode", [entry(60)], base + 10_000);
    assert.equal(again.flush().ok, true);
    const merged = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(merged.suppliers.opencode["window.5h"], [[base, 30], [base + 5000, 55], [base + 10_000, 60]]);
    again.release();
  }

  // ---- 存储：损坏文件报错但不抛出，且不覆盖原文件 ----
  {
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{not json");
    const store = acquireQuotaStore(broken, 14);
    assert.match(store.store.error, /读取失败/);
    const result = store.flush();
    assert.equal(result.ok, false, "脏数据写不进去时要如实失败");
    assert.equal(readFileSync(broken, "utf8"), "{not json", "原文件保持原样");
    store.release();
  }

  console.log("quota-history: 全部通过");
} finally {
  cleanup();
}
