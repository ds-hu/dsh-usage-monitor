# dsh-token-quota

DeepSeek Harness 用量监控插件。查看当前会话对应供应商的周期限额、账户余额、报告费用和今日 Token 用量，支持 Windows 桌面端与 Web 界面。

当前版本：**v2.1.0**。要求 **DSH ≥ 0.1.7-rc.2**；真实桌面及 Web 验收环境为 **DSH 0.2.0-rc.2**。

Plugins 面板中显示为 **用量监控**（英文 **Usage monitor**）：图标是根目录 `icon.svg`，标题与一句话说明来自 `locale/zh.json` 与 `locale/en.json` 的 `meta`。

[GitHub 下载](https://github.com/shxtmaker/dsh-token-quota/releases/latest) · [问题反馈](https://github.com/shxtmaker/dsh-token-quota/issues)

## v2.1.0 更新

- 新增 DeepSeek 峰谷计费时段：侧栏常显当前档位（峰价／谷价）与「下次切换」，浮卡与明细给出成因（法定节假日／周末）和北京时间，刷新历史新增「时段」列。时段判定在宿主侧完成，客户端只消费结论。
- 新增今日用量时段拆分：DeepSeek 的当日用量按小时桶推导为高峰／空闲／未标记三段并给出占比，其他供应商不串用该口径。
- 新增节假日覆盖表：设置页可粘贴 `YYYY-MM-DD` 清单替换内置表；缺次年安排时在同一处点名，不再静默把工作日假期当峰价。
- 常驻卡片重新排版为四行：plan 名（不再显示模型名）、周窗口已用百分比进度条、今日 Token 用量与该窗口重置倒计时、计费时段档位。阈值颜色融入进度条，取消阈值圆点与插件标题行。
- Token 量级统一 3 位有效数字（`1.32M`、`12.0K`、`999.6K → 1.00M`），不再固定一位小数；用量浮卡不再重复计费时段块。

## v2.0.5 更新

- 修复智谱／Z.ai Coding Plan 查询失效：供应商已把用量窗口的类型名由 `TOKENS_LIMIT` 改名为 `CREDIT_LIMIT`，插件此前只认旧名，窗口全部被跳过，供应商显示为「暂时无法获取」。
- 窗口改按 `unit` 标识分类（5 小时窗口、周窗口、月度 MCP 上限），不再依赖数组位置；新增周窗口与供应商公布的重置时刻。新旧拼写并存时都能读取，重复或无法命名的窗口如实报错，不猜一个窗口顶上。
- 业务失败改按响应信封判定：密钥失效（HTTP 200 响应体内的 `code:401`）报鉴权失败，不再误报成「响应缺少 data.limits」。

## v2.0.4 更新

- 修复 Command Code 等供应商未公布重置时刻时错误显示“1月1日”的问题。
- 统一验证日期文案与原始时刻，零值、无效日期和误传入毫秒字段的秒级值显示为未知，不推算重置时间。
- 保留有效毫秒、数字串和带时区日期的准确时刻，OpenCode Go 的正常窗口倒计时保持不变。

## v2.0.3 更新

- 点击侧栏打开贴在卡片上方的用量浮卡，显示供应商主指标、查询状态、刷新间隔和上次刷新时间。
- 浮卡底部提供“详情”“设置”“关闭”；完整供应商明细和现有配置面板继续保留。
- 浮卡适配完整、紧凑和图标侧栏，支持再次点击、Esc 和外部点击关闭，随窗口变化调整位置。

## v2.0.2 更新

- 修复停用、重新启用和宿主重启插件时的 `webserver: duplicate exact route` 启用失败。
- 启动失败时释放已登记的资源；某项清理报错不会阻止其他资源释放。

## v2.0.1 更新

- 侧栏单击恢复独立「供应商限额明细」弹窗，按 v1.4.0 分栏展示已添加供应商与周期指标，刷新历史恢复为表格，沿用当前主题配色和按钮样式。
- 详情中的「设置」按钮进入现有概览、供应商、设置面板；保留完整／紧凑侧栏和显示偏好。
- 修复供应商扫描中的 `cannot get required service "settings" in inactive context` 错误；设置服务暂不可用时保留最近成功目录，恢复后可重新扫描。

## v2.0.0 更新

- 侧栏支持完整与紧凑显示，单击直接打开概览，显示偏好自动保存。
- 用量监控面板提供「概览」「供应商」「设置」三个页签，侧栏入口与宿主设置入口使用相同内容。
- 概览支持需关注筛选、自适应一列或两列布局，保留各周期与币种的独立指标。
- 配置编辑保留未保存草稿，提供放弃修改确认；保存失败保留输入，避免旧请求覆盖新的编辑内容。
- 查询失败时保留上次成功数据并标明状态；未知值与真实零值分别显示。
- 适配 Windows 桌面端的当前会话选择、原生设置入口和侧栏收起／恢复。

## 安装

从 Release 下载 **`dsh-token-quota-2.1.0.tgz`**。该文件是插件安装包，`dsh-token-quota-2.1.0-source.tar.gz` 是源码包。插件包不包含 DeepSeek Harness；首次安装可能需要联网下载依赖。

### Windows 桌面端

先启动一次 DeepSeek Harness Desktop，完成初始化后完全退出。使用安装目录自带的 CLI，将插件添加到 **`desktop` profile**。请按实际位置修改路径。

```powershell
$desktopCli = 'D:\AI\DeepSeek- Harness\resources\runtime\cli\bin\dsh.cmd'
$archivePath = (Resolve-Path './dsh-token-quota-2.1.0.tgz').Path
& $desktopCli plugin --profile desktop add "file:$archivePath"
& $desktopCli plugin --profile desktop list --depth 0
```

重新打开桌面应用，展开左侧栏即可看到用量组件；也可从「设置 → 用量监控」进入。安装到 `web` profile 的插件不会自动出现在桌面端。桌面侧栏收起后组件随侧栏隐藏，展开后恢复。

### Web / CLI

先安装 DeepSeek Harness，确认 `dsh --version` 能正常运行。以下示例使用 `web` profile；使用其他 profile 时请替换名称。

Linux / macOS：

```bash
dsh plugin --profile web add "file:$(pwd)/dsh-token-quota-2.1.0.tgz"
dsh --profile web
```

Windows PowerShell：

```powershell
$archivePath = (Resolve-Path './dsh-token-quota-2.1.0.tgz').Path
dsh plugin --profile web add "file:$archivePath"
dsh --profile web
```

若旧版本已提示重复路由，先完全退出 DSH，再安装 v2.0.4 并重新启动，以清除当前进程中遗留的旧路由。

安装或升级前，请先结束当前任务并退出对应 DSH 实例。压缩包升级时，用新包重新执行 `add` 命令，然后重启 DSH 并刷新 Web 页面。

### 从源码安装

```bash
git clone https://github.com/shxtmaker/dsh-token-quota.git
cd dsh-token-quota
npm ci
dsh plugin --profile web add "link:$(pwd)"
dsh --profile web
```

PowerShell 中将链接安装命令替换为：

```powershell
$pluginDirectory = (Get-Location).Path
dsh plugin --profile web add "link:$pluginDirectory"
```

链接安装直接使用源码目录，请保留该目录及其依赖。更新时执行 `git pull --ff-only` 和 `npm ci`，再重启 DSH。

## 开始使用

1. 单击侧栏组件：宽布局打开用量浮卡，手机／窄布局（视口 < 1024px）直接打开「供应商限额明细」；从其中的「设置」进入配置，再切到「供应商」页签。
2. 点击「重新扫描」，识别 Harness 已配置的普通 API Key；需要更高权限凭据的供应商请手动配置。
3. 打开供应商配置，填写必要字段、启用供应商并保存。秘密字段留空会保留旧值。
4. 使用「测试连接」检查已保存配置，或返回概览刷新数据。
5. 需要调整查询频率或本地用量保留期时，进入「设置」并保存。

**密钥的两种写法。** 每个秘密字段都能填**密钥本体**（`apiKey`，`role('secret')` 脱敏保存），
或只填**凭据引用**（`apiKeyEnv`，DSH 凭据库里的记录名或环境变量名，例如 `COMMAND_CODE_API_KEY`）。
引用在宿主内存里按「DSH 凭据库 → 进程环境变量」解析，密钥本体不写进插件配置；`/state` 只回传引用名与
是否解析成功。重新扫描只写引用（`apiKeyEnv`），不再把密钥本体拷进 profile 配置；两者同时存在时本体优先，
且**任一已填即视为手动接管**（扫描不再改动该供应商的密钥字段）。「测试连接」对编辑器里刚填、还没保存的引用
也会先解析一次，不必先保存再测。

**DeepSeek 桌面账户登录凭证与 API Key 不可互换。** 仅登录桌面账户时，请在现有 DeepSeek 供应商配置中填写同一账户的 API Key，或配置 Harness 的 DeepSeek API Key 路由后重新扫描。

## 侧栏与面板

完整侧栏分三段：**plan 名**（供应商显示名，不显示模型名）、**关注限额进度条**（可多条并排，每条自带真名短标签、已用百分比与该窗口的重置倒计时）、以及常显的**计费时段档位**（峰价／谷价与下次切换）。阈值颜色直接落在进度条上：绿 < 警告 < 黄 < 临界 < 红；多条时每条按自己的百分比分档，并共享列宽严格对齐。没有配置关注限额时退回**周窗口**，没有周窗口才改用已用比例最高的有效窗口，只有余额或报告费用时保留文字而不画条；旧数据与已停用保持中性色。今日 Token 用量不再占侧栏一行，改在详情弹窗里按供应商展示（无障碍标签仍可读到）。Token 数量一律 3 位有效数字（如 `1.32M`、`12.0K`）。紧凑侧栏保留供应商名与主指标文字。独立箭头切换显示状态，偏好保存在当前浏览器；宽度不足时自动使用紧凑显示，恢复宽度后恢复用户选择。

**关注限额**在「供应商 → 配置」页勾选：勾选顺序即卡片排列顺序，行内 ↑↓ 调整，未勾选 = 用默认规则。候选项来自上一次成功查询里带身份的可画条目（`5h 滚动`／`周用量`／`月用量`／`allowance` 等）；已勾选但这次查询没返回的项标注「当前不可用」并暂不画条，数据回来自动恢复。配置只影响侧栏卡片第 2 行，不改变浮卡、紧凑行与详情里的主指标口径。

单击侧栏打开用量浮卡，查看已添加供应商的主指标与查询状态。浮卡贴在侧栏卡片上方，窗口变化时自动调整位置；再次点击侧栏、按 Esc、点击外部或“关闭”均可收起。手机或宿主窄布局（视口 < 1024px）下不经过浮卡：单击入口直接打开「供应商限额明细」，浮卡只保留在宽布局。

点击浮卡中的“详情”（或在手机／窄布局下直接单击入口）打开完整明细。已添加供应商各占一栏，各周期和币种分别展示；窄窗口可横向滚动。默认收起的刷新历史表格最多展示最近 50 条。点击“设置”进入配置面板；宿主“设置 → 用量监控”也可直接进入该面板。

| 页签 | 内容 |
| --- | --- |
| 概览 | 今日用量、已添加与需关注数量、筛选、供应商指标和默认收起的刷新历史。 |
| 供应商 | 已添加目录、启用开关、配置入口、重新扫描，以及默认收起的可添加目录。 |
| 设置 | 查询间隔、用量保留期、节假日覆盖表（缺次年时同处点名告警）和侧栏显示偏好。 |

查询间隔默认 **60 秒**，范围 **10–3600 秒**；用量保留期默认 **7 天**，范围 **1–90 天**。后台刷新及页签切换保留编辑草稿；插件内部返回、取消或关闭时，会提示放弃未保存修改。宿主直接离开原生设置分区会销毁面板，无法保留未保存草稿。

## 数据含义

- **今日用量**：当前供应商通过 Harness 产生的当日 Token 用量，按宿主本地日统计。独立 CLI 或其他应用中的调用不计入。
- **周期限额**：百分比表示已用比例；常驻卡片第 2 行画的是用户配置的**关注限额**（可多条、按配置顺序），没配置时固定取周窗口、没有周窗口再取已用比例最高的有效窗口；每条的重置时间始终对应它自己的窗口。详情、概览与紧凑侧栏的主指标仍取已用比例最高的有效窗口。
- **计费时段**：DeepSeek 账号级的峰谷计价（按北京时间判定）是账户事实，因此常显在卡片最后一行；当日用量是否分属峰谷只在明细弹窗里按供应商给出。缺次年节假日安排时会在“设置”页的节假日覆盖表旁点名。
- **余额**：逐币种显示，不换算、不相加。
- **报告费用与报告用量**：保留供应商报告的周期，与本地今日 Token 统计分别展示。
- **未知与零值**：缺失或未知显示 `—`，真实零值显示 `0`；当前会话尚无调用时显示「暂无调用」。
- **更新失败**：有旧数据时显示「更新失败 · 上次数据」及可用的成功数据时间；没有旧数据时显示「暂时无法获取」。

切换会话不会借用其他会话的供应商。失败刷新保留同一配置下的旧结果；修改查询配置后清除该供应商的旧结果。

## 支持的供应商

| 供应商 | 查询内容 | 凭据 | 配置方式 |
| --- | --- | --- | --- |
| DeepSeek | 账户余额，保留多币种 | 普通 API Key | 自动识别或手动 |
| OpenRouter | 当前 Key 周期额度及今日费用 | 普通 API Key | 自动识别或手动 |
| OpenRouter 账户 | 账户 credits | Management Key | 手动 |
| OpenAI 组织 | 最近完整 UTC 日的用量与费用 | 组织 Admin Key | 手动 |
| Anthropic 组织 | 组织用量与费用 | 组织 Admin Key | 手动 |
| Moonshot 国内／国际 | 账户余额 | 普通 API Key | 自动识别或手动 |
| Z.ai／智谱 Coding Plan | 套餐窗口限额 | 普通 API Key | 自动识别或手动 |
| MiniMax 国内／国际 | Token Plan 窗口限额 | 普通 API Key | 自动识别或手动 |
| OpenCode（兼容来源） | 5 小时、周、月窗口及 allowance | 普通 API Key／OAuth | 自动识别或手动 |
| Command Code（兼容来源） | 5 小时、周窗口及套餐月额度 | 普通 API Key | 自动识别或手动 |

普通 API Key、Management Key 与 Admin Key 分别配置。插件不会将普通聊天密钥用于组织管理接口，也不会覆盖手动填写的密钥或重新启用显式关闭的供应商。

官方查询仅接受对应的 HTTPS 主机与已知基础路径；不符合要求的地址不会发送请求。OpenCode 与 Command Code 使用兼容接口，其可用性取决于供应商接口。表格表示插件支持的查询能力，不代表所有真实账户均已完成验证。

## 数据保存与升级

配置保存在对应 profile 的插件行配置中；秘密字段使用宿主的秘密字段机制。界面中秘密字段留空表示保留，清除时需编辑 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 中 `id: dsh-token-quota` 对应的配置。

本地 Token 用量按「供应商 × 小时」保存至 `$DSH_HOME/dsh-token-quota/usage.json`，按保留期修剪。刷新历史仅保存在内存中，重启后清空。

从旧版升级时，插件会在当前行尚无用户配置的条件下读取旧 `settings.yaml` 或 `settings.yaml.imported` 中的 `dsh-token-quota`／`quota-monitor` 配置，迁移后保留来源文件。旧用量目录 `quota-monitor` 仅在新目录不存在时迁移。

**v1.1.1 及更早版本用户**：旧插件名为 `dsh-usage-monitor` 或 `dsh-quota-monitor`。先用 `dsh plugin --profile <profile> list --depth 0` 确认，再移除旧包并安装新包，避免同时运行。

## 限制

- 仅观测经过 Harness 的调用；本机 Codex CLI 登录状态和独立 CLI 用量不在范围内。
- 供应商未返回重置时间时，不推算或补造时间；无限额度和未知余额保留未知。
- 没有多日趋势界面；本地用量统计与供应商账单可能因周期、时区和统计范围不同而不同。
- 真实供应商余额、付费调用及 Admin／Management Key 账户需要使用实际凭据另行验证。
- 当前 HTTP 接口面向本机同源访问；反向代理的公开来源配置需另行处理。
- 用量文件损坏或版本不支持时保留原文件并提示错误；退出时无法写入的增量不能保证保存。

## 开发与验证

```bash
npm ci --ignore-scripts
npm test
npx playwright install chromium
npm run test:browser
npm run test:pack
npm pack
```

真实宿主验收使用独立数据目录与 profile，不修改日常配置：

```powershell
npm run test:desktop -- --app 'C:/path/DeepSeek Harness.exe' --package 'C:/path/dsh-token-quota-2.1.0.tgz' --output '.scratch/desktop-v2-check'
node scripts/verify-web.mjs --app 'C:/path/DeepSeek Harness.exe' --package 'C:/path/dsh-token-quota-2.1.0.tgz' --output '.scratch/web-v2-check'
npm run test:lifecycle -- --app 'C:/path/DeepSeek Harness.exe' --output '.scratch/lifecycle-v2-check'
```

输出目录需为未使用过的目录。供应商解析测试使用模拟响应；真实 Desktop 与 Web 验收检查安装、界面、配置持久化和重新扫描，不发送聊天消息或配置真实供应商密钥。

[桌面兼容性说明](docs/windows-desktop-adaptation.md) · [侧栏与设置实施记录](docs/sidebar-settings-iteration-plan.md)

## 许可证

MIT。
