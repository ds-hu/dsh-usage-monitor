// DeepSeek 峰谷计费时段判定（宿主权威）。规则来自官方价格页脚注 (2)：
//   高峰时段 = 北京时间周一至周五（不含中国法定节假日）09:00–12:00、14:00–18:00
//   其余时段（夜间、周末、法定节假日全天）为空闲时段，价格是高峰的一半
//
// 三条生效分界线必须保留，否则回放历史小时桶会按今天的规则算旧账：
//   2026-08-17 峰谷定价实施；2026-08-23 起周末全天谷价；2026-09-19 起法定节假日全天谷价。
//
// 本模块是纯函数，不碰网络、不写文件、不抛异常：任何非法输入都降级为「未知」或内置表。
// 客户端不复制这些规则（lib/client.js 手写无构建、无法共享本文件源码），
// 只消费 index.js 下发的判定结果，倒计时由 flipAt 在本地递减。

/** 高峰窗口（北京当日分钟，左闭右开）。 */
export const PEAK_WINDOWS = [[9 * 60, 12 * 60], [14 * 60, 18 * 60]];

/** 候选切换边界（北京当日分钟）：每个窗口边缘加当日 00:00。 */
const BOUNDARY_MINUTES = [0, 9 * 60, 12 * 60, 14 * 60, 18 * 60];

/** 北京相对 UTC 的固定偏移。 */
const BEIJING_OFFSET_MS = 8 * 3600_000;

/** 一天的毫秒数。 */
const DAY_MS = 24 * 3600_000;

/** 候选边界回看天数：最长春节假期 9 天，留足余量。 */
const FLIP_HORIZON_DAYS = 12;

/** 用户覆盖表的条数上限（防呆，不是业务限制）。 */
export const HOLIDAY_OVERRIDE_LIMIT = 200;

/** 峰谷定价实施（北京 2026-08-17 00:00）。此前不存在峰谷之分。 */
export const PEAK_VALLEY_FROM_MS = Date.UTC(2026, 7, 16, 16, 0, 0);

/** 周末全天谷价生效（北京 2026-08-23 00:00）。此前周末按工作日时段计价。 */
export const WEEKEND_VALLEY_FROM_MS = Date.UTC(2026, 7, 22, 16, 0, 0);

/** 法定节假日全天谷价生效（北京 2026-09-19 00:00）。 */
export const HOLIDAY_VALLEY_FROM_MS = Date.UTC(2026, 8, 18, 16, 0, 0);

/**
 * 放假日（北京日历日 → true）。只列放假的日子。
 * 调休上班日（2026: 1/4、2/14、2/28、5/9、9/20、10/10；2027: 1/31、2/14、5/8、9/26、10/9）全部落在周末，
 * 按周末规则本就是谷价，因此无需单列 —— 这也意味着「调休上班的周末仍是谷价」不是漏洞，而是官方规则。
 *
 * ⚠️ 年度维护：每年 11 月国务院办公厅发布次年安排后在此补录。缺失只会静默把工作日假期
 * 当成峰价（多算钱），所以 coverageWarning() 会在界面上把这件事说清楚。
 */
export const HOLIDAY_VALLEY = Object.freeze({
  "2026-01-01": true, "2026-01-02": true, "2026-01-03": true,
  "2026-02-15": true, "2026-02-16": true, "2026-02-17": true, "2026-02-18": true, "2026-02-19": true,
  "2026-02-20": true, "2026-02-21": true, "2026-02-22": true, "2026-02-23": true,
  "2026-04-04": true, "2026-04-05": true, "2026-04-06": true,
  "2026-05-01": true, "2026-05-02": true, "2026-05-03": true, "2026-05-04": true, "2026-05-05": true,
  "2026-06-19": true, "2026-06-20": true, "2026-06-21": true,
  "2026-09-25": true, "2026-09-26": true, "2026-09-27": true,
  "2026-10-01": true, "2026-10-02": true, "2026-10-03": true, "2026-10-04": true,
  "2026-10-05": true, "2026-10-06": true, "2026-10-07": true,

  "2027-01-01": true, "2027-01-02": true, "2027-01-03": true,
  "2027-02-05": true, "2027-02-06": true, "2027-02-07": true, "2027-02-08": true, "2027-02-09": true,
  "2027-02-10": true, "2027-02-11": true, "2027-02-12": true, "2027-02-13": true,
  "2027-04-03": true, "2027-04-04": true, "2027-04-05": true,
  "2027-05-01": true, "2027-05-02": true, "2027-05-03": true, "2027-05-04": true, "2027-05-05": true,
  "2027-06-09": true,
  "2027-09-15": true,
  "2027-10-01": true, "2027-10-02": true, "2027-10-03": true, "2027-10-04": true,
  "2027-10-05": true, "2027-10-06": true, "2027-10-07": true,
});

