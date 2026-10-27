# 发布流程

适用于 `dsh-token-quota` 的版本发布。远端：`origin` = GitHub `ds-hu/dsh-usage-monitor`（fork，用于发布）；
`upstream` = `shxtmaker/dsh-token-quota`，只拉不推。发布标签带 `fork-` 前缀。

## 0. 前置检查

```bash
npm ci --ignore-scripts
npm test                 # 顶层测试项必须全绿
npm run test:browser     # 首次需 npx playwright install chromium
npm run test:pack
for f in lib/*.js; do node --check "$f"; done
git diff --check
```

任何一项失败都不要继续打标签。

## 1. 版本号

同步修改（三处必须一致）：

- `package.json` 的 `version`
- `package-lock.json` 顶层的 `version` 与 `packages[""].version`
- `README.md`：`当前版本：**vX.Y.Z**` 与安装示例中的 `dsh-token-quota-X.Y.Z.tgz`

语义化约定：修复类改动递增补丁号；新增能力/架构调整递增次版本号；不引入破坏性变更。
`usage.json` 自 2.2.0 起为**版本 2**：版本 1 文件读取时自动兼容（旧总数归入「未细分」），
旧版插件读到版本 2 会判为不支持并保留原文件——这是单向变化，发布说明里要写清楚。

## 2. 更新验证文档

- `docs/runtime-reliability.md`：本轮行为变更与存储设计。
- `docs/validation-report.md`：环境、实跑命令与实测数值、需求追踪、**未执行项**。
- 基准数值用 `node scripts/benchmark-storage.mjs` 与 `node scripts/benchmark-runtime.mjs` 现场生成，不要沿用旧数字。

## 3. 提交与标签

```bash
git add -A
git commit -m "release: vX.Y.Z <一句话摘要>"
git tag -a fork-vX.Y.Z -m "vX.Y.Z <要点逐条>"
```

标签一律用 **annotated tag**（`-a`），与 v1.1.1 起的既有标签一致；`fork-` 前缀避免与上游
`vX.Y.Z` 重名。多行说明写进文件后用 `-F`，不要在 PowerShell 里拼引号。

## 4. 打包产物

```bash
npm pack --pack-destination .                       # npm 安装包（58 个文件，含 lib/test/scripts）
git archive --format=tar.gz --prefix=dsh-token-quota-X.Y.Z/ \
  -o dsh-token-quota-X.Y.Z-source.tar.gz fork-vX.Y.Z  # 源码快照（额外含 docs/ 与 .github/）
```

校验和用 `Get-FileHash <file> -Algorithm SHA256`（Windows 上没有 `sha256sum`）。

`*.tgz` 与 `*.tar.gz` 已在 `.gitignore` 中，产物不进版本库。发布前用产物本身再跑一遍，避免「只测源码」：

```bash
tar -xzf dsh-token-quota-X.Y.Z.tgz -C .scratch/unpack
cd .scratch/unpack/package && npm install --ignore-scripts && npm run test:pack
for f in test/*.mjs; do node --test-reporter=tap "$f"; done   # 受限沙箱下不要用 npm test
```

解包目录里 `npm test` 会被沙箱拒绝派生测试子进程（`EPERM`），逐个文件跑同一批用例即可；
浏览器套件同样要回到仓库工作区跑，产物侧改用 `lib/`、`test/` 的逐字节同一性作证据。

## 5. 推送

```bash
git push origin main
git push origin fork-vX.Y.Z
```

推送走 DSH 的 `bridge_run {cmd:"git", …}`（在沙箱外执行，复用本机凭据）；argv 必须同时给出远端
与目标 ref。受限沙箱里直接 `git push` / `git ls-remote` 会因 `schannel: SEC_E_NO_CREDENTIALS`
失败——那是传输层的沙箱症状，不是凭据坏了。

需要注意的一致性检查：

- 用 `gh api repos/ds-hu/dsh-usage-monitor/tags --jq '.[].name'` 核对远端标签与本地 `git tag`，
  确认没有该远端缺失的历史标签（v1.2.1 曾只存在于 GitHub）。
- `origin` 指向 `ds-hu/dsh-usage-monitor`；旧名 `cup113/dsh-usage-monitor` 曾只靠跳转可用，
  容易误判，推送前用 `git remote -v` 确认一次。
- 推送是外部可见且难以撤回的操作：确认版本号、目标远端与提交内容后再执行。

## 6. 发布说明

在注解标签的说明里写清（GitHub 的 tag 页面会展示它）：行为变更清单、验证证据（测试项数、打包文件数、
基准数值）、以及**验证边界**（未在真实桌面端验收、未接真实 DSH、未访问真实计费账户等）。
产物校验和一并附上。逐版本的完整记录另存 `docs/vX.Y.Z-release-execution.md`。
