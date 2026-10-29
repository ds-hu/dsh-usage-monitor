import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 文案预算：界面文字是成本，不是功能。这个测试只守两件可静态验证的事：
// 1) 中英词典同键、同占位符；2) 已删除的浮层/长句不会悄悄回到词典里。
// 说明文字是否真的隐藏在默认视图里，由 test/browser/interactions.spec.mjs 的可见性断言负责。
const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const start = source.indexOf("const LOCALES = {");
const end = source.indexOf("// ---------- 样式", start);
const locales = source.slice(start, end);

const parse = (lang) => {
  const from = locales.indexOf(`        ${lang}: {`);
  const to = lang === "zh" ? locales.indexOf("\n        en: {", from) : locales.indexOf("\n      };", from);
  const block = locales.slice(from, to);
  return new Map([...block.matchAll(/^\s{10}(\w+):\s*"((?:[^"\\]|\\.)*)"/gm)].map((m) => [m[1], m[2]]));
};
const zh = parse("zh");
const en = parse("en");

test("both locale dictionaries stay complete and agree on placeholders", () => {
  assert.deepEqual([...zh.keys()].sort(), [...en.keys()].sort(), "新增文案必须中英双份");
  for (const [key, text] of zh) {
    const placeholders = (value) => [...String(value).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(placeholders(en.get(key)), placeholders(text), `占位符不一致：${key}`);
  }
});

test("removed surfaces and long explanatory paragraphs stay out of the dictionaries", () => {
  const removed = [
    "quickTitle", "statsTitle", "statsEmpty", "ratioOrder", "detailAdded", "lastRefresh", "poll",
    "detail", "stats", "settings", "allConfigured", "recentRefresh", "noSuppliers", "openSettings",
    "stale", "noData", "countBadge", "connDown", "connFailed", "connOk", "dayAgo", "hourAgo",
    "minAgo", "justNow", "loadFailed", "endpoint", "quotaNotFetched", "supplierPagesSub",
    "addedOnly", "addableHint", "openConfigAdd", "autoDetectedOn", "autoDetectedOff",
    "autoDetectedShort", "autoSourceShort", "notInDsh", "manualCredential", "watchHint",
    "moreAddable", "todayStatsAria", "addedCount", "attentionCount", "activeSupplier",
    "keyRefResolvedNote", "keyRefMissingNote", "env", "credentialStore",
  ];
  for (const key of removed) assert.ok(!zh.has(key) && !en.has(key), `已删除的文案又回来了：${key}`);
});

test("locale stays within the copy budget", () => {
  assert.ok(zh.size <= 160, `中文词典 ${zh.size} 键，超出预算`);
  assert.ok(en.size <= 160, `英文词典 ${en.size} 键，超出预算`);
});
