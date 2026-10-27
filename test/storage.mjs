// test/storage.mjs — 本地用量数据存储单元测试（真实临时目录，纯 fs）
// 用法：node test/storage.mjs
import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEGACY_DIR_NAME,
  USAGE_DIR_NAME,
  USAGE_FILE_VERSION,
  breakdownOf,
  dayKeyOf,
  dayLabelOf,
  dayUsageHistory,
  hourKeyOf,
  hourTimeMs,
  loadUsageFile,
  migrateUsageDir,
  pruneBuckets,
  readUsageFile,
  saveUsageFile,
  splitDayTokens,
  sumDayTokens,
  totalOf,
  usageFilePath,
} from "../lib/storage.js";

const dir = mkdtempSync(join(tmpdir(), "qm-storage-"));
const file = usageFilePath(dir);

// ---- 时间 key ----
// 夹具相对真实时钟生成（保留期按 Date.now() 修剪，避免硬编码日期过期）
const nowMs = Date.now();
const now = new Date(nowMs - (nowMs % 3_600_000)); // 对齐到整点，本地时间
const hour = now.getHours();
const keyNow = hourKeyOf(now);
assert.equal(dayKeyOf(now), keyNow.slice(0, 8));
assert.equal(hourTimeMs(keyNow), now.getTime());
assert.equal(hourTimeMs("not-a-key"), 0);
console.log(`✓ 小时桶 key：${keyNow}（YYYYMMDDHH / 日前缀 / 解析）`);

// ---- 保留期修剪 ----
const oldKey = hourKeyOf(new Date(now.getTime() - 8 * 24 * 3600_000)); // 8 天前
const recentKey = hourKeyOf(new Date(now.getTime() - 3600_000)); // 1 小时前
const buckets = {
  deepseek: {
    [oldKey]: { inputTokens: 999 },
    [recentKey]: { inputTokens: 100, outputTokens: 20 },
    bad: 5,
  },
  // 版本 1 的数字仍可读：归一为未细分
  opencode: { [recentKey]: 50, zeroed: 0 },
};
const bucketsBefore = JSON.stringify(buckets);
const pruned = pruneBuckets(buckets, 7, now);
assert.deepEqual(pruned, {
  deepseek: { [recentKey]: { inputTokens: 100, outputTokens: 20 } },
  opencode: { [recentKey]: { unsplitTokens: 50 } },
}, "过期/非法/零值桶应被修剪；旧数字按未细分归一");
assert.equal(JSON.stringify(buckets), bucketsBefore, "修剪不得修改入参");
console.log("✓ 保留期修剪：只留 7 天内 >0 的合法小时桶（分量对象与旧数字都接受）");

// ---- 分量归一化 ----
{
  const empty = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, unsplitTokens: 0 };
  assert.deepEqual(breakdownOf(undefined), empty);
  assert.deepEqual(breakdownOf("12"), { ...empty, unsplitTokens: 12 }, "数值字符串按旧总量处理");
  assert.deepEqual(breakdownOf({ inputTokens: 1.9, outputTokens: -2, cacheReadTokens: Infinity, cacheWriteTokens: "3" }),
    { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 3, unsplitTokens: 0 },
    "小数取整、负数/非有限值归零");
  assert.equal(totalOf({ inputTokens: 1, cacheReadTokens: 2, unsplitTokens: 3 }), 6);
  assert.equal(totalOf(5), 5, "标量按总量解释");
  assert.equal(totalOf({ inputTokens: 0 }), 0);
  console.log("✓ 分量归一化：数字/字符串/对象/非法值都收敛到五项");
}

// ---- 原子写 + 载入回读 ----
const res = saveUsageFile(file, buckets, 7);
assert.equal(res.ok, true);
assert.equal(existsSync(file), true, "用量文件应已写入");
const loaded = loadUsageFile(file);
assert.deepEqual(loaded, pruned, "载入回读应与修剪后一致");
console.log(`✓ 落盘/载入：${file}`);

// ---- 损坏/缺失文件容忍 ----
assert.deepEqual(loadUsageFile(join(dir, "missing.json")), {}, "缺失文件应返回空");
const junk = join(dir, "junk.json");
saveUsageFile(junk, {}, 7);
assert.deepEqual(loadUsageFile(junk), {}, "空桶文件应返回空");
console.log("✓ 缺失/空文件容错");

