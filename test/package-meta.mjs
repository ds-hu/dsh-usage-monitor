// 插件展示元信息：宿主 Plugins 面板不执行插件代码，只经 ESM 解析器读
// <包名>/package.json 的 icon 与 <包名>/locale/*.json 的 meta.title / meta.description。
// 这里把那条宿主契约的有效性钉在仓库里：exports 必须可达、图标必须留在包内、locale 文件名必须是语言 id。
// 打包后的存在性由 scripts/check-package.mjs 断言（checkout 正常但漏打包时同样只剩占位图）。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
// 与 @deepseek-ai/dsh-app-boot 的 readPluginMeta 同口径。
const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;
const ICON_MEDIA_TYPES = new Set([".svg", ".png", ".jpg", ".jpeg", ".webp"]);
const MAX_ICON_BYTES = 256 * 1024;

test("plugin display metadata matches the host reader's contract", () => {
  assert.equal(manifest.exports["./package.json"], "./package.json", "包根标识要能读到 package.json");
  assert.equal(manifest.exports["./locale/*.json"], "./locale/*.json", "locale 必须经 exports 可达");

  assert.equal(typeof manifest.icon, "string", "manifest 必须声明 icon");
  assert.ok(!isAbsolute(manifest.icon) && !/^[A-Za-z][A-Za-z\d+.-]*:/u.test(manifest.icon), "icon 必须是相对路径");
  const icon = resolve(root, manifest.icon);
  const local = relative(root, icon);
  assert.ok(local && !local.startsWith(".."), "icon 必须留在包目录内");
  assert.ok(ICON_MEDIA_TYPES.has(extname(icon).toLowerCase()), "icon 必须是 SVG/PNG/JPEG/WebP");
  const stat = statSync(icon);
  assert.ok(stat.isFile(), "icon 必须是普通文件");
  assert.ok(stat.size > 0 && stat.size <= MAX_ICON_BYTES, "icon 必须在 256 KiB 以内");
  if (extname(icon).toLowerCase() === ".svg") assert.match(readFileSync(icon, "utf8").trimStart(), /^<svg[\s>]/);

  const localeDir = resolve(root, "locale");
  const files = readdirSync(localeDir).filter((name) => name.endsWith(".json"));
  assert.ok(files.includes("en.json"), "readPluginMeta 以 en.json 为入口");
  const dictionaries = {};
  for (const file of files) {
    const language = file.slice(0, -5);
    assert.match(language, LANGUAGE_ID, `${file}: 文件名必须是语言 id，否则整目录失效`);
    const parsed = JSON.parse(readFileSync(resolve(localeDir, file), "utf8"));
    assert.equal(typeof parsed.meta?.title, "string", `${file}: meta.title 必须是字符串`);
    assert.ok(parsed.meta.title.trim(), `${file}: meta.title 不能为空`);
    assert.equal(typeof parsed.meta?.description, "string", `${file}: meta.description 必须是字符串`);
    assert.ok(parsed.meta.description.trim(), `${file}: meta.description 不能为空`);
    dictionaries[language] = parsed.meta;
  }
  // 中英标题必须真的不同：两边都写英文标题时中文面板会静默显示英文名。
  assert.notEqual(dictionaries.zh.title, dictionaries.en.title);
});
