// 额度历史：按 供应商 × 指标 key 记录「已用百分比」的变化点，供统计页画剩余额度折线。
//
// 为什么记 pct 而不是「剩余」：供应商给的是已用百分比，剩余 = 100 − pct 是纯派生，
// 存 pct 既无损又能直接看出「窗口内只增不减」这条不变量 —— 一旦变小就是换了新窗口，
// 折线在此断开，不需要额外存 resetAt 也能画出锯齿。
//
// 为什么按变化采样而不是每次轮询都记：额度在一个窗口内单调，值没变的点只占体积、
// 不增加信息。一次 5 小时窗口通常只有几十个变化点，14 天也远到不了上限。
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export const QUOTA_FILE_VERSION = 1;

/** 磁盘保留期：比 token 用量长，才能看出周期规律（两周 = 完整的两个周窗口）。 */
export const QUOTA_RETENTION_DAYS = 14;

/** 单个指标最多保留的变化点；超出后丢弃最旧的（保住近期形状）。 */
export const QUOTA_MAX_SAMPLES = 600;

/** 传输降采样上限：折线在屏幕上不过几百像素，再多的点只是流量。 */
export const QUOTA_SEND_POINTS = 120;

const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);
/** 指标 key 由 lib/providers.js 生成（window.5h / allowance.daily 这类），只允许安全字符。 */
const SAFE_KEY = /^[A-Za-z0-9_.:-]{1,64}$/;
/** 合法时刻下界（2001-09 之后的 epoch-毫秒），与用量数据同口径。 */
const MIN_TIME_MS = 1e12;

const isTime = (value) => Number.isFinite(value) && value >= MIN_TIME_MS;

/**
 * 归一百分比：null / undefined / 空串一律视为「没有值」，返回 NaN。
 * 不能直接 Number()：Number(null) === 0、Number("") === 0，余额类条目会被记成
 * 0% 的假点，折线上凭空出现一条贴着 100% 剩余的水平线。
 */
const toPct = (value) => {
  if (value === null || value === undefined || value === "") return NaN;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : NaN;
};
const isPct = (value) => !Number.isNaN(toPct(value));

/**
 * 归一一条采样序列：只留 [t, pct] 且严格升序的合法点。
 * 严格升序是合并与降采样的前提，坏点直接丢弃而不是猜测修复。
 */
function normalizeSamples(value) {
  const raw = Array.isArray(value) ? value : [];
  const samples = [];
  let lastT = -Infinity;
  for (const pair of raw) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const t = Number(pair[0]), pct = toPct(pair[1]);
    if (!isTime(t) || Number.isNaN(pct) || t <= lastT) continue;
    samples.push([t, pct]);
    lastT = t;
  }
  return samples;
}

/** 归一整个文件内容：{ id: { key: [[t, pct], ...] } }，空序列不保留。 */
export function normalizeQuota(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, metrics] of Object.entries(raw)) {
    if (FORBIDDEN.has(id) || !metrics || typeof metrics !== "object") continue;
    for (const [key, samples] of Object.entries(metrics)) {
      if (FORBIDDEN.has(key) || !SAFE_KEY.test(key)) continue;
      const clean = normalizeSamples(samples);
      if (!clean.length) continue;
      (out[id] || (out[id] = {}))[key] = clean;
    }
  }
  return out;
}

/**
 * 读取额度历史文件。缺失 / 损坏 / 版本不符一律视为空并保留原文件 ——
 * 额度历史是锦上添花，绝不能因为它坏了让插件起不来。
 */
export function readQuotaFile(file) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (data?.version !== QUOTA_FILE_VERSION || !data.suppliers || typeof data.suppliers !== "object") {
      return { status: "invalid", quota: {}, error: "额度历史文件格式或版本不受支持，已保留原文件" };
    }
    return { status: "ok", quota: normalizeQuota(data.suppliers) };
  } catch (error) {
    return error.code === "ENOENT"
      ? { status: "missing", quota: {} }
      : { status: "invalid", quota: {}, error: `额度历史文件读取失败，已保留原文件：${error.message}` };
  }
}