// ---- 今日统计：只读当天 24 个本地小时键 ----
{
  const noon = new Date(2026, 8, 12, 12, 30, 0); // 本地 2026-09-12 12:30
  const day = dayKeyOf(noon);
  const hours = {
    [`${day}00`]: { inputTokens: 10 }, // 当天首小时
    [`${day}09`]: { outputTokens: 5 },
    [`${day}23`]: { cacheReadTokens: 100 }, // 当天末小时
    [`${day}24`]: { inputTokens: 999 }, // 非法小时键不得计入
    [dayKeyOf(new Date(2026, 8, 11, 23, 0, 0)) + "23"]: { inputTokens: 77 }, // 跨日边界：昨日末小时
    [dayKeyOf(new Date(2026, 8, 13, 0, 0, 0)) + "00"]: { inputTokens: 88 }, // 明日首小时
    bad: 123,
  };
  assert.equal(sumDayTokens(hours, noon), 115, "只累加当天 00–23 的桶");
  assert.equal(sumDayTokens({}, noon), null, "空桶 → null");
  assert.equal(sumDayTokens(undefined, noon), null, "无桶 → null");
  assert.equal(sumDayTokens({ [`${day}00`]: 0, [`${day}01`]: -5, [`${day}02`]: "x" }, noon), null,
    "全 0/负数/非法值 → null（不把未知当 0 以外的意思，也不返回 0）");
  assert.equal(sumDayTokens({ [`${day}00`]: "12" }, noon), 12, "版本 1 的数值字符串仍按总量累加");
  assert.equal(sumDayTokens({ [`${day}00`]: { inputTokens: "12" } }, noon), 12, "分量里的数值字符串也接受");
  // 读键次数上界：实现只允许发 24 次键查询（用 Proxy 计数）
  let reads = 0;
  const counted = new Proxy({ [`${day}03`]: { inputTokens: 7 } }, {
    get(target, key) { if (typeof key === "string") reads++; return target[key]; },
  });
  assert.equal(sumDayTokens(counted, noon), 7);
  assert.equal(reads, 24, "每个供应商最多 24 次小时键查询（不再遍历整份历史）");
  // 旧数据（远超保留期的时间桶）不影响当日读数，也不参与遍历
  const legacyHeavy = {};
  for (let i = 24; i < 2160; i++) legacyHeavy[hourKeyOf(new Date(noon.getTime() - i * 3600_000))] = i;
  assert.equal(sumDayTokens(legacyHeavy, noon), null, "90 天历史里当天无数据 → null");
  legacyHeavy[`${day}05`] = 3;
  assert.equal(sumDayTokens(legacyHeavy, noon), 3, "历史很长时当日读数不变");
  console.log("✓ 今日统计：只用当天 24 个小时键（含跨日/非法键/90 天历史/旧数字）");
}

