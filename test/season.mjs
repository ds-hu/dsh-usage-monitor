// test/season.mjs — 峰谷计费时段判定单元测试
//
// 为什么单独测：这类「日期/时段边界」逻辑错了不会报错，只会静默把谷价算成峰价（多算钱），
// 所以每条规则都用真实日期钉死，而不是靠样例凑。
//
// 用法：node --test test/season.mjs（或 node test/season.mjs 直接跑）
import assert from "node:assert/strict";
import test from "node:test";
import {
  COVERED_YEARS,
  HOLIDAY_OVERRIDE_LIMIT,
  HOLIDAY_VALLEY,
  PEAK_VALLEY_FROM_MS,
  beijingClock,
  beijingDayKey,
  coverageWarning,
  dayKind,
  describeSeason,
  isHolidayValley,
  isPeak,
  isWeekendValley,
  isValidDayKey,
  nextFlip,
  normalizeHolidays,
  tierOfHour,
  validateHolidayOverride,
} from "../lib/season.js";

/** 北京时间 → 绝对时刻（UTC+8），测试里只按北京墙钟写日期。 */
const bj = (y, m, d, hh = 0, mm = 0) => new Date(Date.UTC(y, m - 1, d, hh - 8, mm, 0));

test("普通工作日：高峰窗口左闭右开", () => {
  // 2026-10-13 是周二（10-01～10-07 国庆已过，10-10 调休周六也已过）
  assert.equal(isPeak(bj(2026, 10, 13, 8, 59)), false, "08:59 谷");
  assert.equal(isPeak(bj(2026, 10, 13, 9, 0)), true, "09:00 峰（左闭）");
  assert.equal(isPeak(bj(2026, 10, 13, 11, 59)), true);
  assert.equal(isPeak(bj(2026, 10, 13, 12, 0)), false, "12:00 谷（右开）");
  assert.equal(isPeak(bj(2026, 10, 13, 13, 59)), false);
  assert.equal(isPeak(bj(2026, 10, 13, 14, 0)), true, "14:00 峰");
  assert.equal(isPeak(bj(2026, 10, 13, 17, 59)), true);
  assert.equal(isPeak(bj(2026, 10, 13, 18, 0)), false, "18:00 谷");
  assert.equal(isPeak(bj(2026, 10, 13, 23, 30)), false);
});

test("周末全天谷价（2026-08-23 起生效）", () => {
  assert.equal(isPeak(bj(2026, 10, 17, 10, 0)), false, "周六");
  assert.equal(isPeak(bj(2026, 10, 18, 15, 0)), false, "周日");
  assert.equal(isWeekendValley(bj(2026, 10, 17, 10, 0)), true);
  // 生效日之前周末按工作日窗口计价：回放旧桶必须按当时的规则
  assert.equal(isPeak(bj(2026, 8, 22, 10, 0)), true, "2026-08-22 周六 10:00 生效前仍是峰价");
});

test("法定节假日全天谷价（2026-09-19 起生效）", () => {
  assert.equal(isPeak(bj(2026, 10, 1, 10, 0)), false, "国庆 10-01");
  assert.equal(isPeak(bj(2026, 10, 7, 15, 0)), false, "国庆 10-07");
  assert.equal(isHolidayValley(bj(2026, 10, 3, 11, 0)), true);
  assert.equal(dayKind(bj(2026, 10, 3, 11, 0)), "holiday");
  // 实施日之前不存在峰谷之分：旧时刻既不报峰价也不是「节假日谷价」，只能算未知时段
  assert.equal(PEAK_VALLEY_FROM_MS, Date.UTC(2026, 7, 16, 16, 0, 0));
  assert.equal(isPeak(bj(2026, 2, 17, 10, 0)), false, "2026-02-17 春节 10:00 早于峰谷实施日");
  assert.equal(isHolidayValley(bj(2026, 2, 17, 10, 0)), false, "生效日之前的节假日不按谷价规则");
  assert.equal(tierOfHour(bj(2026, 2, 17, 10, 0).getTime()), "unknown", "实施日之前的小时桶统一归未知");
});

test("调休上班的周末仍是周末 → 谷价，不是漏判", () => {
  // 2026-10-10 周六是国庆调休上班日；官方规则是「周末全天谷价」，不看是否上班
  assert.equal(isPeak(bj(2026, 10, 10, 10, 0)), false);
  assert.equal(dayKind(bj(2026, 10, 10, 10, 0)), "weekend");
});

test("nextFlip 只报真正发生切换的边界", () => {
  assert.equal(nextFlip(bj(2026, 10, 13, 8, 0)), bj(2026, 10, 13, 9, 0).getTime(), "周二 08:00 → 09:00");
  assert.equal(nextFlip(bj(2026, 10, 13, 9, 30)), bj(2026, 10, 13, 12, 0).getTime(), "周二峰中 → 12:00");
  assert.equal(nextFlip(bj(2026, 10, 15, 18, 30)), bj(2026, 10, 16, 9, 0).getTime(), "周四 18:30 → 周五 09:00");
  // 关键：周五 18:00 之后整个周末已是谷价，报周六 09:00 会显示一个不会发生的倒计时
  assert.equal(nextFlip(bj(2026, 10, 16, 18, 30)), bj(2026, 10, 19, 9, 0).getTime(), "周五 18:30 → 下周一 09:00");
  assert.equal(nextFlip(bj(2026, 10, 3, 10, 0)), bj(2026, 10, 8, 9, 0).getTime(), "国庆假期中 → 节后首个工作日 09:00");
});

