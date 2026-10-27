// lib/usage.js — 会话事件 → 本地用量小时桶的折叠
//
// DSH 的 TokenUsage 四项互不相交：inputTokens 只含未缓存输入，缓存命中/写入单独计数
// （见 dsh-llm 的 TokenUsage 契约）。这里把一次调用的样本折叠成五项分量后记账：
//   - 已报告样本归属于首次报告的小时；最终样本按 (session, turn, step) 替换同一步骤，
//     扣减与累加都逐分量进行，五项全等时视为无效保存（不碰桶、不写盘）。
//   - 未标识事件（turn/step 缺失）维持原有「每次都累加」规则，不做猜测去重。
//   - llm/retry-started 结束替换范围：同一 (turn, step) 的重试是另一次计费尝试，
//     必须累加而不是替换掉上一次（与 dsh-token-meter 的投影语义一致）。
//   - 只有 totalTokens、没有任何分量时记入 unsplitTokens：不丢总量，也不假装知道分布。
import { USAGE_COMPONENTS, addBreakdown, hourKeyOf, subtractBreakdown, totalOf } from "./storage.js";

/** 有限正数取整；其它按 0（token 计数没有小数意义）。 */
const countOf = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/**
 * 一次 DSH usage 样本 → 五项分量；全 0 返回 null（无效样本）。
 * 分量字段优先取 inputTokens，历史载荷里的 uncachedInputTokens 作为回退。
 */
export function usageBreakdownOf(usage) {
  const breakdown = {
    inputTokens: countOf(usage?.inputTokens ?? usage?.uncachedInputTokens),
    outputTokens: countOf(usage?.outputTokens),
    cacheReadTokens: countOf(usage?.cacheReadTokens),
    cacheWriteTokens: countOf(usage?.cacheWriteTokens),
    unsplitTokens: 0,
  };
  // 只有上游确实没给任何分量时才用 totalTokens 兜底，避免与分量双计
  if (totalOf(breakdown) === 0) breakdown.unsplitTokens = countOf(usage?.totalTokens);
  return totalOf(breakdown) > 0 ? breakdown : null;
};

const sameBreakdown = (left, right) =>
  USAGE_COMPONENTS.every((key) => countOf(left?.[key]) === countOf(right?.[key]));

/**
 * @param buckets supplierId -> { "YYYYMMDDHH": breakdown }（宿主内存与落盘共用同一对象）
 * @returns record(session, supplier, usage, turn, step, date?) => boolean
 *   本次调用是否真的改变了小时桶（true = 有替换/扣减/增加，需要落盘）。
 * record.forget(session, turn, step) 结束该步骤的替换范围（重试时调用）。
 */
export function createUsageRecorder(buckets) {
  const sessions = new WeakMap();
  const record = (session, supplier, usage, turn, step, date = new Date()) => {
    const breakdown = usageBreakdownOf(usage);
    if (!breakdown) return false;
    const hasSession = session !== null && (typeof session === "object" || typeof session === "function");
    let state = hasSession ? sessions.get(session) : null;
    if (!state || state.turn !== turn) {
      state = { turn, steps: new Map() };
      if (hasSession) sessions.set(session, state);
    }
    const identifiable = turn !== null && step !== null;
    const previous = identifiable ? state.steps.get(step) : null;
    const hour = previous?.hour ?? hourKeyOf(date);
    // 同一 (session, turn, step) 的样本未变（供应商、归属小时、五项都相同）⇒ 不碰桶。
    // 未标识事件没有 previous，永远不会走到这里。
    if (identifiable && previous && previous.supplier === supplier
      && previous.hour === hour && sameBreakdown(previous.breakdown, breakdown)) {
      return false;
    }
    const hours = buckets[supplier] ??= {};
    if (previous) {
      const prior = buckets[previous.supplier];
      const priorBucket = prior?.[hour];
      if (priorBucket) {
        subtractBreakdown(priorBucket, previous.breakdown);
        if (!Object.keys(priorBucket).length) delete prior[hour];
      }
    }
    addBreakdown(hours[hour] ??= {}, breakdown);
    if (identifiable) state.steps.set(step, { supplier, hour, breakdown });
    return true;
  };
  /** 重试开始：下一次同一步骤的样本应累加，而不是替换上一次尝试。 */
  record.forget = (session, turn, step) => {
    if (turn === null || step === null) return false;
    const state = session !== null && (typeof session === "object" || typeof session === "function")
      ? sessions.get(session) : null;
    if (!state || state.turn !== turn) return false;
    return state.steps.delete(step);
  };
  return record;
}