// ---- 今日用量的计费时段拆分：纯读推导，按分量求和 ----
{
  // 2026-10-13 是周二（普通工作日）。用北京墙钟时刻构造，宿主时区只影响 key 的本地编码。
  const bjDate = (d, hh) => new Date(Date.UTC(2026, 9, d, hh - 8, 0, 0));
  const nowBj = bjDate(13, 20); // 当晚 20:00
  const day = dayKeyOf(nowBj);
  const hours = {
    [`${day}08`]: { inputTokens: 10 }, // 谷（早于 09:00）
    [`${day}09`]: { inputTokens: 20 }, // 峰
    [`${day}11`]: { outputTokens: 30 }, // 峰
    [`${day}12`]: { cacheReadTokens: 40 }, // 谷（午休）
    [`${day}18`]: { cacheWriteTokens: 50 }, // 谷（18:00 右开）
    [`${day}23`]: { inputTokens: 60, unsplitTokens: 0 }, // 谷
  };
  const split = splitDayTokens(hours, nowBj);
  assert.deepEqual(split, { peakTokens: 50, valleyTokens: 160, unknownTokens: 0 });
  // 口径必须自洽：三段之和 = sumDayTokens，不能因为拆分丢掉或多算
  assert.equal(split.peakTokens + split.valleyTokens + split.unknownTokens, sumDayTokens(hours, nowBj));

  // 峰谷实施日（北京 2026-08-17 00:00）之前的桶没有峰谷之分 → 一律归未知，绝不并进峰或谷
  const oldDay = new Date(2026, 7, 10, 12, 0, 0); // 2026-08-10
  const oldKey = dayKeyOf(oldDay);
  const oldSplit = splitDayTokens({ [`${oldKey}10`]: 7, [`${oldKey}11`]: 3 }, oldDay);
  assert.deepEqual(oldSplit, { peakTokens: 0, valleyTokens: 0, unknownTokens: 10 });

  // 非法 key 与零值/负数不参与任何一段
  assert.deepEqual(splitDayTokens({ bad: 5, [`${day}10`]: 0, [`${day}11`]: -3 }, nowBj),
    { peakTokens: 0, valleyTokens: 0, unknownTokens: 0 });
  assert.deepEqual(splitDayTokens(undefined, nowBj), { peakTokens: 0, valleyTokens: 0, unknownTokens: 0 });
  assert.deepEqual(splitDayTokens({}, nowBj), { peakTokens: 0, valleyTokens: 0, unknownTokens: 0 });

  // 跨日：昨日末小时与明日首小时都不进今天
  const other = splitDayTokens({
    [`${dayKeyOf(new Date(2026, 9, 12, 23, 0, 0))}23`]: 99,
    [`${day}00`]: 4,
  }, nowBj);
  assert.deepEqual(other, { peakTokens: 0, valleyTokens: 4, unknownTokens: 0 });

  // 读键次数上界与 sumDayTokens 同一口径（24 次）
  let reads = 0;
  const counted = new Proxy({ [`${day}09`]: { inputTokens: 6 } }, {
    get(target, key) { if (typeof key === "string") reads++; return target[key]; },
  });
  assert.deepEqual(splitDayTokens(counted, nowBj), { peakTokens: 6, valleyTokens: 0, unknownTokens: 0 });
  assert.equal(reads, 24, "拆分同样只查 24 个小时键");

  // 用户覆盖表参与：把 2026-10-13 标成假日 → 当天 09:00 那格也变谷价
  const overridden = splitDayTokens({ [`${day}09`]: { inputTokens: 20 } }, nowBj, ["2026-10-13"]);
  assert.deepEqual(overridden, { peakTokens: 0, valleyTokens: 20, unknownTokens: 0 });
  console.log("✓ 今日峰谷拆分：三段之和 = 今日总量；旧桶归未知；覆盖表参与判定");
}

// ---- 近 N 天历史：升序、今日在末、空日为 0、每天只读 24 个键 ----
{
  const noon = new Date(2026, 8, 12, 12, 30, 0); // 本地 2026-09-12 12:30
  const today = dayKeyOf(noon);
  const yesterday = dayKeyOf(new Date(2026, 8, 11, 12, 0, 0));
  const threeDaysAgo = dayKeyOf(new Date(2026, 8, 9, 12, 0, 0));
  const hours = {
    [`${today}09`]: { inputTokens: 10, outputTokens: 5 },
    [`${yesterday}10`]: { cacheReadTokens: 7 },
    [`${threeDaysAgo}11`]: 3, // 版本 1 数字 → 未细分
    [`${today}24`]: { inputTokens: 999 }, // 非法小时键不得计入
  };
  const history = dayUsageHistory(hours, 4, noon);
  assert.deepEqual(history.map((row) => row.day), ["2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12"],
    "升序，最后一行是今天");
  assert.deepEqual(history.map((row) => row.total), [3, 0, 7, 15], "空日保留 0 行，跨日不串");
  assert.deepEqual(history[0], {
    day: "2026-09-09", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheWriteTokens: 0, unsplitTokens: 3, total: 3,
  }, "旧数字计入未细分，不猜分布");
  assert.deepEqual(history[3], {
    day: "2026-09-12", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0,
    cacheWriteTokens: 0, unsplitTokens: 0, total: 15,
  });
  for (const row of history) {
    assert.equal(row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens + row.unsplitTokens,
      row.total, "每行的五项之和必须等于总量");
  }
  assert.equal(dayUsageHistory(hours, 1, noon).length, 1, "保留期 1 天时只给今天");
  assert.equal(dayUsageHistory(hours, 1, noon)[0].day, dayLabelOf(noon));
  assert.deepEqual(dayUsageHistory(undefined, 2, noon).map((row) => row.total), [0, 0], "无桶 → 全 0 行");
  // 读键上界：每天 24 次
  let reads = 0;
  const counted = new Proxy({ [`${today}03`]: { inputTokens: 7 } }, {
    get(target, key) { if (typeof key === "string") reads++; return target[key]; },
  });
  dayUsageHistory(counted, 2, noon);
  assert.equal(reads, 48, "两天历史 = 48 次小时键查询（每天 24 次）");
  console.log("✓ 近 N 天历史：升序/空日/旧数字未细分/每天 24 键");
}