test("describeSeason 只给结论，客户端不复制规则", () => {
  const peak = describeSeason(bj(2026, 10, 13, 10, 0));
  assert.equal(peak.peak, true);
  assert.equal(peak.tier, "peak");
  assert.equal(peak.kind, "weekday");
  assert.equal(peak.valleyReason, null, "峰价没有「为什么便宜」的成因");
  assert.equal(peak.beijing.weekday, "周二");
  assert.equal(peak.beijing.clock, "10:00");
  assert.equal(typeof peak.flipAt, "number");

  const holiday = describeSeason(bj(2026, 10, 3, 10, 0));
  assert.equal(holiday.peak, false);
  assert.equal(holiday.tier, "valley");
  assert.equal(holiday.kind, "holiday");
  assert.equal(holiday.valleyReason, "holiday");

  const weekend = describeSeason(bj(2026, 10, 17, 10, 0));
  assert.equal(weekend.kind, "weekend");
  assert.equal(weekend.valleyReason, "weekend");

  // 工作日夜间：谷价但不是节假日/周末，所以没有成因标记
  const night = describeSeason(bj(2026, 10, 13, 22, 0));
  assert.equal(night.peak, false);
  assert.equal(night.valleyReason, null);
});

test("覆盖表缺失时给可读告警，配置了覆盖表就不再打扰", () => {
  // 内置表已覆盖 2026 与 2027：2026 视点当年与次年都在表内，不该再打扰
  assert.deepEqual(COVERED_YEARS, ["2026", "2027"]);
  assert.equal(coverageWarning(bj(2026, 10, 13, 10, 0)), null);
  // 2027 视点：次年（2028）尚未录入 —— 告警必须点名它，且不牵连已覆盖的年份
  const warning = coverageWarning(bj(2027, 10, 13, 10, 0));
  assert.equal(typeof warning, "string");
  assert.ok(warning.includes("2028"), "缺次年必须点名：" + warning);
  assert.ok(!/缺少 202[67]/.test(warning), "已覆盖年份不该被列为缺失：" + warning);
  // 用户自己贴了覆盖表 → 由用户负责覆盖范围，宿主不再提示
  assert.equal(coverageWarning(bj(2027, 10, 13, 10, 0), ["2028-01-01"]), null);
});

test("2027 年内置表：29 天逐项钉死，工作日假期一律谷价", () => {
  // 逐项比对而不是只比天数：补录时打错一天（例如把 2/13 写成 2/12）必须在这里红
  const days2027 = Object.keys(HOLIDAY_VALLEY).filter((day) => day.startsWith("2027-")).sort();
  assert.deepEqual(days2027, [
    "2027-01-01", "2027-01-02", "2027-01-03",
    "2027-02-05", "2027-02-06", "2027-02-07", "2027-02-08", "2027-02-09",
    "2027-02-10", "2027-02-11", "2027-02-12", "2027-02-13",
    "2027-04-03", "2027-04-04", "2027-04-05",
    "2027-05-01", "2027-05-02", "2027-05-03", "2027-05-04", "2027-05-05",
    "2027-06-09",
    "2027-09-15",
    "2027-10-01", "2027-10-02", "2027-10-03", "2027-10-04",
    "2027-10-05", "2027-10-06", "2027-10-07",
  ]);
  // 补录不得顺手改动既有年份（2026 那 33 天）
  assert.equal(Object.keys(HOLIDAY_VALLEY).filter((day) => day.startsWith("2026-")).length, 33);

  // 元旦 1/1 是周五 —— 「缺表就按峰价多算钱」的典型样本：工作日假期
  const newYear = bj(2027, 1, 1, 10, 0);
  assert.equal(isPeak(newYear), false, "2027-01-01 周五 10:00 必须谷价");
  assert.equal(dayKind(newYear), "holiday");

  // 春节 9 天连续谷价，节后首个工作日 09:00 回峰
  const spring = bj(2027, 2, 9, 10, 0);
  assert.equal(isPeak(spring), false);
  assert.equal(describeSeason(spring).valleyReason, "holiday");
  assert.equal(tierOfHour(bj(2027, 2, 9, 9, 0).getTime()), "valley", "春节里 09:00 那格是谷价");
  assert.equal(nextFlip(spring), bj(2027, 2, 15, 9, 0).getTime(), "春节中的下次切换是节后首个工作日");
  assert.equal(isPeak(bj(2027, 2, 15, 9, 0)), true, "2/15 周一 09:00 回峰");

  // 中秋是单独一天：次日（9/16 周四）回峰，不是与国庆连休
  assert.equal(dayKind(bj(2027, 9, 15, 10, 0)), "holiday");
  assert.equal(isPeak(bj(2027, 9, 16, 10, 0)), true, "9/16 周四 10:00 应是峰价");

  // 调休上班日（10/9 周六）仍按周末算谷价：官方规则是「周末全天谷价」，不看是否上班
  assert.equal(dayKind(bj(2027, 10, 9, 10, 0)), "weekend");
  assert.equal(isPeak(bj(2027, 10, 9, 10, 0)), false);
});