/** 原子落盘（临时文件 + rename），失败不破坏已有文件。 */
function writeQuotaSnapshot(file, quota) {
  let tmp;
  try {
    mkdirSync(dirname(file), { recursive: true });
    tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: QUOTA_FILE_VERSION, savedAt: new Date().toISOString(), suppliers: quota }, null, 2), "utf8");
    renameSync(tmp, file);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  } finally {
    if (tmp) { try { unlinkSync(tmp); } catch { /* 已重命名或删除。 */ } }
  }
}

/** 丢掉保留期之外的采样点；整条序列清空的指标与供应商一起移除。 */
export function pruneQuota(quota, retentionDays = QUOTA_RETENTION_DAYS, now = Date.now()) {
  const cutoff = now - Math.max(1, retentionDays) * 24 * 3600_000;
  const out = {};
  for (const [id, metrics] of Object.entries(quota || {})) {
    const kept = {};
    for (const [key, samples] of Object.entries(metrics || {})) {
      const fresh = (samples || []).filter((pair) => pair[0] >= cutoff);
      if (fresh.length) kept[key] = fresh;
    }
    if (Object.keys(kept).length) out[id] = kept;
  }
  return out;
}

/**
 * 把一次查询结果写进历史：只认带 key 且有合法 pct 的条目（余额类没有百分比，不进这条线）。
 * 值没变就不记新点；时刻必须严格递增，同一毫秒的重复写入顺延 1ms。
 * @returns {number} 实际新增的点数（0 表示没有任何变化）
 */
export function appendQuota(quota, id, entries, at = Date.now()) {
  if (!quota || typeof quota !== "object" || FORBIDDEN.has(id)) return 0;
  let time = Number(at);
  if (!isTime(time)) return 0;
  let added = 0;
  for (const entry of entries || []) {
    const key = String(entry?.key || "").trim();
    const pct = toPct(entry?.pct);
    // 字符集合法的 key 也可能命中原型链（constructor / prototype），必须单独挡掉
    if (FORBIDDEN.has(key) || !SAFE_KEY.test(key) || Number.isNaN(pct)) continue;
    const metrics = quota[id] || (quota[id] = {});
    const samples = metrics[key] || (metrics[key] = []);
    const last = samples[samples.length - 1];
    // 窗口内额度单调：同一个 pct 再记一次不增加任何信息
    if (last && last[1] === pct) continue;
    let stamp = time;
    if (last && stamp <= last[0]) stamp = last[0] + 1;
    samples.push([stamp, pct]);
    if (samples.length > QUOTA_MAX_SAMPLES) samples.splice(0, samples.length - QUOTA_MAX_SAMPLES);
    added++;
  }
  return added;
}

/**
 * 合并多份历史（跨进程写入 + 本地内存）：按时刻取并集。
 * 并集天然幂等 —— 同一份本地数据重复合并不会翻倍，因此不需要用量存储那套 baseline 差值。
 */
export function mergeQuota(...sources) {
  const merged = new Map(); // `${id}\u0000${key}` -> Map(t -> pct)
  for (const source of sources) {
    for (const [id, metrics] of Object.entries(source || {})) {
      if (FORBIDDEN.has(id) || !metrics || typeof metrics !== "object") continue;
      for (const [key, samples] of Object.entries(metrics)) {
        if (FORBIDDEN.has(key) || !SAFE_KEY.test(key)) continue;
        const tag = `${id}\u0000${key}`;
        let points = merged.get(tag);
        if (!points) merged.set(tag, points = new Map());
        for (const pair of samples || []) {
          if (!Array.isArray(pair) || !isTime(pair[0]) || !isPct(pair[1])) continue;
          points.set(pair[0], toPct(pair[1]));
        }
      }
    }
  }
  const out = {};
  for (const [tag, points] of merged) {
    const index = tag.indexOf("\u0000");
    const id = tag.slice(0, index), key = tag.slice(index + 1);
    const samples = [...points.entries()].sort((a, b) => a[0] - b[0]).map(([t, pct]) => [t, pct]);
    if (!samples.length) continue;
    (out[id] || (out[id] = {}))[key] = samples;
  }
  return out;
}