// ---- 版本 1 → 2：旧总数以未细分保留；未知版本不读且不覆盖 ----
{
  const v1 = join(dir, "v1.json");
  writeFileSync(v1, JSON.stringify({ version: 1, buckets: { deepseek: { [recentKey]: 100, [oldKey]: 5 } } }));
  const read = readUsageFile(v1);
  assert.equal(read.status, "ok");
  assert.equal(read.version, 1);
  assert.deepEqual(read.buckets, { deepseek: { [recentKey]: { unsplitTokens: 100 }, [oldKey]: { unsplitTokens: 5 } } },
    "读入不改时间范围，只把数字归一为未细分");
  const v2 = join(dir, "v2.json");
  saveUsageFile(v2, read.buckets, 7);
  const raw = JSON.parse(readFileSync(v2, "utf8"));
  assert.equal(raw.version, USAGE_FILE_VERSION, "保存总是写当前版本");
  assert.deepEqual(raw.buckets.deepseek[recentKey], { unsplitTokens: 100 }, "落盘为稀疏分量对象");
  assert.equal(raw.buckets.deepseek[oldKey], undefined, "超出保留期的旧桶在保存时修剪");
  // 同一对象里混入旧数字：逐桶归一
  const mixed = join(dir, "mixed.json");
  writeFileSync(mixed, JSON.stringify({ version: 2, buckets: {
    deepseek: { [recentKey]: { inputTokens: 9, outputTokens: "x", cacheReadTokens: -1 }, [oldKey]: 7 },
  } }));
  assert.deepEqual(loadUsageFile(mixed), {
    deepseek: { [recentKey]: { inputTokens: 9 }, [oldKey]: { unsplitTokens: 7 } },
  });
  // 未知版本：不支持、原文件保留
  const future = join(dir, "future.json");
  writeFileSync(future, '{"version":3,"buckets":{}}');
  assert.equal(readUsageFile(future).status, "invalid");
  assert.equal(JSON.parse(readFileSync(future, "utf8")).version, 3, "原文件必须原样保留");
  assert.deepEqual(loadUsageFile(future), {});
  console.log("✓ 版本 1→2：旧总数未细分保留；保存写 v2；未知版本不读不覆盖");
}

