import { spawnSync } from "node:child_process";
import { mkdtempSync, openSync, closeSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
const npm = process.env.npm_execpath;
if (!npm) throw new Error("请通过 npm run test:pack 运行");
// 不捕获 stdout 管道：受限沙箱里「捕获子进程输出」会被拒绝（spawn EPERM，记录在案的边界）。
// 改成把 npm pack 的 JSON 重定向到一个临时文件再读回来，stderr 直接继承（出错时照样能看见）。
const scratch = mkdtempSync(join(tmpdir(), "qm-pack-"));
const outFile = join(scratch, "pack.json");
const outFd = openSync(outFile, "w");
let packed;
try {
  packed = spawnSync(process.execPath, [npm, "pack", "--dry-run", "--json", "--ignore-scripts"],
    { stdio: ["ignore", outFd, "inherit"] });
} finally {
  closeSync(outFd);
}
assert.equal(packed.status, 0, "npm pack --dry-run 未正常退出");
const [manifest] = JSON.parse(readFileSync(outFile, "utf8"));
rmSync(scratch, { recursive: true, force: true });
const paths = new Set(manifest.files.map((file) => file.path));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
// 运行时模块必须逐个断言：拆分/新增模块后漏打包会让安装版直接跑不起来
for (const required of [pkg.main, pkg.exports["./client"], pkg.dsh.bundle.patch,
  "lib/routes.js", "lib/storage.js", "lib/scheduler.js", "lib/usage.js", "lib/detect.js",
  "lib/providers.js", "lib/scan-coordinator.js", "lib/legacy-config.js",
  // 峰谷时段判定：缺失会让安装版在 require 阶段直接抛 ERR_MODULE_NOT_FOUND
  "lib/season.js",
  // 额度历史：统计页的剩余额度折线依赖它，漏打包会让 /state?quota=1 直接 500
  "lib/quota-history.js",
  "README.md", "CHANGELOG.md"]) {
  assert.ok(paths.has(required.replace(/^\.\//, "")), `产物缺少 ${required}`);
}
// Plugins 面板的标题与图标同样要进产物并能经 ESM 解析器取到：
// checkout 里完好、装完却只剩包名与占位图，是这条契约最静默的坏法。
assert.equal(pkg.exports["./package.json"], "./package.json");
assert.equal(pkg.exports["./locale/*.json"], "./locale/*.json");
assert.equal(pkg.icon, "./icon.svg");
for (const required of ["icon.svg", "locale/en.json", "locale/zh.json"]) {
  assert.ok(paths.has(required), `产物缺少插件展示元信息 ${required}`);
}
assert.equal(manifest.name, "dsh-token-quota");
assert.ok(!manifest.files.some((file) => file.path.startsWith("node_modules/") || file.path.startsWith("test-results/")));
console.log(`打包验证通过：${manifest.files.length} 个文件，${manifest.size} 字节`);
