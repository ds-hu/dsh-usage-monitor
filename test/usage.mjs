import assert from "node:assert/strict";
import test from "node:test";
import { createUsageRecorder, usageBreakdownOf } from "../lib/usage.js";
import { hourKeyOf, totalOf } from "../lib/storage.js";

const bucketOf = (buckets, id, date = new Date()) => buckets[id]?.[hourKeyOf(date)];

test("replacement across midnight and suppliers subtracts every component from the original bucket", () => {
  const buckets = {};
  const record = createUsageRecorder(buckets);
  const session = {};
  const before = new Date(2026, 8, 8, 23, 59);
  const after = new Date(2026, 8, 9, 0, 1);
  record(session, "a", { inputTokens: 10, outputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3 }, 1, 1, before);
  assert.deepEqual(bucketOf(buckets, "a", before), {
    inputTokens: 10, outputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3,
  });
  record(session, "b", { inputTokens: 30 }, 1, 1, after);
  assert.deepEqual(buckets.a, {}, "旧供应商的桶被逐分量扣空后删除");
  assert.deepEqual(bucketOf(buckets, "b", before), { inputTokens: 30 }, "归属小时仍是首次报告的小时");
});

test("interleaved steps replace independently; invalid counts do not poison totals", () => {
  const buckets = {};
  const record = createUsageRecorder(buckets);
  const session = {};
  record(session, "a", { inputTokens: 10 }, 1, 1);
  record(session, "a", { inputTokens: 20, cacheReadTokens: 5 }, 1, 2);
  record(session, "a", { inputTokens: 30, outputTokens: Infinity, cacheReadTokens: -3 }, 1, 1);
  assert.deepEqual(bucketOf(buckets, "a"), { inputTokens: 50, cacheReadTokens: 5 });
  record({}, "a", { inputTokens: 7 }, 1, 1);
  assert.equal(totalOf(bucketOf(buckets, "a")), 62, "未标识事件每次都累加");
});

// ---- C2：只有桶真的变了才返回 true（index.js 据此决定 markDirty / 排程落盘） ----
test("an unchanged final sample reports no change and never rewrites the bucket", () => {
  const buckets = {};
  const record = createUsageRecorder(buckets);
  const session = {};
  const at = new Date(2026, 8, 12, 10, 5);
  const sample = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 4 };
  assert.equal(record(session, "a", sample, 1, 1, at), true, "首次样本必须记一次变更");
  const snapshot = JSON.stringify(buckets);
  let changes = 0;
  for (let i = 0; i < 100; i++) if (record(session, "a", sample, 1, 1, at)) changes++;
  assert.equal(changes, 0, "同一步骤的相同最终样本重复 100 次都不得算变更");
  assert.equal(JSON.stringify(buckets), snapshot, "桶内容必须逐字节不变");
  assert.equal(totalOf(bucketOf(buckets, "a", at)), 64);
});