// ---- 两个不同时区的进程读同一份桶：按各自本地日求和 ----
// 刻意不用 execFileSync：受限沙箱里「捕获子进程管道输出」会被拒绝（spawn EPERM），
// 而这是记录在案的边界。子进程改用 stdio:'ignore' + 写结果文件，父进程读文件，
// 断言内容与原实现完全一致 —— 换了传递方式，没换被测语义。
{
  const { spawnSync } = await import("node:child_process");
  const { readFileSync: readFileSyncTz, writeFileSync: writeFileSyncTz, rmSync: rmSyncTz } = await import("node:fs");
  const storageUrl = new URL("../lib/storage.js", import.meta.url).href;
  // 固定在同一个 UTC 时刻（2026-09-12T23:30Z）：上海已是 9/13 07:30，纽约还是 9/12 19:30。
  const instant = Date.UTC(2026, 8, 12, 23, 30, 0);
  // 同一份桶（键按 UTC 小时写成）：上海窗口 2026091216–2026091307、纽约窗口 2026091204–2026091303
  const shared = { "2026091204": 4, "2026091212": 8, "2026091219": 16, "2026091223": 32, "2026091307": 64 };
  const outFile = join(dir, "tz-probe.json");
  const script = `
    import { writeFileSync } from "node:fs";
    import { sumDayTokens, dayKeyOf } from ${JSON.stringify(storageUrl)};
    const d = new Date(Number(process.argv[1]));
    writeFileSync(process.argv[2], JSON.stringify({
      day: dayKeyOf(d),
      sum: sumDayTokens(${JSON.stringify(shared)}, d),
    }));
  `;
  const run = (tz) => {
    rmSyncTz(outFile, { force: true });
    const result = spawnSync(process.execPath,
      ["--input-type=module", "-e", script, String(instant), outFile],
      { env: { ...process.env, TZ: tz }, stdio: "ignore" });
    assert.equal(result.status, 0, `${tz} 子进程应正常退出`);
    return JSON.parse(readFileSyncTz(outFile, "utf8"));
  };
  const shanghai = run("Asia/Shanghai");
  const newYork = run("America/New_York");
  assert.equal(shanghai.day, "20260913", "上海进程的自然日已跨到 9/13");
  assert.equal(newYork.day, "20260912", "纽约进程的自然日仍是 9/12");
  assert.equal(shanghai.sum, 64, "上海只统计本地 9/13 的桶（19:30Z 已是次日 03:30）");
  assert.equal(newYork.sum, 4 + 8 + 16 + 32, "纽约只统计本地 9/12 的桶（UTC 深夜仍属当地当天）");
  console.log("✓ 时区：两个进程各按本地日求和，互不串日");
}

// ---- 改名迁移：旧目录 quota-monitor/ → 新目录 dsh-token-quota/ ----
// 覆盖成功迁移、重复调用幂等、新旧并存、目标空目录、目标无 usage.json 回落、跨设备/权限失败。
const migDir = mkdtempSync(join(tmpdir(), "qm-migrate-"));
const legacyDirPath = join(migDir, LEGACY_DIR_NAME);
const legacyPath = usageFilePath(migDir, LEGACY_DIR_NAME);
saveUsageFile(legacyPath, { deepseek: { [recentKey]: 42 } }, 7);
assert.equal(existsSync(legacyPath), true, "旧目录文件应已就位");
const migratedPath = migrateUsageDir(migDir);
assert.equal(migratedPath.path, usageFilePath(migDir), "应返回新目录路径");
assert.equal(migratedPath.status, "migrated", "旧目录存在且目标目录不存在时必须真的搬迁");
assert.equal(existsSync(legacyPath), false, "旧目录应已搬走");
assert.equal(existsSync(legacyDirPath), false, "旧目录本身不得残留");
assert.deepEqual(loadUsageFile(migratedPath.path), { deepseek: { [recentKey]: { unsplitTokens: 42 } } }, "迁移后数据必须原样保留");
// 幂等：再调一次不应报错、不应改动数据（目标已存在 → kept-new）
const migratedAgain = migrateUsageDir(migDir);
assert.equal(migratedAgain.path, usageFilePath(migDir));
assert.equal(migratedAgain.status, "kept-new");
assert.deepEqual(loadUsageFile(migratedAgain.path), { deepseek: { [recentKey]: { unsplitTokens: 42 } } }, "重复调用不得改动数据");
console.log("✓ 改名迁移：旧用量目录搬到新目录且数据无损（含重复调用幂等）");

// 新目录已存在时不动旧目录（避免覆盖现有数据）
const legacyAgain = usageFilePath(migDir, LEGACY_DIR_NAME);
saveUsageFile(legacyAgain, { stale: { [recentKey]: 1 } }, 7);
const afterSecond = migrateUsageDir(migDir);
assert.equal(afterSecond.path, usageFilePath(migDir), "已有新目录时仍用新目录");
assert.equal(afterSecond.status, "kept-new", "新旧并存时不得合并、不得覆盖");
assert.deepEqual(loadUsageFile(afterSecond.path), { deepseek: { [recentKey]: { unsplitTokens: 42 } } }, "不得被旧目录覆盖");
assert.equal(existsSync(legacyAgain), true, "新旧并存时旧目录必须原样保留，不能删");
console.log("✓ 新目录已存在时不搬迁、不覆盖");

