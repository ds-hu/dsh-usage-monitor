// lib/storage.js — 本地用量数据（供应商 × 小时桶，落盘到 DSH 数据目录）
// 文件：<DSH_HOME>/dsh-token-quota/usage.json（DSH_HOME 缺省为 ~/.dsh，与 DSH 自身
// dsh-home-paths 的解析规则一致：$DSH_HOME 优先，空白视为未设置）
// 结构：{ version: 2, savedAt, buckets: { supplierId: { "YYYYMMDDHH": breakdown } } }
//   breakdown 为稀疏对象，字段取自 DSH TokenUsage 的互不相交口径：
//     inputTokens（未缓存输入）、outputTokens、cacheReadTokens、cacheWriteTokens，
//     以及承接旧数据的 unsplitTokens（版本 1 的总数，无法拆分）。
// 语义：
//   - 同一 (turn, step) 的 usage 样本是替换关系，折叠发生在宿主内存；
//     这里只负责「小时桶按分量求和」的持久化与 保留期 修剪（小时桶 key 过期即删）。
//   - 版本 1 的数字小时桶在读入时归一为 { unsplitTokens }：不猜分布、不丢总量；
//     下一次真正落盘时整体写成版本 2。旧版插件读到版本 2 会判为不支持并保留原文件。
//   - 原子写：先写同目录 tmp 再 rename，崩溃不留下半截 JSON。

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { tierOfHour } from "./season.js";

export const USAGE_FILE_VERSION = 2;

/** 小时桶的五个分量（固定顺序；展示与合并都按它遍历）。 */
export const USAGE_COMPONENTS = Object.freeze([
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "unsplitTokens",
]);

/** DSH 数据根目录：$DSH_HOME（非空白）优先，否则 ~/.dsh。 */
export function dshHome() {
  const env = process.env.DSH_HOME;
  return env && env.trim() ? resolve(env.trim()) : resolve(join(homedir(), ".dsh"));
}

/** 本插件用量数据目录名（v1.1.2 起；改名前的目录名见 LEGACY_DIR_NAME）。 */
export const USAGE_DIR_NAME = "dsh-token-quota";
/** 改名前（≤ v1.1.1）的用量数据目录名，仅用于一次性迁移。 */
export const LEGACY_DIR_NAME = "quota-monitor";

/** 本插件用量数据文件绝对路径。 */
export function usageFilePath(home, dirName = USAGE_DIR_NAME) {
  return join(home || dshHome(), dirName, "usage.json");
}

/** 额度历史文件：与用量文件同目录的兄弟文件（目录迁移只搬目录，文件名与本函数无关）。 */
export function quotaFilePath(usageFile) {
  return join(dirname(resolve(usageFile)), "quota.json");
}

/**
 * 旧目录 → 新目录的一次性迁移（插件改名 dsh-usage-monitor → dsh-token-quota）。
 *
 * 只在「旧目录存在且目标文件不存在」时搬一次。目标目录必须**不存在**才能 rename：
 * Windows 的 rename 在目标目录已存在时直接失败（EPERM/EEXIST），POSIX 在目标目录为空时
 * 会嵌套成 dsh-token-quota/quota-monitor/、非空时报 ENOTEMPTY —— 两条路径都不允许预先
 * 创建目标目录。父目录因旧目录存在而必然已存在，无需也无法代建。
 *
 * 搬不动（跨设备 EXDEV、权限 EPERM/EACCES、被占用 EBUSY）不抛错、不删旧数据：回落旧路径
 * 继续读，下次启动再试。目标目录存在但不含 usage.json、旧目录仍有文件时同样回落旧路径，
 * 不合并、不覆盖，并用 status 标明原因供诊断。
 *
 * @returns {{ path: string, status: "migrated"|"kept-new"|"fallback-legacy"|"none", error?: string }}
 *   path 为迁移后应使用的 usage.json 绝对路径；status/error 仅用于运行时诊断与测试断言。
 */
export function migrateUsageDir(home) {
  const root = home || dshHome();
  const next = usageFilePath(root);
  const legacy = usageFilePath(root, LEGACY_DIR_NAME);
  if (existsSync(next)) return { path: next, status: "kept-new" };
  if (!existsSync(join(root, LEGACY_DIR_NAME))) return { path: next, status: "none" };
  // 目标目录存在但里面没有 usage.json：这是无法判断归属的第三方残留。既不能 rename 进去
  // （POSIX 会嵌套、Windows 会 EPERM），也不合并、不覆盖 —— 回落旧路径读并留诊断原因。
  if (existsSync(join(root, USAGE_DIR_NAME))) {
    return { path: legacy, status: "fallback-legacy", error: "target-dir-exists" };
  }
  try {
    renameSync(join(root, LEGACY_DIR_NAME), join(root, USAGE_DIR_NAME));
    return { path: next, status: "migrated" };
  } catch (error) {
    return { path: legacy, status: "fallback-legacy", error: error?.code || error?.message || String(error) };
  }
}

