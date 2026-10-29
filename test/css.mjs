import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const marker = "const CSS = `";
const cssStart = source.indexOf(marker) + marker.length;
const css = source.slice(cssStart, source.indexOf("`;", cssStart));
const lineOf = (offset) => source.slice(0, cssStart + offset).split("\n").length;

/** 把注释和字符串替换成空格（保留换行与偏移），让花括号扫描只看结构。 */
function masked(css) {
  const out = [...css];
  const blank = (from, to) => { for (let i = from; i < to; i++) if (out[i] !== "\n") out[i] = " "; };
  for (let i = 0; i < css.length;) {
    if (css.startsWith("/*", i)) {
      const close = css.indexOf("*/", i + 2);
      const end = close < 0 ? css.length : close + 2;
      blank(i, end);
      i = end;
    } else if (css[i] === "'" || css[i] === '"') {
      const quote = css[i];
      let j = i + 1;
      while (j < css.length) {
        if (css[j] === "\\") { j += 2; continue; }
        if (css[j] === quote) { j++; break; }
        j++;
      }
      blank(i, j);
      i = j;
    } else {
      i++;
    }
  }
  return out.join("");
}

test("the injected stylesheet has no selector-less declarations", () => {
  const text = masked(css);
  const failures = [];
  let depth = 0;
  let statement = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (depth === 0) {
      if (ch === "{") {
        depth = 1;
        statement = i + 1;
      } else if (ch === "}") {
        const chunk = text.slice(statement, i).trim();
        if (chunk) failures.push(`L${lineOf(statement)}: ${chunk.replace(/\s+/g, " ").slice(0, 120)}`);
        statement = i + 1;
      }
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) statement = i + 1;
    }
  }
  assert.equal(depth, 0, "stylesheet has unbalanced braces");
  assert.deepEqual(failures, [], "declarations outside any selector get parsed as a selector and swallow the rule that follows");
});