// 目标目录存在、但新目录里没有 usage.json：旧文件仍在 → 回落旧路径读，不嵌套、不合并
const splitDir = mkdtempSync(join(tmpdir(), "qm-split-"));
const splitNextDir = usageFilePath(splitDir).replace(/[\\/]usage\.json$/, "");
mkdirSync(splitNextDir, { recursive: true }); // 目标空目录（第三方残留）
const splitLegacy = usageFilePath(splitDir, LEGACY_DIR_NAME);
saveUsageFile(splitLegacy, { moonshot: { [recentKey]: 7 } }, 7);
const splitResult = migrateUsageDir(splitDir);
assert.equal(splitResult.status, "fallback-legacy", "目标空目录 + 旧文件 → 必须回落旧路径");
assert.equal(splitResult.error, "target-dir-exists", "必须记下回落原因供诊断");
assert.equal(splitResult.path, splitLegacy, "回落时必须返回旧 usage.json 路径");
assert.deepEqual(loadUsageFile(splitResult.path), { moonshot: { [recentKey]: { unsplitTokens: 7 } } }, "回落读到的仍是旧数据");
assert.equal(existsSync(splitLegacy), true, "回落时不得删除旧文件");
assert.equal(existsSync(usageFilePath(splitDir)), false, "回落时不得凭空造出空的新文件");
assert.equal(existsSync(join(splitNextDir, LEGACY_DIR_NAME)), false, "不得把旧目录嵌套进目标目录（POSIX rename 陷阱）");
// 阻碍消失后下一次启动仍能成功迁移
rmSync(splitNextDir, { recursive: true, force: true });
const splitRetry = migrateUsageDir(splitDir);
assert.equal(splitRetry.status, "migrated", "目标目录被清理后重试必须成功迁移");
assert.deepEqual(loadUsageFile(splitRetry.path), { moonshot: { [recentKey]: { unsplitTokens: 7 } } }, "重试迁移后数据不变");
console.log("✓ 目标空目录/缺 usage.json：回落旧路径读，不嵌套不合并（清理后可重试）");

// 跨设备（EXDEV）/ 权限（EPERM）失败：不删旧数据，回落旧路径，状态可诊断
const failDir = mkdtempSync(join(tmpdir(), "qm-fail-"));
const failLegacy = usageFilePath(failDir, LEGACY_DIR_NAME);
saveUsageFile(failLegacy, { zai: { [recentKey]: 5 } }, 7);
const realRenameSync = fs.renameSync;
for (const code of ["EXDEV", "EPERM"]) {
  fs.renameSync = () => { const error = new Error(`simulated ${code}`); error.code = code; throw error; };
  syncBuiltinESMExports();
  const failed = migrateUsageDir(failDir);
  assert.equal(failed.status, "fallback-legacy", `${code}：必须回落旧路径`);
  assert.equal(failed.error, code, `${code}：必须把失败原因记进 status`);
  assert.equal(failed.path, failLegacy, `${code}：必须继续用旧 usage.json`);
  assert.deepEqual(loadUsageFile(failed.path), { zai: { [recentKey]: { unsplitTokens: 5 } } }, `${code}：数据不得丢失`);
  assert.equal(existsSync(failLegacy), true, `${code}：不得删除旧数据`);
  assert.equal(existsSync(usageFilePath(failDir)), false, `${code}：不得留下半截新文件`);
}
fs.renameSync = realRenameSync;
syncBuiltinESMExports();
// 故障恢复后下一次启动仍能成功迁移（同一进程内 self-heal）
assert.equal(migrateUsageDir(failDir).status, "migrated", "故障恢复后重试必须成功迁移");
console.log("✓ EXDEV/EPERM 失败：回落旧路径读且不丢数据，恢复后重试成功");
rmSync(failDir, { recursive: true, force: true });

// 两边都没有：返回新目录路径（首次安装的正常路径）
const freshDir = mkdtempSync(join(tmpdir(), "qm-fresh-"));
assert.equal(migrateUsageDir(freshDir).path, usageFilePath(freshDir), "全新安装应直接用新目录");
assert.equal(migrateUsageDir(freshDir).status, "none", "全新安装无迁移状态");
console.log("✓ 全新安装：直接用新目录");

rmSync(migDir, { recursive: true, force: true });
rmSync(splitDir, { recursive: true, force: true });
rmSync(freshDir, { recursive: true, force: true });
rmSync(dir, { recursive: true, force: true });
console.log("\n存储单元测试全部通过 ✔");