/** 小时桶 key：本地时区的 YYYYMMDDHH。 */
export function hourKeyOf(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}${p(date.getHours())}`;
}

/** 自然日 key：YYYYMMDD（本地时区）。 */
export function dayKeyOf(date = new Date()) {
  return hourKeyOf(date).slice(0, 8);
}

/** 自然日展示 key：YYYY-MM-DD（本地时区）。 */
export function dayLabelOf(date = new Date()) {
  const key = dayKeyOf(date);
  return `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`;
}

/** 有限、正数、取整；其它（含数字字符串）按 0。 */
function positiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 小时桶值 → 五项全量对象。
 *
 * 接受两种历史形状：
 *   - 版本 1 的数字（或数值字符串）：总量无法拆分，记入 unsplitTokens；
 *   - 版本 2 的对象：缺省/非法/负数项按 0。
 * 总是返回完整五项（便于求和），不返回 null；调用方用 totalOf 判断是否为空。
 */
export function breakdownOf(value) {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      unsplitTokens: positiveInt(value),
    };
  }
  return {
    inputTokens: positiveInt(value.inputTokens),
    outputTokens: positiveInt(value.outputTokens),
    cacheReadTokens: positiveInt(value.cacheReadTokens),
    cacheWriteTokens: positiveInt(value.cacheWriteTokens),
    unsplitTokens: positiveInt(value.unsplitTokens),
  };
}

/** 五项之和（非负整数）。标量按「未细分的总量」解释，兼容版本 1。 */
export function totalOf(value) {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return positiveInt(value);
  }
  let total = 0;
  for (const key of USAGE_COMPONENTS) total += positiveInt(value[key]);
  return total;
}

/** 只保留非零分量（落盘用），全 0 时返回 {}。 */
export function compactBreakdown(breakdown) {
  const compact = {};
  for (const key of USAGE_COMPONENTS) {
    const n = positiveInt(breakdown?.[key]);
    if (n) compact[key] = n;
  }
  return compact;
}

/** 就地逐项累加（设计为总是增加，调用方只在 total > 0 时调用）。 */
export function addBreakdown(target, breakdown) {
  for (const key of USAGE_COMPONENTS) {
    const n = positiveInt(breakdown?.[key]);
    if (n) target[key] = positiveInt(target[key]) + n;
  }
  return target;
}

/** 就地逐项扣减、逐项 clamp ≥0（替换语义用）；返回是否至少扣掉了一项。 */
export function subtractBreakdown(target, breakdown) {
  let changed = false;
  for (const key of USAGE_COMPONENTS) {
    const n = positiveInt(breakdown?.[key]);
    const before = positiveInt(target?.[key]);
    if (!n || !before) continue;
    const next = Math.max(0, before - n);
    if (next) target[key] = next;
    else delete target[key];
    changed = true;
  }
  return changed;
}

/**
 * 某供应商在本地自然日内的分量与总量：只读当天 24 个小时桶键（最多 24 次键查询），
 * 每个键只读一次；旧数据（版本 1 数字）计入 unsplitTokens。
 *
 * @returns {{ inputTokens: number, outputTokens: number, cacheReadTokens: number,
 *   cacheWriteTokens: number, unsplitTokens: number, total: number }}
 */
export function scanDay(hours, date = new Date()) {
  const scan = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    unsplitTokens: 0,
    total: 0,
  };
  if (!hours || typeof hours !== "object") return scan;
  const day = dayKeyOf(date);
  for (let hour = 0; hour < 24; hour++) {
    const breakdown = breakdownOf(hours[`${day}${String(hour).padStart(2, "0")}`]);
    const total = totalOf(breakdown);
    if (!total) continue;
    for (const key of USAGE_COMPONENTS) scan[key] += breakdown[key];
    scan.total += total;
  }
  return scan;
}

/**
 * 某供应商在本地自然日内的用量总和。
 *
 * 保持既有返回约定：总量 > 0 返回数值，否则 null（无桶、空桶、全是 0/非法值都算「无用量」）。
 * 不缓存、不设午夜定时器：跨日与保留期修剪都由调用方传入的 buckets 现状决定。
 */
export function sumDayTokens(hours, date = new Date()) {
  const total = scanDay(hours, date).total;
  return total > 0 ? total : null;
}

/**
 * 某供应商在本地自然日内的用量按计费时段拆分。
 *
 * 为什么能纯读推导：峰谷边界全在整点、北京是整小时偏移，因此一个本地小时桶整体落在同一时段内，
 * 不需要在存储里记录时段标签，也就不必变更 usage.json 的结构与版本。
 *
 * 与 sumDayTokens 的口径关系：`peak + valley + unknown` 恒等于同一组桶的有效总量；
 * `unknown` 收纳早于峰谷生效分界线的旧桶与非法 key，绝不把它们并进峰或谷。
 *
 * @returns {{ peakTokens: number, valleyTokens: number, unknownTokens: number }}
 */
export function splitDayTokens(hours, date = new Date(), holidays = null) {
  const out = { peakTokens: 0, valleyTokens: 0, unknownTokens: 0 };
  if (!hours || typeof hours !== "object") return out;
  const day = dayKeyOf(date);
  for (let hour = 0; hour < 24; hour++) {
    const key = `${day}${String(hour).padStart(2, "0")}`;
    const tokens = totalOf(breakdownOf(hours[key]));
    if (!tokens) continue;
    const tier = tierOfHour(hourTimeMs(key), holidays);
    if (tier === "peak") out.peakTokens += tokens;
    else if (tier === "valley") out.valleyTokens += tokens;
    else out.unknownTokens += tokens;
  }
  return out;
}

/**
 * 最近 N 个本地自然日的分量与总量（升序，最后一行是今天）。
 *
 * 日边界按本地日历日回退（new Date(y, m, d - offset)），不用 24h 毫秒减法 ——
 * 后者在夏令时切换日会跨错一天。没有记录的日子保留全 0 行，调用方才能画出稳定的时间轴。
 * 每天只读当天 24 个小时键。
 */
export function dayUsageHistory(hours, days = 7, now = new Date()) {
  const count = Math.max(1, Math.floor(Number(days)) || 1);
  const history = [];
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let offset = count - 1; offset >= 0; offset--) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
    history.push({ day: dayLabelOf(date), ...scanDay(hours, date) });
  }
  return history;
}

/** 把小时桶 key 解析为本地时间戳；非法 key 返回 0（修剪时直接丢弃）。 */
export function hourTimeMs(key) {
  if (typeof key !== "string" || !/^\d{10}$/.test(key)) return 0;
  const d = new Date(
    Number(key.slice(0, 4)),
    Number(key.slice(4, 6)) - 1,
    Number(key.slice(6, 8)),
    Number(key.slice(8, 10)),
    0,
    0,
    0,
  );
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

/**
 * 归一化整份桶表：丢弃非法/零值小时桶，版本 1 数字转成 unsplitTokens。
 * 不按时间修剪（保留期由 pruneBuckets 负责），也不修改入参。
 */
export function normalizeBuckets(buckets) {
  const normalized = {};
  for (const [id, hours] of Object.entries(buckets || {})) {
    if (!hours || typeof hours !== "object") continue;
    const kept = {};
    for (const [key, value] of Object.entries(hours)) {
      const compact = compactBreakdown(breakdownOf(value));
      if (Object.keys(compact).length) kept[key] = compact;
    }
    if (Object.keys(kept).length) normalized[id] = kept;
  }
  return normalized;
}

/** 按保留期修剪小时桶（默认 7 天）；只保留 >0 的合法桶。返回新对象，不修改入参。 */
export function pruneBuckets(buckets, retentionDays = 7, now = new Date()) {
  const days = Math.max(1, Number(retentionDays) || 7);
  const cutoff = now.getTime() - days * 24 * 3600_000;
  const out = {};
  for (const [id, hours] of Object.entries(buckets || {})) {
    if (!hours || typeof hours !== "object") continue;
    const kept = {};
    for (const [key, value] of Object.entries(hours)) {
      const compact = compactBreakdown(breakdownOf(value));
      if (Object.keys(compact).length && hourTimeMs(key) >= cutoff) kept[key] = compact;
    }
    if (Object.keys(kept).length) out[id] = kept;
  }
  return out;
}

/** 载入用量文件；缺失/损坏/版本不符一律视为空（不影响插件运行）。 */
export function loadUsageFile(file) {
  return readUsageFile(file).buckets;
}

/**
 * 读取用量文件并归一化。
 *
 * 接受版本 1（数字总量 → unsplitTokens）与版本 2（分量对象）；其它版本按不支持处理，
 * 原文件保留。返回值里的 version 供宿主记录「下次保存升级」的一次性说明。
 */
export function readUsageFile(file) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    const version = data?.version;
    if ((version !== 1 && version !== USAGE_FILE_VERSION) || !data.buckets || typeof data.buckets !== "object") {
      return { status: "invalid", version: null, buckets: {}, error: "用量文件格式或版本不受支持，已保留原文件" };
    }
    return { status: "ok", version, buckets: normalizeBuckets(data.buckets) };
  } catch (error) {
    return error.code === "ENOENT" ? { status: "missing", version: null, buckets: {} }
      : { status: "invalid", version: null, buckets: {}, error: `用量文件读取失败，已保留原文件：${error.message}` };
  }
}

/** 原子落盘（修剪后写入）；返回 { ok } 或 { ok:false, error }。 */
export function saveUsageFile(file, buckets, retentionDays = 7) {
  return writeUsageSnapshot(file, pruneBuckets(buckets, retentionDays));
}

function writeUsageSnapshot(file, buckets) {
  let tmp;
  try {
    mkdirSync(dirname(file), { recursive: true });
    tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({ version: USAGE_FILE_VERSION, savedAt: new Date().toISOString(), buckets }, null, 2),
      "utf8",
    );
    renameSync(tmp, file);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  } finally {
    if (tmp) { try { unlinkSync(tmp); } catch { /* 已重命名或删除。 */ } }
  }
}

const stores = new Map();

/** 同进程共享桶；跨进程持有短写锁后按增量合并，避免旧快照覆盖。 */
export function acquireUsageStore(file, retentionDays = 7) {
  file = resolve(file);
  let store = stores.get(file);
  if (!store) {
    const loaded = readUsageFile(file);
    const buckets = pruneBuckets(loaded.buckets, retentionDays);
    store = { buckets, baseline: structuredClone(buckets), clients: new Map(),
      dirty: false, error: loaded.error || null, recordUsage: null, loadedVersion: loaded.version ?? null };
    stores.set(file, store);
  }
  const token = Symbol();
  store.clients.set(token, retentionDays);
  function flush({ waitForLockMs = 0 } = {}) {
    if (!store.dirty) return { ok: !store.error, error: store.error };
    let lock;
    const lockFile = `${file}.lock`;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const deadline = Date.now() + waitForLockMs;
      for (;;) {
        try { lock = openSync(lockFile, "wx"); break; }
        catch (error) {
          if (error.code !== "EEXIST" || Date.now() >= deadline) throw error;
          // 仅退出冲刷等待短写锁；运行期间失败后由宿主定时重试。
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      const latest = readUsageFile(file);
      if (latest.status === "invalid") throw new Error(latest.error);
      const days = store.clients.size ? Math.max(...store.clients.values()) : retentionDays;
      const cutoff = Date.now() - days * 24 * 3600_000;
      const merged = pruneBuckets(latest.buckets, days);
      for (const id of new Set([...Object.keys(store.buckets), ...Object.keys(store.baseline)])) {
        const local = store.buckets[id] || {}, base = store.baseline[id] || {};
        let hours = merged[id];
        for (const hour of new Set([...Object.keys(local), ...Object.keys(base)])) {
          if (hourTimeMs(hour) < cutoff) continue;
          const localBreakdown = breakdownOf(local[hour] || {});
          const baseBreakdown = breakdownOf(base[hour] || {});
          let bucket = hours?.[hour];
          for (const key of USAGE_COMPONENTS) {
            const delta = positiveInt(localBreakdown[key]) - positiveInt(baseBreakdown[key]);
            if (!delta) continue;
            if (!hours) hours = merged[id] = {};
            if (!bucket) bucket = hours[hour] = {};
            const next = Math.max(0, positiveInt(bucket[key]) + delta);
            if (next) bucket[key] = next;
            else delete bucket[key];
          }
          if (bucket && !Object.keys(bucket).length) delete hours[hour];
        }
        if (hours && !Object.keys(hours).length) delete merged[id];
      }
      const result = writeUsageSnapshot(file, merged);
      if (!result.ok) throw new Error(result.error);
      for (const id of Object.keys(store.buckets)) delete store.buckets[id];
      Object.assign(store.buckets, merged);
      store.baseline = structuredClone(merged);
      store.dirty = false;
      store.error = null;
      return { ok: true };
    } catch (error) {
      store.error = error.code === "EEXIST" ? "用量文件正在写入或存在遗留锁，稍后重试" : error.message;
      return { ok: false, error: store.error };
    } finally {
      if (lock !== undefined) { closeSync(lock); try { unlinkSync(lockFile); } catch { /* 保留错误供下次写入报告。 */ } }
    }
  }
  let released = false;
  return {
    store, flush,
    markDirty() { store.dirty = true; },
    setRetention(days) {
      if (store.clients.get(token) !== days) store.dirty = true;
      store.clients.set(token, days);
    },
    release() {
      if (released) return { ok: true };
      const result = flush({ waitForLockMs: 2000 });
      released = true;
      store.clients.delete(token);
      if (!store.clients.size) stores.delete(file);
      return result;
    },
  };
}