test("normalizeHolidays 对坏配置只丢弃、不抛异常", () => {
  assert.deepEqual(normalizeHolidays(undefined), { days: null, rejected: 0, truncated: false });
  assert.deepEqual(normalizeHolidays([]), { days: null, rejected: 0, truncated: false });
  assert.deepEqual(normalizeHolidays("2026-10-01"), { days: null, rejected: 0, truncated: false }, "非数组视为未配置");
  const mixed = normalizeHolidays(["2027-10-01", " 2027-01-02 ", "2027-13-01", "2027-02-30", 7, null, "2027-10-01"]);
  assert.deepEqual(mixed.days, ["2027-01-02", "2027-10-01"], "非法与重复项丢弃、去重排序");
  assert.equal(mixed.rejected, 5);
  assert.equal(mixed.truncated, true);
  assert.ok(isValidDayKey("2026-02-28"));
  assert.equal(isValidDayKey("2026-02-30"), false, "格式对但日期不存在必须拒绝");
  assert.equal(isValidDayKey("2026-2-3"), false);
  // 超长输入被截断而不是无限增长
  const many = Array.from({ length: HOLIDAY_OVERRIDE_LIMIT + 10 }, (_, i) => `2027-01-${String((i % 28) + 1).padStart(2, "0")}`);
  const capped = normalizeHolidays(many);
  assert.ok(capped.days.length <= HOLIDAY_OVERRIDE_LIMIT);
});

test("validateHolidayOverride 在写入前拒绝坏数据，与读取侧的静默净化分工明确", () => {
  assert.deepEqual(validateHolidayOverride(undefined), { ok: true, days: [] });
  assert.deepEqual(validateHolidayOverride([]), { ok: true, days: [] });
  assert.deepEqual(validateHolidayOverride(["2027-01-02", "2027-01-01", "2027-01-01"]), { ok: true, days: ["2027-01-01", "2027-01-02"] });
  assert.equal(validateHolidayOverride("2027-01-01").ok, false);
  assert.equal(validateHolidayOverride(["2027-02-30"]).ok, false);
  assert.match(validateHolidayOverride(["ok", "bad"]).error, /非法日期/);
  assert.equal(validateHolidayOverride(new Array(HOLIDAY_OVERRIDE_LIMIT + 1).fill("2027-01-01")).ok, false);
});

test("tierOfHour：小时粒度不会切错时段，旧桶归入未知", () => {
  // 峰谷边界全在整点、北京是整小时偏移 ⇒ 一个整点小时整体落在同一时段内
  assert.equal(tierOfHour(bj(2026, 10, 13, 9, 0).getTime()), "peak");
  assert.equal(tierOfHour(bj(2026, 10, 13, 11, 0).getTime()), "peak");
  assert.equal(tierOfHour(bj(2026, 10, 13, 12, 0).getTime()), "valley");
  assert.equal(tierOfHour(bj(2026, 10, 13, 0, 0).getTime()), "valley");
  assert.equal(tierOfHour(bj(2026, 10, 17, 10, 0).getTime()), "valley", "周末");
  assert.equal(tierOfHour(bj(2026, 10, 3, 10, 0).getTime()), "valley", "节假日");
  // 生效分界线之前：不存在峰谷之分，既不并入峰也不并入谷
  assert.equal(tierOfHour(PEAK_VALLEY_FROM_MS - 1), "unknown");
  assert.equal(tierOfHour(0), "unknown");
  assert.equal(tierOfHour(NaN), "unknown", "非法 key 解析出的 0/NaN 一律未知");
});

test("用户覆盖表参与判定：把工作日标成假日就变谷价", () => {
  const weekday = bj(2026, 10, 13, 10, 0);
  assert.equal(isPeak(weekday), true);
  assert.equal(isPeak(weekday, ["2026-10-13"]), false, "覆盖表把 10-13 标为假日 → 全天谷价");
  assert.equal(dayKind(weekday, ["2026-10-13"]), "holiday");
  // 覆盖表只管放假日期：它不会把节假日变回峰价（避免出现「用户配置能造出错误计费」的路径）
  const holiday = bj(2026, 10, 3, 10, 0);
  assert.equal(isPeak(holiday, ["2026-10-13"]), false);
});

test("北京时间读数与日键", () => {
  const clock = beijingClock(bj(2026, 10, 13, 10, 30));
  assert.equal(clock.weekday, "周二");
  assert.equal(clock.clock, "10:30");
  assert.equal(clock.dayKey, "2026-10-13");
  assert.equal(beijingDayKey(bj(2026, 1, 1, 7, 0)), "2026-01-01", "北京时间 07:00 属于当天，不受宿主时区影响");
});