/** 只保留 sinceMs 之后的点（用于按展示窗口裁剪，不改变磁盘内容）。 */
export function clipSamples(samples, sinceMs) {
  const list = samples || [];
  const cut = Number(sinceMs);
  if (!Number.isFinite(cut)) return list;
  // 多留一个切点之前的样本：折线从窗口左缘正好进入，而不是凭空从第一个窗口内点开始。
  let first = list.findIndex((pair) => pair[0] >= cut);
  if (first < 0) return [];
  if (first > 0) first -= 1;
  return list.slice(first);
}

/**
 * 传输降采样：按时间分成至多 maxPoints 段，每段保留首尾两点。
 * 首尾而不是均值 —— 重置发生在两次查询之间时，只有「上一段末尾」和「这一段开头」
 * 的落差能把它画出来，取平均会把锯齿抹平。
 */
export function downsampleSamples(samples, maxPoints = QUOTA_SEND_POINTS) {
  const list = Array.isArray(samples) ? samples : [];
  const limit = Math.max(2, Math.floor(Number(maxPoints)) || QUOTA_SEND_POINTS);
  if (list.length <= limit * 2) return list;
  const start = list[0][0], end = list[list.length - 1][0];
  const span = Math.max(1, end - start);
  const buckets = new Map();
  for (const pair of list) {
    const index = Math.min(limit - 1, Math.floor(((pair[0] - start) / span) * limit));
    const bucket = buckets.get(index);
    if (!bucket) buckets.set(index, { first: pair, last: pair });
    else bucket.last = pair;
  }
  const out = [];
  for (const { first, last } of [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, bucket]) => bucket)) {
    out.push(first);
    if (last !== first) out.push(last);
  }
  return out;
}

const stores = new Map();

/**
 * 同进程共享历史；跨进程持有短写锁后按并集合并，避免后写者覆盖别人的采样。
 * 与用量存储一样是「读-合并-原子写」，区别在于合并是幂等的并集，不需要 baseline。
 */
export function acquireQuotaStore(file, retentionDays = QUOTA_RETENTION_DAYS) {
  file = resolve(file);
  let store = stores.get(file);
  if (!store) {
    const loaded = readQuotaFile(file);
    store = {
      quota: pruneQuota(loaded.quota, retentionDays),
      clients: new Map(),
      dirty: false,
      error: loaded.error || null,
    };
    stores.set(file, store);
  }
  const token = Symbol();
  store.clients.set(token, retentionDays);
  const maxDays = () => (store.clients.size ? Math.max(...store.clients.values()) : retentionDays);

  function flush({ waitForLockMs = 0 } = {}) {
    if (!store.dirty) return { ok: !store.error, error: store.error };
    let lock;
    const lockFile = `${file}.lock`;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const deadline = Date.now() + waitForLockMs;
      for (;;) {
        try { lock = openSync(lockFile, "wx"); break; } catch (error) {
          if (error.code !== "EEXIST" || Date.now() >= deadline) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      const latest = readQuotaFile(file);
      if (latest.status === "invalid") throw new Error(latest.error);
      const merged = pruneQuota(mergeQuota(latest.quota, store.quota), maxDays());
      const result = writeQuotaSnapshot(file, merged);
      if (!result.ok) throw new Error(result.error);
      store.quota = merged;
      store.dirty = false;
      store.error = null;
      return { ok: true };
    } catch (error) {
      store.error = error.code === "EEXIST" ? "额度历史文件正在写入或存在遗留锁，稍后重试" : error.message;
      return { ok: false, error: store.error };
    } finally {
      if (lock !== undefined) { closeSync(lock); try { unlinkSync(lockFile); } catch { /* 保留错误供下次写入报告。 */ } }
    }
  }

  let released = false;
  return {
    store, flush,
    /** 记录一次查询结果；返回新增点数（0 = 无变化，不必落盘）。 */
    record(id, entries, at = Date.now()) {
      const added = appendQuota(store.quota, id, entries, at);
      if (added) store.dirty = true;
      return added;
    },
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