test("a changed final count, a changed supplier and a midnight rollover all stay correct", () => {
  const buckets = {};
  const record = createUsageRecorder(buckets);
  const session = {};
  const at = new Date(2026, 8, 12, 10, 5);
  const first = new Date(2026, 8, 12, 23, 59);
  const later = new Date(2026, 8, 13, 0, 1);
  // 流式期间同一 (turn, step) 的早期样本被最终样本替换（分量也一起被替换）
  assert.equal(record(session, "a", { inputTokens: 10, cacheReadTokens: 5 }, 1, 1, first), true);
  assert.equal(record(session, "a", { inputTokens: 25 }, 1, 1, first), true, "最终数量变化必须算变更");
  assert.deepEqual(bucketOf(buckets, "a", first), { inputTokens: 25 }, "替换而非累加，旧缓存分量一并扣掉");
  // 供应商变化：旧桶扣减 + 新桶增加（同一步骤，归属小时仍是首次报告的小时）
  assert.equal(record(session, "b", { inputTokens: 40 }, 1, 1, first), true, "供应商变化必须算变更");
  assert.equal(buckets.a[hourKeyOf(first)], undefined, "旧供应商桶被扣空后删除");
  assert.deepEqual(bucketOf(buckets, "b", first), { inputTokens: 40 });
  // 跨午夜的新步骤（非替换）落在新的本地小时桶
  assert.equal(record(session, "b", { inputTokens: 5 }, 1, 2, later), true);
  assert.deepEqual(bucketOf(buckets, "b", later), { inputTokens: 5 });
  assert.deepEqual(bucketOf(buckets, "b", first), { inputTokens: 40 }, "跨日不得动到已有小时桶");
  // 未标识事件维持原有「每次都累加」规则（不做猜测去重）
  assert.equal(record(session, "b", { inputTokens: 3 }, null, null, at), true);
  assert.equal(record(session, "b", { inputTokens: 3 }, null, null, at), true, "未标识事件不参与去重");
  assert.equal(totalOf(bucketOf(buckets, "b", at)), 6);
  // 无效计数不改动桶，也不算变更
  const before = JSON.stringify(buckets);
  assert.equal(record(session, "a", { inputTokens: 0, outputTokens: 0 }, 9, 9, at), false, "全 0 样本不产生桶变化");
  assert.equal(record(session, "a", { inputTokens: NaN, outputTokens: "x" }, 9, 9, at), false, "非法计数不算变更");
  assert.equal(JSON.stringify(buckets), before, "无效输入不得污染桶");
});

// ---- 五项分量与「未细分」兜底 ----
test("components stay disjoint and a total-only sample is recorded as unsplit", () => {
  const at = new Date(2026, 9, 27, 10, 5);
  assert.deepEqual(usageBreakdownOf({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }),
    { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, unsplitTokens: 0 });
  assert.deepEqual(usageBreakdownOf({ uncachedInputTokens: 5 }), {
    inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, unsplitTokens: 0,
  }, "历史载荷的 uncachedInputTokens 作为回退");
  assert.deepEqual(usageBreakdownOf({ totalTokens: 99 }), {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, unsplitTokens: 99,
  }, "只有总数时记未细分");
  assert.deepEqual(usageBreakdownOf({ inputTokens: 4, totalTokens: 999 }), {
    inputTokens: 4, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, unsplitTokens: 0,
  }, "有分量时绝不把 totalTokens 再加一遍");
  assert.equal(usageBreakdownOf({ inputTokens: 0, totalTokens: 0 }), null);
  assert.equal(usageBreakdownOf(undefined), null);

  const buckets = {};
  const record = createUsageRecorder(buckets);
  record({}, "a", { totalTokens: 99 }, 1, 1, at);
  assert.deepEqual(bucketOf(buckets, "a", at), { unsplitTokens: 99 });
});

// ---- 重试：另一次计费尝试，必须累加而不是替换 ----
test("llm/retry-started ends the replacement scope so the retried attempt adds", () => {
  const at = new Date(2026, 9, 27, 11, 0);
  const buckets = {};
  const record = createUsageRecorder(buckets);
  const session = {};
  assert.equal(record(session, "a", { inputTokens: 100 }, 3, 1, at), true);
  assert.equal(record.forget(session, 3, 1), true, "同一步骤的重试必须能结束替换范围");
  assert.equal(record.forget(session, 3, 1), false, "重复 forget 不报错也不影响其它步骤");
  assert.equal(record(session, "a", { inputTokens: 40 }, 3, 1, at), true);
  assert.equal(totalOf(bucketOf(buckets, "a", at)), 140, "两次尝试相加，而不是后一次替换前一次");
  // 其它轮次不应被这个 forget 波及
  record(session, "a", { inputTokens: 5 }, 4, 1, at);
  assert.equal(record.forget(session, 3, 1), false);
  assert.equal(record.forget(session, 4, 1), true);
});