/** 已覆盖的年份（升序字符串），供启动自检判断「该补次年了」。 */
export const COVERED_YEARS = Object.freeze(
  [...new Set(Object.keys(HOLIDAY_VALLEY).map((day) => day.slice(0, 4)))].sort(),
);

/** 北京日历日的 `YYYY-MM-DD` 键。 */
export function beijingDayKey(at) {
  return new Date(at.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

/** 北京时间的星期名与 HH:MM。 */
export function beijingClock(at) {
  const bj = new Date(at.getTime() + BEIJING_OFFSET_MS);
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const hh = String(bj.getUTCHours()).padStart(2, "0");
  const mm = String(bj.getUTCMinutes()).padStart(2, "0");
  return { weekday: weekdays[bj.getUTCDay()], clock: `${hh}:${mm}`, dayKey: bj.toISOString().slice(0, 10) };
}

/** 合法日期键：`YYYY-MM-DD` 且是真实存在的日历日（拒绝 2026-02-30 这类"格式对但日期不存在"）。 */
export function isValidDayKey(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
}

/**
 * 净化用户配置里的节假日覆盖表。
 *
 * 配置可以从设置界面手改，所以这里不信任任何形状：非数组、非法日期、超长一律丢弃并计数，
 * 绝不抛异常（判定逻辑坏了会让整块界面消失，比少一个节假日更糟）。
 *
 * @param {unknown} raw 配置原值。
 * @returns {{ days: string[]|null, rejected: number, truncated: boolean }}
 *   `days` 为 null 表示使用内置表（未配置或全部非法）。
 */
export function normalizeHolidays(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return { days: null, rejected: 0, truncated: false };
  const days = [];
  const seen = new Set();
  let rejected = 0;
  for (const item of raw) {
    const value = typeof item === "string" ? item.trim() : "";
    if (!isValidDayKey(value) || seen.has(value)) { rejected++; continue; }
    seen.add(value);
    if (days.length >= HOLIDAY_OVERRIDE_LIMIT) { rejected++; continue; }
    days.push(value);
  }
  if (days.length === 0) return { days: null, rejected, truncated: false };
  return { days: days.sort(), rejected, truncated: rejected > 0 };
}

/**
 * 覆盖表检查（供 /settings 在写入前拒绝坏数据；读取时不依赖它）。
 * @returns {{ ok: true, days: string[] }} 或 `{ ok: false, error: string }`
 */
export function validateHolidayOverride(raw) {
  if (raw === undefined || raw === null) return { ok: true, days: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "holidays 必须是日期字符串数组" };
  if (raw.length > HOLIDAY_OVERRIDE_LIMIT) {
    return { ok: false, error: `holidays 最多 ${HOLIDAY_OVERRIDE_LIMIT} 条，当前 ${raw.length} 条` };
  }
  const days = [];
  for (const item of raw) {
    const value = typeof item === "string" ? item.trim() : "";
    if (!isValidDayKey(value)) return { ok: false, error: `holidays 含非法日期：${JSON.stringify(item)}` };
    days.push(value);
  }
  return { ok: true, days: [...new Set(days)].sort() };
}

/** 该北京日历日是否为放假日（覆盖表优先，其次内置表）。 */
function holidaySetHas(dayKey, holidays) {
  if (Array.isArray(holidays) && holidays.length > 0) return holidays.includes(dayKey);
  return Object.hasOwn(HOLIDAY_VALLEY, dayKey);
}

/** 内置表是否把该北京日历日标为放假日（与用户覆盖表无关；供自检与测试判断是否「本来就放假」）。 */
export function isBuiltinHoliday(dayKey) {
  return Object.hasOwn(HOLIDAY_VALLEY, dayKey);
}

/** 该时刻是否落在法定节假日（且该规则已生效）。生效日之前的历史时刻一律 false。 */
export function isHolidayValley(at, holidays = null) {
  if (at.getTime() < HOLIDAY_VALLEY_FROM_MS) return false;
  return holidaySetHas(beijingDayKey(at), holidays);
}

/** 该时刻是否按「周末全天谷价」处理（且该规则已生效）。 */
export function isWeekendValley(at) {
  if (at.getTime() < WEEKEND_VALLEY_FROM_MS) return false;
  const dow = new Date(at.getTime() + BEIJING_OFFSET_MS).getUTCDay();
  return dow === 0 || dow === 6;
}

/** 某时刻是否为高峰时段（峰价）。生效日之前没有峰谷之分，一律 false（按当时的单一价）。 */
export function isPeak(at, holidays = null) {
  if (at.getTime() < PEAK_VALLEY_FROM_MS) return false;
  if (isWeekendValley(at)) return false;
  if (isHolidayValley(at, holidays)) return false;
  const bj = new Date(at.getTime() + BEIJING_OFFSET_MS);
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  return PEAK_WINDOWS.some(([from, to]) => minutes >= from && minutes < to);
}

/** 该时刻是节假日、周末，还是普通工作日。 */
export function dayKind(at, holidays = null) {
  if (isHolidayValley(at, holidays)) return "holiday";
  if (isWeekendValley(at)) return "weekend";
  return "weekday";
}

/**
 * 谷价的成因：节假日 / 周末 / null（只是夜间等非高峰时段）。
 * 客户端不复制规则，所以「为什么现在是谷价」也必须由宿主给结论。
 */
export function valleyReason(peak, kind) {
  if (peak) return null;
  if (kind === "holiday") return "holiday";
  if (kind === "weekend") return "weekend";
  return null;
}

/** 某个时刻所在北京日的 00:00（绝对时刻）。 */
function beijingMidnight(timeMs) {
  const bj = new Date(timeMs + BEIJING_OFFSET_MS);
  return Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - BEIJING_OFFSET_MS;
}

/**
 * 下一次真正发生峰↔谷切换的时刻。
 *
 * 只接受状态确实变化的边界：周五 18:00 之后虽然下一个边界是周六 09:00，
 * 但整个周末本来就是谷价，报它会显示一个并不会发生的倒计时。正确答案是周一 09:00。
 *
 * @returns {number|null} 切换时刻（epoch 毫秒）；12 天内无切换则为 null（界面据此不显示倒计时）。
 */
export function nextFlip(at = new Date(), holidays = null) {
  const from = at.getTime();
  const midnight = beijingMidnight(from);
  const candidates = [];
  for (let day = 0; day <= FLIP_HORIZON_DAYS; day++) {
    const base = midnight + day * DAY_MS;
    for (const minutes of BOUNDARY_MINUTES) candidates.push(base + minutes * 60_000);
  }
  candidates.sort((a, b) => a - b);
  for (const candidate of candidates) {
    if (candidate <= from) continue;
    if (isPeak(new Date(candidate), holidays) !== isPeak(new Date(candidate - 1), holidays)) return candidate;
  }
  return null;
}

/**
 * 节假日表覆盖自检：当年或次年未覆盖时返回提醒文案，否则 null。
 *
 * 为什么不静默：缺次年日期不会报错，只会静默把工作日假期误判成峰价。
 *
 * @param {Date} [at] 基准时刻。
 * @param {string[]|null} [holidays] 用户覆盖表；非空时以它为准（用户自己负责覆盖范围）。
 */
export function coverageWarning(at = new Date(), holidays = null) {
  if (Array.isArray(holidays) && holidays.length > 0) return null;
  const thisYear = beijingDayKey(at).slice(0, 4);
  const nextYear = String(Number(thisYear) + 1);
  const missing = [thisYear, nextYear].filter((year) => !COVERED_YEARS.includes(year));
  if (missing.length === 0) return null;
  return `节假日表缺少 ${missing.join("、")} 年的安排，工作日假期会被误判为峰价；`
    + `可在用量监控设置里粘贴节假日覆盖表（已覆盖：${COVERED_YEARS.join("、")}）。`;
}

/** 时段标签。峰/谷文案由客户端词典渲染，这里只给稳定枚举。 */
export function seasonLabel(peak) {
  return peak ? "peak" : "valley";
}

/**
 * 一次性算出某时刻的时段状态，供载荷与测试共用。
 *
 * @param {Date} [at]
 * @param {string[]|null} [holidays] 覆盖表。
 * @returns {{ peak: boolean, tier: string, kind: string, flipAt: number|null, beijing: object, warning: string|null }}
 */
export function describeSeason(at = new Date(), holidays = null) {
  const peak = isPeak(at, holidays);
  const kind = dayKind(at, holidays);
  return {
    peak,
    tier: seasonLabel(peak),
    kind,
    valleyReason: valleyReason(peak, kind),
    flipAt: nextFlip(at, holidays),
    beijing: beijingClock(at),
    warning: coverageWarning(at, holidays),
  };
}

/**
 * 单个「本地小时桶」归属于哪个计费时段。
 *
 * 拆分今日用量靠的就是这个函数：峰谷边界全部落在整点，北京又是整小时偏移，
 * 所以一个本地小时换算到北京时间后必然整体落在同一时段内 —— 小时粒度不会切错时段。
 *
 * @param {number} ms 该桶的本地时刻（storage.hourTimeMs 的返回值；非法 key 传 0）。
 * @returns {"peak"|"valley"|"unknown"} 早于生效分界线或时刻非法时为 unknown，绝不并入峰或谷。
 */
export function tierOfHour(ms, holidays = null) {
  if (!Number.isFinite(ms) || ms <= 0) return "unknown";
  // 生效分界线之前没有峰谷之分：旧桶按当时规则算不出峰谷，既不并入峰也不并入谷。
  if (ms < PEAK_VALLEY_FROM_MS) return "unknown";
  return isPeak(new Date(ms), holidays) ? "peak" : "valley";
}
