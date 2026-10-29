// DSH Web / Windows Desktop 共用客户端。官方槽位、无构建 React 加载。
// 展示控制器统一请求与会话订阅；面板草稿独立于展示缓存与本地偏好。
(function () {
  window.__ModuleLoader__.load({
    id: "dsh-token-quota",
    factory: (require) => {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

      const React = require("react");
      const { createPortal } = require("react-dom");
      const h = React.createElement;

      const NS = "dsh-token-quota";
      const API = "/api/dsh-token-quota";
      // 按会话页缓存最近一次 /state：切回某页时先显示缓存再后台刷新（切页实时，不闪「暂无调用」）
      const STATE_CACHE_LIMIT = 20;
      const stateCache = new Map(); // sessionKey -> payload
      // 当前「显示页」= Session Controller 的 sessions.list.current；apply 时装配订阅源，
      // 由 FooterSlotWithSession（useSyncExternalStore）消费，切页即时重渲。
      let sessionListSource = null;

      // 0.2 的会话目录不再保存 current；主视图通过 mainView 引用标记所选会话。
      // 只读宿主的公开快照，不为监控额外 retain 会话，也不把后台运行页当成当前页。
      const selectedSessionId = (snapshot) => {
        if (snapshot && Object.prototype.hasOwnProperty.call(snapshot, "current")) {
          return typeof snapshot.current === "string" ? snapshot.current : "";
        }
        const main = Object.values(snapshot?.byId || {}).filter((session) =>
          typeof session?.id === "string" && session.retainedBy?.mainView > 0);
        // 导航过渡期间若有多个主视图引用，先显示空页，避免短暂串到其它会话。
        return main.length === 1 ? main[0].id : "";
      };

      // ---------- 工具 ----------
      // Token 量级一律 3 位有效数字（1.32M / 64.4M / 193M / 12.0K），而不是「固定 1 位小数」：
      // 后者让 1.3M 只报 2 位有效数字，小量级的精度被静默丢掉。尾零保留，1.00M 仍是 3 位。
      // < 1000 直接给整数：token 计数没有小数意义，补成 12.0 只是假精度。
      const BIG_UNITS = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
      /** 缩放后数值的整数位数（1.32 → 1，64.4 → 2，193 → 3），用于补足 3 位有效数字。 */
      const digitsOf = (scaled) => Math.min(3, Math.max(1, Math.floor(Math.log10(Math.abs(scaled))) + 1));
      const fmtBig = (n) => {
        if (n === null || n === undefined) return "—";
        const v = Number(n);
        if (!Number.isFinite(v)) return "—";
        const abs = Math.abs(v);
        if (abs < 1000) return String(Math.round(v));
        let index = BIG_UNITS.findIndex(([scale]) => abs >= scale);
        if (index < 0) index = BIG_UNITS.length - 1;
        // 进位后仍要 3 位有效数字：999.6K 属于 M 量级，不是 1000K。
        if (index > 0 && abs / BIG_UNITS[index][0] >= 999.5) index -= 1;
        const [scale, suffix] = BIG_UNITS[index];
        const scaled = v / scale;
        return `${scaled.toFixed(3 - digitsOf(scaled))}${suffix}`;
      };
      // 阈值判定（A3 统一口径）：详情卡、供应商状态药丸、设置页预览与 stateToken 共用这一个纯函数。
      // 默认 80/95；无值/未知值/NaN 一律归为 unknown，绝不折成正常的 0%。
      const WARN_PCT_DEFAULT = 80;
      const CRIT_PCT_DEFAULT = 95;
      const classifyPct = (pct, { warnPct, critPct } = {}) => {
        const value = pct === null || pct === undefined || pct === "" ? NaN : Number(pct);
        if (!Number.isFinite(value)) return "unknown";
        const warn = Number.isFinite(Number(warnPct)) ? Number(warnPct) : WARN_PCT_DEFAULT;
        const crit = Number.isFinite(Number(critPct)) ? Number(critPct) : CRIT_PCT_DEFAULT;
        return value >= crit ? "crit" : value >= warn ? "warn" : "ok";
      };
      const stateClass = (s) => s?.state || "off";
      const stateToken = (s) => {
        if (!s) return "stateOff";
        if (s.state === "err") return "stateErr";
        if (s.state === "off") return "stateOff";
        const pct = Math.max(...(s.entries || []).map((x) => x.pct).filter(Number.isFinite));
        if (Number.isFinite(pct)) {
          const cls = classifyPct(pct, { warnPct: s.warnPct, critPct: s.critPct });
          if (cls === "crit") return "stateCrit";
          if (cls === "warn") return "stateWarn";
        }
        return "stateOk";
      };
      const pctText = (v) => {
        if (v === null || v === undefined) return "—";
        const s = String(v);
        return s.includes("%") ? s : `${s}%`;
      };
      const displayValue = (value) => value === null || value === undefined || value === "" ? "—" : String(value);
      const buildEntryView = (entry, supplier = {}, tr = (key) => key) => {
        const quota = Number.isFinite(entry.pct) || entry.kind === "win";
        const kind = quota ? "quota" : entry.kind === "bal" ? "balance" : entry.kind === "cost" ? "cost" : "usage";
        const status = classifyPct(entry.pct, supplier);
        return { kind, label: tr(kind), name: entry.name || tr(kind),
          value: Number.isFinite(entry.pct) ? pctText(entry.pct) : displayValue(kind === "balance" ? entry.remain : entry.used),
          reset: resetTextOf(entry, null, tr), note: (entry.note || "")
            .replace("官方插件字段；不推断周窗口或重置时间", tr("resetUnavailable"))
            .replace("公开契约允许无限额度", tr("unlimited"))
            .replace("（报告美分按 1/100 转为美元）", "")
            .replace("管理密钥 · total_credits − total_usage", tr("accountBalance")),
          tone: supplier.state === "err" || supplier.enabled === false || status === "unknown" ? "neutral" : status,
          warning: supplier.state !== "err" && supplier.enabled !== false && ["warn", "crit"].includes(status) ? tr(status === "crit" ? "stateCrit" : "stateWarn") : null };
      };
      const selectPrimaryMetric = (supplier, tr = (key) => key) => {
        const entries = supplier?.entries || [];
        const entry = tightestOf(entries) || entries.find(e => e.kind === "bal") || entries.find(e => e.kind === "cost") || entries[0];
        if (!entry) return { kind: "unknown", value: "—", label: "", name: "", reset: null, tone: "neutral", more: 0, text: "—" };
        const view = buildEntryView(entry, supplier, tr);
        const more = view.kind === "balance" ? entries.filter(e => e.kind === "bal").length - 1 : 0;
        return { ...view, more, text: [view.name, view.kind === "quota" ? tr("usedShort") : view.label, view.value,
          more > 0 ? tr("moreMetrics", { n: more }) : null,
          ["cost", "usage"].includes(view.kind) ? view.note : null].filter(Boolean).join(" · ") };
      };
      // 概览明细与编辑页预览共用的指标行：额度按「已用/限额/重置」列，余额与报告按各自列。
      // 只在这里决定分组与列语义；渲染层不再为每种条目写一套卡片。
      const METRIC_COLUMNS = {
        quota: [{ key: "used", labelKey: "usedShort" }, { key: "limit", labelKey: "colLimit" }, { key: "reset", labelKey: "colReset" }],
        balance: [{ key: "value", labelKey: "colValue" }],
        cost: [{ key: "value", labelKey: "colValue" }, { key: "period", labelKey: "colPeriod" }],
        usage: [{ key: "value", labelKey: "colValue" }, { key: "period", labelKey: "colPeriod" }],
      };
      const METRIC_TITLES = { quota: "quota", balance: "balance", cost: "cost", usage: "usage" };
      const metricRowsOf = (supplier, tr = (key) => key) => {
        const groups = new Map();
        for (const entry of supplier?.entries || []) {
          const view = buildEntryView(entry, supplier, tr);
          if (!groups.has(view.kind)) groups.set(view.kind, []);
          const row = { key: entry.key || `${view.kind}-${groups.get(view.kind).length}`, name: view.name, tone: view.tone,
            aria: `${view.name} ${view.value}${view.warning ? ` ${view.warning}` : ""}` };
          if (view.kind === "quota") { row.used = view.value; row.limit = displayValue(entry.limit); row.reset = view.reset || "—"; }
          else if (view.kind === "balance") { row.value = view.value; }
          else { row.value = view.value; row.period = entry.note || view.reset || "—"; }
          groups.get(view.kind).push(row);
        }
        return [...groups].map(([kind, rows]) => ({
          kind, titleKey: METRIC_TITLES[kind],
          columns: [{ key: "name", labelKey: "colMetric" }, ...METRIC_COLUMNS[kind]], rows,
        }));
      };
      const supplierStatus = (s, tr) => s?.state === "err"
        ? tr(s.entries?.length ? "staleFailure" : "unavailable")
        : s?.enabled === false ? tr("disabled") : !s?.entries?.length ? tr("notQueried") : tr(stateToken(s));
      const todayTotal = (state) => (state?.suppliers || []).filter(s => s.current)
        .reduce((sum, s) => sum + (typeof s.todayTokens === "number" ? s.todayTokens : 0), 0);

      // ---------- 今日 Token 分布（数据来自宿主 todayUsage / usageDays，五分量互不相交） ----------
      // label 是 i18n key，cls 是分布条/图例的配色类。前 3 项（命中/未命中/输出）构成归一比例，
      // 详情里的分布条取全部五分量 —— 比例口径与用户读数保持三段。
      const USAGE_PARTS = [
        { key: "cacheReadTokens", label: "cacheHit", cls: "hit" },
        { key: "inputTokens", label: "cacheMiss", cls: "miss" },
        { key: "outputTokens", label: "outputLabel", cls: "out" },
        { key: "cacheWriteTokens", label: "cacheWrite", cls: "write" },
        { key: "unsplitTokens", label: "unsplit", cls: "unsplit" },
      ];
      const num0 = (value) => Math.max(0, Number(value) || 0);
      /** 完整五分量（含写缓存、未细分），零分量剔除；详情里的当日分布条与图例用。 */
      const splitPartsOf = (usage) => USAGE_PARTS
        .map((part) => ({ ...part, value: num0(usage?.[part.key]) })).filter((part) => part.value > 0);
      /**
       * 比例数字：一律 3 位有效数字（30.0 / 1.00 / 0.150），与卡片量级同一口径 ——
       * 比例两侧的量级常常差两个数量级，位数不统一就没法竖着比。
       * 小数最多 4 位；再小就显式给 <0.0001，绝不四舍五入成 0 冒充「没有用量」。
       */
      const fmtRatioPart = (x) => {
        if (!(x > 0)) return "0.00";
        const decimals = Math.min(4, Math.max(0, 2 - Math.floor(Math.log10(x))));
        const text = x.toFixed(decimals);
        return Number(text) === 0 ? "<0.0001" : text;
      };
      /**
       * 命中 : 未命中 : 输出，归一到未命中 = 1（例：30.0 : 1.00 : 0.150）。
       * 未命中为 0 时改按三分量中的最大者归一（避免除零）；三分量全 0 返回 null —— 没有用量就不编比例。
       * unsplitTokens（旧版合并数据）不进比例：它没有分量信息，硬塞进任何一段都会撒谎。
       */
      const usageRatioOf = (usage) => {
        const hit = num0(usage?.cacheReadTokens), miss = num0(usage?.inputTokens), out = num0(usage?.outputTokens);
        const base = miss > 0 ? miss : Math.max(hit, out);
        if (base <= 0) return null;
        const parts = { hit: fmtRatioPart(hit / base), miss: fmtRatioPart(miss / base), out: fmtRatioPart(out / base) };
        return { ...parts, text: `${parts.hit} : ${parts.miss} : ${parts.out}`, hitValue: hit, missValue: miss, outValue: out };
      };
      /** 跨多行（usageDays）求和成一份五分量；统计页的窗口合计与窗口比例用。 */
      const sumUsageOf = (rows) => (rows || []).reduce((acc, row) => {
        for (const part of USAGE_PARTS) acc[part.key] = num0(acc[part.key]) + num0(row?.[part.key]);
        return acc;
      }, {});

      // ---------- 统计图：token 柱 + 剩余额度折线（同一张图、同一时间轴） ----------
      /** 折线配色：按指标顺序取色，与 token 分量的配色区分开（分量只出现在上方的分布条里）。 */
      const LINE_COLORS = ["#fbbf24", "#22d3ee", "#a78bfa", "#f472b6", "#4ade80"];
      /** "YYYY-MM-DD" → 本地当日 00:00 的 epoch-毫秒；格式不对返回 NaN。 */
      const dayStartOf = (label) => {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(label || ""));
        if (!match) return NaN;
        return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
      };
      /**
       * 图表时间轴：左缘取第一天 00:00，右缘取「今天结束」与 now 的较大值钳到明天 00:00。
       * 用自然日边界而不是首末采样点：柱是整天一格，线必须落在同一把尺子上。
       */
      const chartDomainOf = (days, now = Date.now()) => {
        const starts = (days || []).map((day) => dayStartOf(day?.day)).filter(Number.isFinite).sort((a, b) => a - b);
        if (!starts.length) return null;
        const start = starts[0];
        const lastStart = starts[starts.length - 1] + 24 * 3600_000;
        const end = Math.max(start + 3600_000, Math.min(now, lastStart));
        return { start, end };
      };
      /**
       * 把 [[t, pct], ...] 拆成若干连续段：pct 下降即换了新窗口（额度在窗口内只增不减），
       * 段与段之间不连线，锯齿才画得出来。样本按升序传入。
       */
      const quotaSegmentsOf = (samples) => {
        const segments = [];
        let current = null;
        let previous = null;
        for (const point of samples || []) {
          if (!Array.isArray(point) || point.length < 2) continue;
          const t = Number(point[0]), pct = Number(point[1]);
          if (!Number.isFinite(t) || !Number.isFinite(pct)) continue;
          if (previous !== null && pct < previous) current = null; // 新窗口：断开
          if (!current) { current = []; segments.push(current); }
          current.push([t, pct]);
          previous = pct;
        }
        // 单点段没有形状，但它是新窗口的起点：保留下来，由渲染层画成圆点
        return segments;
      };
      /** 图例条目：指标名 + 当前剩余百分比（100 − 已用）。没有样本的指标不出现。 */
      const quotaLegendOf = (quota, entries, tr) => (Object.entries(quota || {})).map(([key, samples], index) => {
        const known = (entries || []).find((entry) => entry?.key === key);
        const valid = (samples || []).filter((point) => Array.isArray(point) && Number.isFinite(Number(point[1])));
        if (!valid.length) return null;
        const lastPct = Math.max(0, Math.min(100, Number(valid[valid.length - 1][1])));
        return {
          key,
          label: known?.short || known?.name || key,
          color: LINE_COLORS[index % LINE_COLORS.length],
          remaining: Math.round(100 - lastPct),
          samples: valid,
          segments: quotaSegmentsOf(valid),
        };
      }).filter(Boolean);
      /**
       * 某个时刻的已用百分比：取最近一次采样（样本只在变化时落盘，「保持到下一次变化」就是真实语义）。
       * 不做时间插值 —— 那会造出从未采样到的数字。
       */
      const quotaUsedAt = (samples, at) => {
        let used = null;
        for (const point of samples || []) {
          const time = Number(point?.[0]);
          if (Number.isFinite(time) && time <= at) used = Number(point[1]);
        }
        return Number.isFinite(used) ? used : null;
      };
      /** 悬停读数里的时刻：MM-DD HH:mm。分钟够用，秒对判断窗口没有意义。 */
      const clockOf = (ms) => {
        const date = new Date(ms);
        const pad = (n) => String(n).padStart(2, "0");
        return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
      };

      // 已用比例最高的窗口及其重置时刻必须对应；不借用另一条 headline 的时刻。
      const tightestOf = (entries) => {
        let best = null;
        for (const e of entries || []) {
          if (!Number.isFinite(e?.pct)) continue;
          if (!best || e.pct > best.pct) best = e;
        }
        return best;
      };
      // 周窗口：名称含「周」且确实给了百分比的窗口项。窗口标签是 lib/providers.js 生成的中文常量
      // （Token 用量（周）/ 周用量 / 周窗口 · GOAT / 周期额度 · 每周重置），不是客户端拼的文案。
      // 绝不按数组位置猜窗口：认不出来就返回 null，由调用方回落到「最紧的有效窗口」。
      const WEEK_LABEL = /周/;
      const weeklyEntryOf = (entries) => {
        const weeks = (entries || []).filter((e) => e?.kind === "win" && Number.isFinite(e?.pct) && WEEK_LABEL.test(String(e?.name || "")));
        return weeks.length ? tightestOf(weeks) : null;
      };
      /**
       * 常驻卡片进度条的指标（可多条）：
       *   1. 用户配置的关注限额（`displayKeys`，保持配置顺序），只认当前真有百分比、且 key 对得上的条目；
       *   2. 交集为空 → 默认规则：周窗口优先，其次最紧的有效窗口；
       *   3. 两者都没有（纯余额／报告费用）→ 空数组，调用方回落成文字，绝不画一条 0% 的假进度条。
       * 颜色按供应商自己的阈值分档；旧数据（state=err）与已停用一律中性，不冒充新的告警状态。
       */
      const selectBarMetrics = (supplier, tr = (key) => key) => {
        const entries = supplier?.entries || [];
        const stale = supplier?.state === "err" || supplier?.enabled === false;
        const toBar = (entry, opts = {}) => ({
          entry,
          weekly: entry.kind === "win" && WEEK_LABEL.test(String(entry.name || "")),
          label: opts.defaultLabel || entry.short || entry.name || "",
          tone: stale ? "neutral" : classifyPct(entry.pct, supplier),
          reset: resetTextOf(entry, null, tr, true),
        });
        const barKeys = Array.isArray(supplier?.displayKeys) ? supplier.displayKeys : [];
        if (barKeys.length) {
          const byKey = new Map(entries.filter((e) => e?.key && Number.isFinite(e?.pct)).map((e) => [e.key, e]));
          const watched = barKeys.map((key) => byKey.get(key)).filter(Boolean);
          if (watched.length) return watched.map((entry) => toBar(entry));
        }
        const weekly = weeklyEntryOf(entries);
        const entry = weekly || tightestOf(entries);
        if (!entry) return [];
        return [toBar(entry, weekly ? { defaultLabel: tr("weekTag") } : {})];
      };
      /** 合法重置时刻的下界：epoch-毫秒。低于此值视为「未提供重置时刻」的占位。 */
      const MIN_RESET_EPOCH_MS = 1e12;

      // 重置倒计时：宿主若给了原始时刻（entry.resetAt / headline.resetAt，epoch-毫秒），
      // 由客户端精确算剩余量——< 1 天显示 *h*m，≥ 1 天显示 *d*h。
      // 宿主只给文案（如「约 43 小时后重置」）或没有时刻时不猜：原样回落，绝不推算时刻。
      // naked = 只给时长（卡片条上每条自带，省宽度），不带「后重置」这类叙述词。
      const fmtCountdown = (resetAt, tr, naked = false) => {
        const ms = Number(resetAt);
        // 与数据层一致，只接受 2001-09 之后的 epoch-毫秒时刻（>= 1e12）。
        // 上游偶尔给出 0 / 负值 / 秒级值当作「无重置时刻」的占位（真实样本：
        // Command Code windowLimits 缺失时 resetAt=0）——这类值绝不能拿去算倒计时，
        // 否则会画出「即将重置」这种上游从未说过的结论。
        if (!Number.isFinite(ms) || ms < MIN_RESET_EPOCH_MS) return null;
        const diff = ms - Date.now();
        if (diff <= 0) return tr("resetSoon");
        const totalMin = Math.floor(diff / 60_000);
        const mins = totalMin % 60;
        const hours = Math.floor(totalMin / 60);
        if (hours < 24) return tr(naked ? "resetHM" : "resetInHM", { h: hours, m: String(mins).padStart(2, "0") });
        return tr(naked ? "resetDH" : "resetInDH", { d: Math.floor(hours / 24), h: hours % 24 });
      };
      // 重置时间文本：优先精确倒计时，否则用宿主文案（"—" 视为缺失）
      const resetTextOf = (entry, headline, tr, naked = false) => {
        const countdown = fmtCountdown(entry ? entry.resetAt : headline?.resetAt, tr, naked);
        if (countdown) return countdown;
        const raw = (entry?.reset && entry.reset !== "—" ? entry.reset : null)
          || (!entry && headline?.reset && headline.reset !== "—" ? headline.reset : null);
        return raw || null;
      };
      // 小组件第 1 行的连接状态（票 #9 追加口径）= DSH 事件通道是否活着 × 限额取数健康度：
      //   ok   通道已见真实流量事件，且已配置供应商无取数失败
      //   warn 通道活着，但有供应商取数失败（降级）
      //   err  本次启动后通道尚未见到任何流量事件，且没有任何已配置供应商 → 未连接
      //   off  插件已加载、有已配置供应商，但通道还没见到流量 → 待命
      //        （别把「插件刚起来/还没发起调用」谎报成「断开」）
      const connStateOf = (state) => {
        const channelAlive = !!state?.traffic?.channelAlive;
        const suppliers = state?.suppliers || [];
        const failed = suppliers.filter((s) => s.enabled && s.added && s.state === "err").length;
        if (!channelAlive && suppliers.length === 0) return { key: "err", cls: "err", failed: 0 };
        if (!channelAlive) return { key: "off", cls: "off", failed: 0 };
        if (failed > 0) return { key: "warn", cls: "warn", failed };
        return { key: "ok", cls: "ok", failed: 0 };
      };

      // ---------- 峰谷计费时段（只做展示，规则判定在宿主 lib/season.js） ----------
      // 这里刻意不复制峰谷与节假日规则：lib/client.js 是手写无构建文件，无法共享宿主源码，
      // 双份实现只会在官方改规则时漂移。客户端只消费 /state 的 season 结论，并用 flipAt 本地递减。
      const SEASON_MIN_FLIP_MS = 1e12; // 与数据层同口径：低于此值的 flipAt 视为「未提供时刻」的占位

      /** 距下次切换还剩多久；宿主未给时刻或时刻非法时返回 null（不推算）。 */
      const seasonRemainingMs = (season, now = Date.now()) => {
        const ms = Number(season?.flipAt);
        if (!Number.isFinite(ms) || ms < SEASON_MIN_FLIP_MS) return null;
        return ms - now;
      };
      /** 切换倒计时文案：1 天内 h m，超过 1 天用 d h；宿主没给时刻则为 null。 */
      const seasonCountdown = (season, tr, now = Date.now()) => {
        const diff = seasonRemainingMs(season, now);
        if (diff === null) return null;
        if (diff <= 0) return tr("seasonFlipSoon");
        const totalMin = Math.floor(diff / 60_000);
        if (totalMin < 60) return tr("seasonFlipInM", { m: totalMin });
        const hours = Math.floor(totalMin / 60);
        if (hours < 24) return tr("seasonFlipInHM", { h: hours, m: String(totalMin % 60).padStart(2, "0") });
        return tr("seasonFlipInDH", { d: Math.floor(hours / 24), h: hours % 24 });
      };
      /** 时段档位文案 + 成因标记（节假日/周末只在谷价时成立）。 */
      const seasonLabelOf = (season, tr) => {
        const tier = tr(season?.peak ? "seasonPeak" : "seasonValley");
        const reason = season?.valleyReason === "holiday" ? tr("seasonHoliday")
          : season?.valleyReason === "weekend" ? tr("seasonWeekend") : "";
        return reason ? `${tier}（${reason}）` : tier;
      };
      /** 只报档位、不带成因：常驻卡片只需知道「现在是不是谷价」，成因由明细弹窗说明。 */
      const seasonTierOf = (season, tr) => tr(season?.peak ? "seasonPeak" : "seasonValley");
      /** 今日用量按计费时段拆分的展示文案；没有可用数据时返回 null。 */
      const seasonSplitText = (split, tr) => {
        if (!split) return null;
        const peak = Number(split.peakTokens) || 0;
        const valley = Number(split.valleyTokens) || 0;
        const unknown = Number(split.unknownTokens) || 0;
        const total = peak + valley + unknown;
        if (total <= 0) return null;
        const pct = (value) => `${Math.round((value / total) * 100)}%`;
        const parts = [];
        if (peak > 0) parts.push(tr("seasonSplitPeak", { n: fmtBig(peak), pct: pct(peak) }));
        if (valley > 0) parts.push(tr("seasonSplitValley", { n: fmtBig(valley), pct: pct(valley) }));
        // 未知段只在确实存在时出现：它表示早于峰谷定价生效的旧桶，不是「没算出来」
        if (unknown > 0) parts.push(tr("seasonSplitUnknown", { n: fmtBig(unknown) }));
        return parts.join(" · ");
      };
      /** 宿主时区与北京时区是否一致：不一致时界面必须点名「北京时间」，避免把本地白天误读成峰价。 */
      const hostOffsetMinutes = () => {
        try { return -new Date().getTimezoneOffset(); } catch { return 480; }
      };
      const seasonUsesBeijingNote = () => hostOffsetMinutes() !== 480;

      // 节假日覆盖表在界面上是一个文本框：每行一个日期，也接受逗号/空格/顿号分隔。
      // 保存时归一成数组交给宿主；宿主逐条校验并拒绝非法项，不做静默丢弃。
      const parseHolidayText = (value) => String(value ?? "")
        .split(/[\s,，、;；]+/).map((day) => day.trim()).filter(Boolean).sort();
      const holidaysTextOf = (value) => (Array.isArray(value) ? [...value].sort().join("\n") : parseHolidayText(value).join("\n"));
      // 与宿主 lib/season.js 的 isValidDayKey 同口径：格式对但日期不存在（2027-02-30）也算非法。
      // 前端先拦一道只是为了不白跑一次请求，最终把关仍在宿主。
      const isValidHolidayDay = (value) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
        const [y, m, d] = value.split("-").map(Number);
        const parsed = new Date(Date.UTC(y, m - 1, d));
        return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
      };
      const UI_PREF_KEY = "dsh-token-quota.ui.v1";
      let density = "expanded";
      try { if (JSON.parse(window.localStorage.getItem(UI_PREF_KEY))?.sidebarDensity === "compact") density = "compact"; } catch { /* 浏览器禁用存储时使用内存偏好。 */ }
      const preferenceListeners = new Set();
      const preferences = {
        subscribe(fn) { preferenceListeners.add(fn); return () => preferenceListeners.delete(fn); },
        getSnapshot: () => density,
        set(next) {
          density = next === "compact" ? "compact" : "expanded";
          try { window.localStorage.setItem(UI_PREF_KEY, JSON.stringify({ sidebarDensity: density })); } catch { /* 保留当次选择。 */ }
          for (const fn of preferenceListeners) fn();
        },
      };
      const useDensity = () => React.useSyncExternalStore(preferences.subscribe, preferences.getSnapshot, preferences.getSnapshot);
      let displayController;
      // 面板会话只持有未保存草稿与滚动位置，不进入展示缓存或本地存储。
      const createPanelSession = () => ({ globalForm: null, editor: null, editorId: 0, positions: {}, pendingSave: null });
      let panelSession = createPanelSession();
      const settingsWrites = new Set();

      // ---------- 界面状态 ----------
      // 同一时刻只有一个界面：null（关闭）| dialog（卡片打开）| page（宿主设置内嵌）。
      // tab 与 editing 是它的子状态。旧实现的 popover/detail/stats 三个布尔层已删除：
      // 打开哪个界面不再由调用方拼布尔值，非法组合在状态机里不存在。
      let surfaceSnapshot = { host: null, tab: "overview", editing: null, focus: 0, opening: false };
      const surfaceListeners = new Set();
      const surface = {
        subscribe(fn) { surfaceListeners.add(fn); return () => surfaceListeners.delete(fn); },
        getSnapshot: () => surfaceSnapshot,
        update(patch) { surfaceSnapshot = { ...surfaceSnapshot, ...patch }; for (const fn of surfaceListeners) fn(); },
        bump() { for (const fn of surfaceListeners) fn(); },
        waitForWrites(focus) {
          const pending = [...settingsWrites].map((operation) => operation.promise);
          if (!pending.length && !surfaceSnapshot.opening) return;
          surface.update({ opening: true });
          void Promise.allSettled(pending).then(() => displayController.reload()).finally(() => {
            if (surfaceSnapshot.focus === focus) surface.update({ opening: false });
          });
        },
        open({ tab = "overview" } = {}) {
          // 宿主设置页正开着时，卡片只切换该页的视图，不再叠一层对话框。
          if (surfaceSnapshot.host === "page") { surface.update({ tab, editing: null }); return; }
          panelSession = createPanelSession();
          const focus = surfaceSnapshot.focus + 1;
          const waiting = surfaceSnapshot.opening || settingsWrites.size > 0;
          surface.update({ host: "dialog", tab, editing: null, focus, opening: waiting });
          surface.waitForWrites(focus);
        },
        close() {
          panelSession = createPanelSession();
          surface.update({ host: null, tab: "overview", editing: null, opening: false });
        },
        showTab(tab) { surface.update({ tab, editing: null }); },
        editSupplier(id) { surface.update({ tab: "suppliers", editing: id }); },
        leaveEditor() { surface.update({ editing: null }); },
        attachPage() {
          // 原生设置页接管已打开的对话框与草稿；不抢宿主焦点，也不丢失正在编辑的子页。
          // 接管时不在页面上再等一遍保存：controller 会从 pendingSave 继承保存锁并显示禁用态；
          // 只有全新挂载的页面才需要 opening 等待，避免显示未同步的全局表单。
          const takingOver = surfaceSnapshot.host === "dialog";
          const waiting = surfaceSnapshot.opening || (!takingOver && settingsWrites.size > 0);
          surface.update({ host: "page", tab: "suppliers", editing: surfaceSnapshot.editing, opening: waiting });
          if (waiting) surface.waitForWrites(surfaceSnapshot.focus);
        },
        detachPage() {
          if (surfaceSnapshot.host !== "page") return;
          panelSession = createPanelSession();
          surface.update({ host: null, tab: "overview", editing: null, opening: false });
        },
      };
      const useSurface = () => React.useSyncExternalStore(surface.subscribe, surface.getSnapshot, surface.getSnapshot);

      // ---------- API ----------
      // sessionId undefined = 不按会话（沿用全局最近一次，兼容无 sessions 服务的嵌入场景）；
      // sessionId 为具体 id / 空串 = 严格「当前页」语义（空串即无当前页，显示暂无调用）。
      //
      // 请求生命周期（A1）：
      //   - 每个请求都有「初始等待上限」（超时即 abort 并进入重试），但超时不等于服务端操作失败：
      //     refresh/test 可能在服务端继续跑到 120s，客户端只是先放弃等待。
      //   - 取消一律走 AbortController（释放请求）；「请求代次校验」负责阻止不可取消或
      //     已完成的请求回写 —— 两者不能互相替代。
      //   - 后台 GET 采用「完成后调度」：上一次结束后再等 BACKOFF，而不是固定间隔不断发起。
      const REQUEST_TIMEOUT_MS = 30_000;   // GET /state 的初始等待上限
      const MUTATE_TIMEOUT_MS = 150_000;   // refresh/test：后端最长 120s 查询 + 余量
      const WRITE_TIMEOUT_MS = 30_000;     // settings/rescan：本地写入与扫描
      const POST_TIMEOUT_MS = {
        [`${API}/refresh`]: MUTATE_TIMEOUT_MS,
        [`${API}/test`]: MUTATE_TIMEOUT_MS,
        [`${API}/settings`]: WRITE_TIMEOUT_MS,
        [`${API}/rescan`]: WRITE_TIMEOUT_MS,
      };
      const POLL_BACKOFF_MS = [10_000, 20_000, 40_000, 60_000]; // 后台 GET 成功后复位到 10s
      const backoffDelay = (failures) => POLL_BACKOFF_MS[Math.min(Math.max(failures, 1), POLL_BACKOFF_MS.length) - 1];

      const timeoutController = (signal, ms) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(timeoutError(ms)), ms);
        return { signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, clear: () => clearTimeout(timer) };
      };
      const timeoutError = (ms) => {
        const error = new Error(`timeout after ${ms}ms`);
        error.name = "TimeoutError";
        return error;
      };
      // 取消（切页/隐藏/卸载，AbortError）与等待超时（TimeoutError）都释放请求，但语义不同：
      // 取消不计为失败；超时按失败推进退避（10→20→40→60s，见 load 的 catch）。
      const isCancelled = (error) => error?.name === "AbortError";

      const cacheState = (key, payload) => {
        if (stateCache.has(key)) stateCache.delete(key); // 置新后按最近使用排序，淘汰最旧
        stateCache.set(key, payload);
        if (stateCache.size > STATE_CACHE_LIMIT) stateCache.delete(stateCache.keys().next().value);
      };
      const queryOf = (sessionId, extra) => {
        const params = [];
        if (sessionId !== undefined) params.push(`session=${encodeURIComponent(sessionId || "")}`);
        if (extra) params.push(extra);
        return params.length ? `?${params.join("&")}` : "";
      };

      /** GET /state：校验 HTTP 状态与载荷 ok 字段；signal 释放请求，超时由局部 helper 统一管理。 */
      const getState = async (sessionId, { signal, quota = false } = {}) => {
        const guard = timeoutController(signal, REQUEST_TIMEOUT_MS);
        try {
          const response = await fetch(`${API}/state${queryOf(sessionId, quota ? "quota=1" : null)}`, { cache: "no-store", signal: guard.signal });
          // 显式失败才算失败（ok === false）：保持与 post 同一判定，兼容不带 ok 字段的替身响应
          if (response.ok === false) throw new Error(`HTTP ${response.status}`);
          const payload = await response.json().catch(() => {
            throw new Error("invalid JSON payload");
          });
          if (payload?.ok === false) throw new Error(payload.error || "state unavailable");
          return payload;
        } finally {
          guard.clear(); // 成功、失败、取消都必须释放超时定时器
        }
      };
      const post = async (path, body, sessionId, { signal } = {}) => {
        const guard = timeoutController(signal, POST_TIMEOUT_MS[path] ?? REQUEST_TIMEOUT_MS);
        try {
          const response = await fetch(`${path}${queryOf(sessionId)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body || {}),
            signal: guard.signal,
          });
          const result = await response.json().catch(() => {
            throw new Error(`HTTP ${response.status}`);
          });
          if (response.ok === false || result?.ok === false) throw new Error(result?.error || `HTTP ${response.status}`);
          return result;
        } finally {
          guard.clear();
        }
      };

      function createDisplayController(source) {
        const listeners = new Set();
        let snapshot = { state: null, refreshing: false, loadError: null };
        let key, generation = 0, timer = null, active = false, disposed = false, failures = 0;
        let inflight = null, manual = null, unsubscribe;
        const hidden = () => document.visibilityState === "hidden";
        const publish = (patch) => { snapshot = { ...snapshot, ...patch }; for (const fn of listeners) fn(); };
        const clearTimer = () => { if (timer !== null) clearTimeout(timer); timer = null; };
        const invalidate = () => {
          generation++; clearTimer(); inflight?.controller.abort(); manual?.controller.abort(); inflight = manual = null;
        };
        const arm = (delay) => {
          clearTimer();
          if (!active || hidden() || manual) return;
          timer = setTimeout(() => { timer = null; void load(); }, delay); timer?.unref?.();
        };
        const load = () => {
          if (inflight) return inflight.promise;
          if (!active || hidden() || manual) return Promise.resolve({ status: "cancelled" });
          clearTimer();
          const token = { controller: new AbortController(), generation, key };
          inflight = token;
          token.promise = (async () => {
            try {
              const state = await getState(token.key, { signal: token.controller.signal });
              if (inflight !== token || token.generation !== generation || !active) return { status: "cancelled" };
              failures = 0; cacheState(key, state); publish({ state, loadError: null });
              return { status: "ok", payload: state };
            } catch (error) {
              if (inflight !== token || token.generation !== generation || !active || isCancelled(error)) return { status: "cancelled" };
              failures++; publish({ loadError: error.message }); return { status: "failed", error };
            } finally {
              if (inflight === token) { inflight = null; arm(failures ? backoffDelay(failures) : POLL_BACKOFF_MS[0]); }
            }
          })();
          return token.promise;
        };
        const refresh = () => {
          if (manual) return manual.promise;
          if (!active || hidden()) return Promise.resolve({ status: "cancelled" });
          invalidate();
          const token = { controller: new AbortController(), generation, key };
          manual = token; publish({ refreshing: true });
          token.promise = (async () => {
            try {
              const state = await post(`${API}/refresh`, undefined, token.key, { signal: token.controller.signal });
              if (manual !== token || generation !== token.generation || !active) return { status: "cancelled" };
              failures = 0; cacheState(key, state); publish({ state, loadError: null });
              return { status: "ok", payload: state };
            } catch (error) {
              if (manual !== token || generation !== token.generation || !active || isCancelled(error)) return { status: "cancelled" };
              publish({ loadError: error.message }); return { status: "failed", error };
            } finally {
              if (manual === token) { manual = null; publish({ refreshing: false }); arm(POLL_BACKOFF_MS[0]); }
            }
          })();
          return token.promise;
        };
        const selectSession = () => {
          const next = source ? source.getSnapshot() : undefined;
          if (next === key && active) return;
          key = next; invalidate(); failures = 0;
          publish({ state: stateCache.get(key) || null, refreshing: false, loadError: null }); void load();
        };
        const visibility = () => {
          invalidate(); publish({ refreshing: false }); if (!hidden()) void load();
        };
        const stop = () => {
          active = false; invalidate(); unsubscribe?.(); unsubscribe = null;
          document.removeEventListener("visibilitychange", visibility);
        };
        return {
          subscribe(fn) {
            if (disposed) return () => {};
            listeners.add(fn);
            if (!active) {
              active = true; key = source ? source.getSnapshot() : undefined;
              publish({ state: stateCache.get(key) || null, refreshing: false, loadError: null });
              unsubscribe = source?.subscribe(selectSession);
              document.addEventListener("visibilitychange", visibility); void load();
            }
            return () => { listeners.delete(fn); if (!listeners.size) stop(); };
          },
          getSnapshot: () => snapshot, refresh,
          // 当前订阅的会话键：统计弹窗要按同一条作用域另取额度历史（?quota=1）
          sessionKey: () => key,
          async reload() {
            if (manual) await manual.promise;
            if (!active) return;
            invalidate();
            let result = await load();
            // 多个配置完成回调共享最新读取，不能把被新读取替代的取消当作已经同步。
            while (active && !hidden() && result?.status === "cancelled" && inflight) result = await inflight.promise;
            return result;
          },
          dispose() { disposed = true; stop(); listeners.clear(); stateCache.clear(); },
        };
      }
      function useQuotaState() {
        const snapshot = React.useSyncExternalStore(displayController.subscribe, displayController.getSnapshot, displayController.getSnapshot);
        return { ...snapshot, refresh: displayController.refresh, sessionKey: displayController.sessionKey() };
      }

      /**
       * 按需拉取带额度历史的 state（?quota=1）。只在概览首次展开供应商时取一次，
       * 同一面板会话内复用；失败不报错，图表降级为只有 token 柱。
       */
      function useQuotaHistory(sessionKey, enabled) {
        const cache = React.useRef({ key: null, payload: null });
        const generation = React.useRef(0);
        const [result, setResult] = React.useState({ loading: false, error: null, payload: null });
        const fetchQuota = React.useCallback(() => {
          if (!enabled) return;
          const gen = ++generation.current;
          setResult((old) => ({ ...old, loading: true, error: null }));
          getState(sessionKey, { quota: true })
            .then((payload) => {
              if (gen !== generation.current) return;
              cache.current = { key: sessionKey, payload };
              setResult({ loading: false, error: null, payload });
            })
            .catch((error) => {
              if (gen !== generation.current) return;
              setResult({ loading: false, error: error?.message || String(error), payload: null });
            });
        }, [enabled, sessionKey]);
        // 会话切换先让在途请求失效，再按新会话取一次。
        React.useEffect(() => {
          generation.current++;
          cache.current = { key: null, payload: null };
          setResult({ loading: false, error: null, payload: null });
        }, [sessionKey]);
        React.useEffect(() => {
          if (!enabled) return;
          if (cache.current.key === sessionKey && cache.current.payload) {
            setResult({ loading: false, error: null, payload: cache.current.payload });
            return;
          }
          fetchQuota();
        }, [enabled, sessionKey, fetchQuota]);
        return { ...result, reload: fetchQuota };
      }
      const supplierDraft = (sup) => ({
        enabled: !!sup.enabled, baseUrl: sup.baseUrl || sup.baseUrlDefault || "",
        warnPct: sup.warnPct ?? 80, critPct: sup.critPct ?? 95,
        apiKeyEnv: sup.apiKeyEnv || "",
        // 关注限额：有序数组；空数组 = 未配置（卡片走默认规则）。草稿复制一份，避免直接改 state。
        displayKeys: Array.isArray(sup.displayKeys) ? [...sup.displayKeys] : [],
        ...Object.fromEntries((sup.meta?.needs || []).map((need) => [need.key, need.secret ? "" : (sup[need.key] ?? "")])),
      });
      function supplierPatch(sup, form) {
        const patch = { enabled: !!form.enabled, baseUrl: String(form.baseUrl || ""),
          warnPct: Number(form.warnPct), critPct: Number(form.critPct),
          apiKeyEnv: String(form.apiKeyEnv || "").trim(),
          displayKeys: (Array.isArray(form.displayKeys) ? form.displayKeys : []).map(String).slice(0, 12) };
        for (const need of sup.meta?.needs || []) {
          const value = String(form[need.key] ?? "");
          if (!need.secret) patch[need.key] = value;
          else if (value.trim()) patch[need.key] = value.trim();
        }
        return patch;
      }

      function FooterWidget({ wide, t }) {
        const entryRef = React.useRef(null), widthRef = React.useRef(null);
        const preference = useDensity(), panel = useSurface();
        const [narrow, setNarrow] = React.useState(false);
        const { state, loadError } = useQuotaState();
        // 单击卡片直接打开唯一的面板；已经打开时不重复触发（关闭走面板自己的未保存确认）。
        const activateEntry = () => { if (panel.host !== "dialog") surface.open({ tab: "overview" }); };
        React.useEffect(() => {
          const node = widthRef.current;
          if (!node || typeof ResizeObserver === "undefined") return;
          const update = (width) => setNarrow(width > 0 && width < 200);
          update(node.getBoundingClientRect().width);
          const observer = new ResizeObserver(entries => { for (const e of entries) update(e.contentRect.width); });
          observer.observe(node); return () => observer.disconnect();
        }, [wide]);
        const compact = narrow || preference === "compact";
        const active = state?.active;
        const supplier = active && state?.suppliers?.find(s => s.id === active.supplierId);
        const metric = selectPrimaryMetric(supplier, t);
        const name = active?.name || t("noneActive");
        const todayCount = typeof supplier?.todayTokens === "number" ? supplier.todayTokens : 0;
        const bars = selectBarMetrics(supplier, t);
        const resetText = bars.length ? bars.map(bar => bar.reset).filter(Boolean).join(" · ") : metric.reset;
        const failure = loadError ? t(state ? "staleFailure" : "unavailable") : supplier?.state === "err" ? supplierStatus(supplier, t) : "";
        const conn = connStateOf(state);
        const connText = t(conn.key === "ok" ? "eventsObserved" : conn.key === "warn" ? "connWarn" : "connStandby");
        const season = state?.season || null;
        const seasonCount = season ? seasonCountdown(season, t) : null;
        const seasonTitle = season
          ? [seasonLabelOf(season, t), seasonCount, `${t("seasonBeijingNow")} ${season.beijing?.weekday || ""} ${season.beijing?.clock || ""}`.trim(),
            seasonUsesBeijingNote() ? t("seasonBeijingOnly") : null].filter(Boolean).join(" · ")
          : "";
        // 卡片上的可见文字只留数据；完整状态（今日口径、连接、峰谷成因）进 aria/title。
        const title = [name, metric.text, resetText, seasonTitle, failure, t("todayScope"), t("today", { n: state ? fmtBig(todayTotal(state)) : "—" }), connText].filter(Boolean).join(" · ");
        return h(React.Fragment, null,
          !wide ? h("button", { type: "button", ref: entryRef, "data-qm-entry": "", className: "qm-rail", "aria-label": t("title"), "aria-haspopup": "dialog", "aria-expanded": !!panel.host, title, onClick: activateEntry }, "◉") :
          h("div", { "data-qm-linerow": "", "data-qm-density": compact ? "compact" : "expanded", ref: widthRef, className: "qm-footer" },
            h("button", { type: "button", ref: entryRef, "data-qm-entry": "", className: "qm-card-body",
              "aria-haspopup": "dialog", "aria-expanded": !!panel.host, title, "aria-label": title, onClick: activateEntry },
              compact ? null : h("div", { className: "qm-head" },
                h("div", { className: "qm-l1" },
                  h("b", { className: "qm-plan" }, name),
                  failure ? h("span", { className: "qm-fetch-status" }, failure) : null,
                  supplier ? h("span", { className: "qm-today-chip" }, t("todayShort", { n: fmtBig(todayCount) })) : null)),
              compact ? h("div", { className: "qm-compact-line" }, h("span", { className: "qm-provider" }, name),
                h("span", { className: "qm-primary" },
                  h("span", { className: "qm-metric-name" }, failure || [metric.name, metric.kind === "quota" ? t("usedShort") : metric.label].filter(Boolean).join(" ")),
                  h("strong", { className: "qm-metric-value" }, metric.value),
                  metric.more > 0 ? h("span", { className: "qm-more", title: t("moreMetrics", { n: metric.more }) }, `+${metric.more}`) : null)) :
              h(React.Fragment, null,
                bars.length ? h("div", { className: "qm-bars" }, bars.flatMap((bar, i) => [
                  h("span", { key: `l${i}`, className: "qm-bar-label", title: bar.entry.name }, bar.label),
                  h("span", { key: `b${i}`, className: "qm-bar", "data-qm-bar": "", "data-qm-tone": bar.tone, "data-qm-window": bar.weekly ? "week" : "other",
                    role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": bar.entry.pct,
                    "aria-label": t("barAria", { name: bar.entry.name, pct: pctText(bar.entry.pct) }) },
                    h("i", { className: `qm-bar-fill ${bar.tone}`, style: { width: `${Math.max(0, Math.min(100, bar.entry.pct))}%` } })),
                  h("span", { key: `p${i}`, className: "qm-bar-pct" }, pctText(bar.entry.pct)),
                  bar.reset ? h("span", { key: `r${i}`, className: "qm-bar-reset" }, bar.reset) : null,
                ])) : h("div", { className: "qm-l2" }, h("span", { className: "qm-primary", title: metric.text }, metric.text)),
                season ? h("div", { className: `qm-season ${season.peak ? "peak" : "valley"}`, "data-qm-season": season.tier, title: seasonTitle },
                  h("span", { className: `qm-season-dot ${season.peak ? "peak" : "valley"}` }),
                  h("b", null, seasonTierOf(season, t)),
                  seasonCount ? h("span", { className: "qm-season-meta" }, seasonCount) : null) : null)),
            h("button", { type: "button", className: "qm-density", "aria-label": t(compact ? "expand" : "collapse"), title: t(compact ? "expand" : "collapse"),
              onClick: () => preferences.set(compact ? "expanded" : "compact") }, compact ? "▾" : "▴")),
          panel.host === "dialog" ? createPortal(h(PanelHost, { t, host: "dialog", onClose: () => surface.close(), returnFocusRef: entryRef }), document.body) : null);
      }

      function FooterSlotWithSession(props) { return h(FooterWidget, props); }

      function InfoHint({ t, text }) {
        if (!text) return null;
        return h("details", { className: "qm-info" },
          h("summary", { "aria-label": t("moreInfo"), title: t("moreInfo") }, "ⓘ"),
          h("p", null, text));
      }

      function Empty({ text, action, onAction }) {
        return h("div", { className: "qm-empty" },
          h("p", null, text),
          action ? h("button", { type: "button", onClick: onAction }, action) : null);
      }

      // ---------- 唯一面板：dialog（卡片）与 page（宿主设置）共用同一内容 ----------
      function PanelHost({ t, host, onClose, returnFocusRef }) {
        return h(Panel, { t, host, onClose, returnFocusRef });
      }

      function Panel({ t, host, onClose, returnFocusRef }) {
        const { state, loadError, refresh, refreshing, sessionKey } = useQuotaState();
        const snap = useSurface();
        const [expandedId, setExpandedId] = React.useState(null);
        // 没有本地用量行的供应商不画图，也就不必为它取额度历史。
        const expandedSupplier = (state?.suppliers || []).find((sup) => sup.id === expandedId);
        const quota = useQuotaHistory(sessionKey, Array.isArray(expandedSupplier?.usageDays) && expandedSupplier.usageDays.length > 0);
        const dialog = host === "dialog";
        // Escape / 外部点击必须走 controller 的未保存确认；useDialog 只拿到这个稳定转发器。
        const closeRef = React.useRef(() => {});
        const dialogRef = useDialog(() => closeRef.current(), returnFocusRef, dialog);
        const ctl = usePanelController({ t, state, loadError, refresh, refreshing, sessionKey, host, onClose, snap, dialogRef });
        closeRef.current = ctl.requestClose;
        React.useEffect(() => { setExpandedId(null); }, [sessionKey]);
        const refreshAll = () => { void refresh(); if (quota.payload) quota.reload(); };
        const card = h("div", { ref: dialogRef, tabIndex: -1,
          ...(dialog ? { role: "dialog", "aria-modal": true, "aria-label": t("title") } : {}),
          className: `qm-card qm-settings${dialog ? "" : " qm-settings-page"}` },
          h("div", { className: "qm-panel-head" }, h("h3", { tabIndex: -1 }, t("title")),
            h("button", { type: "button", disabled: refreshing, onClick: refreshAll }, t(refreshing ? "refreshing" : "refresh")),
            dialog ? h("button", { type: "button", onClick: ctl.requestClose, "aria-label": t("close") }, t("close")) : null),
          h("div", { className: "qm-tabs", role: "tablist", "aria-label": t("title") }, ["overview", "suppliers"].map(name => h("button", {
            type: "button", role: "tab", key: name, "aria-selected": snap.tab === name || (name === "suppliers" && !!snap.editing), onClick: () => ctl.navigate(name) }, t(name)))),
          ctl.savedBanner,
          ctl.saveError ? h("div", { role: "alert", className: "ci-err" }, ctl.saveError) : null,
          state?.storageError ? h("div", { role: "alert", className: "ci-err" }, state.storageError) : null,
          loadError ? h("div", { role: "alert", className: "ci-err" }, `${t(state ? "staleFailure" : "unavailable")}：${loadError}`) : null,
          !state || snap.opening ? h("p", { role: "status" }, t(loadError ? "unavailable" : "loading")) :
            snap.editing ? h(SupplierEditor, { state, t, ctl }) :
              snap.tab === "suppliers" ? h(SuppliersView, { state, t, ctl }) :
                h(OverviewView, { state, t, quota, expandedId, onExpand: setExpandedId, onEdit: ctl.openSupplier, onManage: () => ctl.navigate("suppliers") }),
          ctl.confirmation ? h("div", { role: "alertdialog", "aria-label": t("unsaved"), className: "qm-confirm" },
            h("p", null, t("unsaved")), h("button", { type: "button", autoFocus: true, onClick: () => ctl.setConfirmation(null) }, t("keepEditing")),
            h("button", { type: "button", onClick: () => { const action = ctl.confirmation; ctl.setConfirmation(null); action(); } }, t("discard"))) : null);
        return dialog ? h("div", { className: "qm-overlay", onClick: (ev) => ev.target === ev.currentTarget && ctl.requestClose() }, card) : card;
      }

      function usePanelController({ t, state, loadError, refresh, refreshing, host, onClose, snap, dialogRef }) {
        const [globalForm, setGlobalLocal] = React.useState(panelSession.globalForm);
        const [editor, setEditorLocal] = React.useState(panelSession.editor);
        const [confirmation, setConfirmation] = React.useState(null);
        const [advanced, setAdvanced] = React.useState(false);
        const [testState, setTestState] = React.useState({});
        const [saved, setSaved] = React.useState(null);
        const [saveError, setSaveError] = React.useState(null);
        const [scanBusy, setScanBusy] = React.useState(false);
        const [freshIds, setFreshIds] = React.useState([]);
        const [testBusy, setTestBusy] = React.useState(null);
        const [toggling, setToggling] = React.useState({});
        const opRef = React.useRef({ editorId: panelSession.editorId, opSeq: 0, revision: editor?.revision || 0 });
        const testSeq = React.useRef(0);
        const mountedRef = React.useRef(true);
        const togglingRef = React.useRef(new Set());
        const advancedRef = React.useRef(null);

        const setEditor = (next) => setEditorLocal(old => { const value = typeof next === "function" ? next(old) : next; panelSession.editor = value; return value; });
        const setGlobalForm = (next) => setGlobalLocal(old => { const value = typeof next === "function" ? next(old) : next; panelSession.globalForm = value; return value; });
        const comparable = form => ({ ...form, warnPct: Number(form.warnPct), critPct: Number(form.critPct) });
        const dirty = !!editor && JSON.stringify(comparable(editor.form)) !== JSON.stringify(comparable(editor.initial));
        const globalDirty = !!globalForm && (Number(globalForm.intervalSeconds) !== (state?.poll?.intervalSeconds ?? 60)
          || Number(globalForm.retentionDays) !== (state?.poll?.retentionDays ?? 7)
          || holidaysTextOf(globalForm.holidays) !== holidaysTextOf(state?.holidays));
        const guarded = (action, all = false) => { if (dirty || (all && globalDirty)) setConfirmation(() => action); else action(); };
        const requestClose = () => guarded(onClose, true);
        const scrollContainer = () => {
          let node = dialogRef.current;
          while (node) {
            if (/(auto|scroll)/.test(window.getComputedStyle?.(node).overflowY || "")) return node;
            node = node.parentElement;
          }
          return document.scrollingElement || dialogRef.current;
        };
        const viewKey = snap.editing ? "supplier" : snap.tab;
        const rememberPosition = () => { panelSession.positions[viewKey] = scrollContainer()?.scrollTop || 0; };
        const navigate = (name) => {
          rememberPosition();
          if (name === "suppliers" && editor) { surface.editSupplier(editor.supplierId); return; }
          surface.showTab(name);
        };

        React.useEffect(() => {
          const session = panelSession;
          mountedRef.current = true;
          return () => {
            mountedRef.current = false;
            if (host === "dialog" && surface.getSnapshot().host === "dialog" && panelSession === session) surface.close();
          };
        }, []);
        // 原生设置分区接管时继承同一保存锁；结算只影响同一编辑身份。
        const inheritedSave = panelSession.pendingSave?.editorId === panelSession.editorId ? panelSession.pendingSave : null;
        const [opBusy, setOpBusy] = React.useState(!!inheritedSave);
        const opBusyRef = React.useRef(!!inheritedSave);
        React.useEffect(() => {
          const pending = inheritedSave;
          if (!pending) return;
          const editorId = editor?.editorId ?? opRef.current.editorId;
          pending.promise.then(result => {
            if (!mountedRef.current || opRef.current.editorId !== editorId) return;
            opBusyRef.current = false; setOpBusy(false);
            if (!result.ok) { setSaveError(result.error); setAdvanced(true); return; }
            setSaved(pending.supplierId || "global");
            if (pending.supplierId && panelSession.editor?.editorId === editorId) {
              if (surface.getSnapshot().editing) surface.showTab(panelSession.editor.origin || "suppliers");
              setEditor(null); nextEditorId();
            }
          });
        }, []);
        React.useEffect(() => { if (editor) { opRef.current.editorId = editor.editorId; opRef.current.revision = editor.revision; } }, []);
        React.useEffect(() => { if (state && !snap.opening && !globalForm) setGlobalForm({ intervalSeconds: state.poll?.intervalSeconds ?? 60, retentionDays: state.poll?.retentionDays ?? 7, holidays: holidaysTextOf(state.holidays ?? []) }); }, [state, snap.opening]);
        React.useLayoutEffect(() => { const node = scrollContainer(); if (node) node.scrollTop = panelSession.positions[viewKey] || 0; }, [viewKey]);
        React.useEffect(() => { if (snap.focus) dialogRef.current?.querySelector("h3")?.focus(); }, [snap.focus]);

        const nextEditorId = () => { const id = ++opRef.current.editorId; panelSession.editorId = id; opRef.current.revision = 0; return id; };
        const discardEditor = () => {
          const origin = editor?.origin || "suppliers";
          nextEditorId(); testSeq.current++; setTestBusy(null); opBusyRef.current = false; setOpBusy(false); setEditor(null); surface.showTab(origin); setSaveError(null);
        };
        const closeEditor = () => guarded(discardEditor);
        const beginSave = (supplierId, trackOnly = false) => {
          const session = panelSession;
          let resolve;
          const promise = new Promise(done => { resolve = done; });
          const pending = { supplierId, promise, editorId: opRef.current.editorId };
          if (!trackOnly) session.pendingSave = pending;
          settingsWrites.add(pending);
          return result => {
            if (session.pendingSave === pending) session.pendingSave = null;
            settingsWrites.delete(pending); resolve(result); surface.bump();
          };
        };
        const reload = React.useCallback(() => displayController.reload(), []);
        const openSupplier = (id) => {
          const sup = (state?.suppliers || []).find((s) => s.id === id);
          if (!sup) return;
          if (editor?.supplierId === id) { surface.editSupplier(id); return; }
          if (dirty) { setConfirmation(() => () => { setEditor(null); enterSupplier(sup); }); return; }
          enterSupplier(sup);
        };
        const enterSupplier = (sup) => {
          const id = sup.id;
          const pending = [...settingsWrites].find(operation => operation.supplierId === id);
          if (pending) {
            const identity = nextEditorId();
            setEditor(null); surface.editSupplier(id);
            void pending.promise.then(async () => {
              await reload();
              if (!mountedRef.current || opRef.current.editorId !== identity || surface.getSnapshot().editing !== id) return;
              const savedSup = displayController.getSnapshot().state?.suppliers?.find(s => s.id === id);
              if (savedSup) openSupplierClean(savedSup);
            });
            return;
          }
          openSupplierClean(sup);
        };
        const openSupplierClean = (sup) => {
          rememberPosition();
          const form = supplierDraft(sup);
          const editorId = nextEditorId();
          setEditor({ editorId, supplierId: sup.id, form, initial: { ...form }, origin: surface.getSnapshot().tab === "overview" ? "overview" : "suppliers", revision: 0 });
          setAdvanced(false);
          surface.editSupplier(sup.id);
          testSeq.current++;
          setTestState({});
          setTestBusy(null);
          setSaved(null);
          setSaveError(null);
          setOpBusy(false);
          opBusyRef.current = false;
        };
        const setEditorField = (key, value) => {
          opRef.current.revision++;
          testSeq.current++;
          setTestBusy(null);
          setSaved(null);
          setTestState((x) => {
            if (!editor || !(editor.supplierId in x)) return x;
            const next = { ...x };
            delete next[editor.supplierId];
            return next;
          });
          setEditor((e) => (e ? { ...e, form: { ...e.form, [key]: value }, revision: opRef.current.revision } : e));
        };
        const saveGlobal = async () => {
          if (!globalForm || opBusyRef.current || [...settingsWrites].some(operation => operation.supplierId === null)) return;
          const interval = Number(globalForm.intervalSeconds), retention = Number(globalForm.retentionDays);
          if (!Number.isFinite(interval) || interval < 10 || interval > 3600 || !Number.isFinite(retention) || retention < 1 || retention > 90) { setSaveError(t("invalidGlobal")); return; }
          const holidays = parseHolidayText(globalForm.holidays);
          const invalid = holidays.filter((day) => !isValidHolidayDay(day));
          if (invalid.length) { setSaveError(t("invalidHolidays", { list: invalid.slice(0, 3).join("、") })); return; }
          const editorId = opRef.current.editorId, seq = ++opRef.current.opSeq;
          const latest = () => mountedRef.current && opRef.current.editorId === editorId && opRef.current.opSeq === seq;
          const finish = beginSave(null);
          let outcome = { ok: false, error: t("unavailable") };
          opBusyRef.current = true; setOpBusy(true);
          setSaved(null); setSaveError(null);
          try {
            await post(`${API}/settings`, {
              intervalSeconds: Number(globalForm.intervalSeconds),
              retentionDays: Number(globalForm.retentionDays),
              holidays,
            });
            await reload();
            outcome = { ok: true };
            if (!latest()) return;
            setSaved("global");
          } catch (error) {
            outcome = { ok: false, error: error.message };
            if (!latest()) return;
            setSaveError(error.message);
            console.error("[dsh-token-quota] global settings save failed", error);
          } finally { finish(outcome); if (latest()) { opBusyRef.current = false; setOpBusy(false); } }
        };
        const saveSupplier = async () => {
          if (!editor || opBusyRef.current || [...settingsWrites].some(operation => operation.supplierId === editor.supplierId)) return;
          const { editorId, supplierId, form, origin } = editor;
          const sup = (state?.suppliers || []).find((s) => s.id === supplierId);
          if (!sup) return;
          const warn = Number(form.warnPct), crit = Number(form.critPct);
          if (!Number.isFinite(warn) || !Number.isFinite(crit) || warn < 1 || warn >= crit || crit > 100) {
            setSaveError(t("invalidThreshold")); setAdvanced(true);
            requestAnimationFrame(() => advancedRef.current?.querySelector('input[type="number"]')?.focus()); return;
          }
          const seq = ++opRef.current.opSeq;
          const latest = () => mountedRef.current && opRef.current.editorId === editorId && opRef.current.opSeq === seq;
          const finish = beginSave(supplierId);
          let outcome = { ok: false, error: t("unavailable") };
          setSaved(null); setSaveError(null);
          opBusyRef.current = true;
          setOpBusy(true);
          try {
            const p = supplierPatch(sup, form);
            await post(`${API}/settings`, { suppliers: { [supplierId]: p } });
            await reload();
            outcome = { ok: true };
            if (!latest()) return;
            setSaved(supplierId);
            opBusyRef.current = false;
            setOpBusy(false);
            if (surface.getSnapshot().editing) surface.showTab(origin || "suppliers");
            setEditor(null);
            nextEditorId();
          } catch (error) {
            outcome = { ok: false, error: error.message };
            if (!latest()) return;
            setSaveError(error.message);
            setAdvanced(true);
            requestAnimationFrame(() => advancedRef.current?.querySelector("input")?.focus());
            console.error("[dsh-token-quota] supplier settings save failed", error);
          } finally {
            finish(outcome);
            if (opRef.current.editorId === editorId && opRef.current.opSeq === seq) {
              opBusyRef.current = false;
              if (mountedRef.current) setOpBusy(false);
            }
          }
        };
        const toggleEnabled = async (sup) => {
          if (togglingRef.current.has(sup.id) || [...settingsWrites].some(operation => operation.supplierId === sup.id)) return;
          const finish = beginSave(sup.id, true);
          let outcome = { ok: false, error: t("unavailable") };
          togglingRef.current.add(sup.id);
          setToggling((x) => ({ ...x, [sup.id]: true }));
          setSaveError(null);
          try {
            await post(`${API}/settings`, { suppliers: { [sup.id]: { enabled: !sup.enabled } } });
            await reload();
            outcome = { ok: true };
          } catch (error) {
            outcome = { ok: false, error: error.message };
            if (!mountedRef.current) return;
            setSaveError(error.message);
            console.error("[dsh-token-quota] enable toggle failed", error);
          } finally {
            finish(outcome);
            togglingRef.current.delete(sup.id);
            if (mountedRef.current) setToggling((x) => ({ ...x, [sup.id]: false }));
          }
        };
        const runTest = (id) => {
          const sup = (state?.suppliers || []).find((s) => s.id === id);
          const editing = editor?.supplierId === id ? editor : null;
          const editorId = editing ? opRef.current.editorId : null;
          const revision = editing ? opRef.current.revision : null;
          const config = editing ? supplierPatch(sup, editing.form) : undefined;
          const seq = ++testSeq.current;
          setTestState((x) => ({ ...x, [id]: t("testing") }));
          setTestBusy(id);
          const stillCurrent = () => mountedRef.current && seq === testSeq.current
            && (!editing || opRef.current.editorId === editorId && opRef.current.revision === revision);
          post(`${API}/test`, { supplier: id, config })
            .then((r) => { if (stillCurrent()) setTestState((x) => ({ ...x, [id]: r })); })
            .catch((error) => { if (stillCurrent()) setTestState((x) => ({ ...x, [id]: { ok: false, error: error.message } })); })
            .finally(() => { if (mountedRef.current && seq === testSeq.current) setTestBusy(null); });
        };
        const runRescan = async () => {
          if (scanBusy) return;
          const prevAddable = new Set((state?.suppliers || []).filter((s) => s.added === false).map((s) => s.id));
          setScanBusy(true);
          try {
            const next = await post(`${API}/rescan`);
            if (!next || next.ok === false) throw new Error((next && next.error) || "rescan failed");
            if (!mountedRef.current) return;
            await reload();
            const nowAddable = (next.suppliers || []).filter((s) => s.added === false);
            setFreshIds(nowAddable.filter((s) => !prevAddable.has(s.id)).map((s) => s.id));
          } catch (error) {
            if (!mountedRef.current) return;
            setSaveError(t("scanLineFail", { err: error.message }));
            console.error("[dsh-token-quota] rescan failed", error);
            await reload();
          } finally {
            if (mountedRef.current) setScanBusy(false);
          }
        };
        const globalBusy = opBusy || [...settingsWrites].some(operation => operation.supplierId === null);
        return {
          view: snap.editing ? { name: "supplier", id: snap.editing } : { name: snap.tab },
          editor, globalForm, dirty, globalDirty, confirmation, advanced, testState, testBusy, saved, saveError,
          scanBusy, freshIds, opBusy, globalBusy, toggling, advancedRef, setConfirmation, setAdvanced,
          navigate, openSupplier, closeEditor, setEditorField, setGlobalForm, saveGlobal, saveSupplier, runTest, runRescan, toggleEnabled,
          requestClose, reload,
          savedBanner: saved ? h("div", { className: "s-saved", style: { marginBottom: 8 } }, t("saved")) : null,
        };
      }

      // ---------- 概览：供应商行 + 展开明细 ----------
      function OverviewView({ state, t, quota, expandedId, onExpand, onEdit, onManage }) {
        const suppliers = (state.suppliers || []).filter(s => s.added !== false).sort((a, b) =>
          Number(b.id === state.active?.supplierId) - Number(a.id === state.active?.supplierId) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
        const attention = s => s.state === "err" || (s.enabled !== false && ["stateWarn", "stateCrit"].includes(stateToken(s)));
        const [filter, setFilter] = React.useState("all");
        const shown = filter === "all" ? suppliers : suppliers.filter(attention);
        const quotaOf = (id) => (quota.payload?.suppliers || []).find((sup) => sup.id === id)?.quotaHistory || {};
        return h(React.Fragment, null,
          h("div", { className: "qm-overview-head" },
            h("span", { className: "qm-today-total" }, h("span", null, t("todayLabel")), h("b", null, fmtBig(todayTotal(state))), h("span", null, "tokens"),
              h(InfoHint, { t, text: t("todayScope") })),
            h("div", { className: "qm-filter", role: "group", "aria-label": t("overview") },
              ["all", "attention"].map(key => h("button", { key, type: "button", "aria-pressed": filter === key, onClick: () => setFilter(key) },
                t(key), h("span", { className: "qm-count" }, key === "all" ? suppliers.length : suppliers.filter(attention).length))))),
          shown.length
            ? h("div", { className: "qm-rows" }, shown.map(sup => h(SupplierRow, {
              key: sup.id, sup, t, season: state.season, quota: quotaOf(sup.id),
              expanded: expandedId === sup.id, onToggle: () => onExpand(expandedId === sup.id ? null : sup.id), onEdit })))
            : h(Empty, { text: t(filter === "attention" ? "noAttention" : "overviewEmpty"), action: filter === "all" ? t("manageSuppliers") : null, onAction: onManage }),
          h(HistoryTable, { rows: (state.history || []).slice(0, 50), t }));
      }

      function SupplierRow({ sup, t, season, quota, expanded, onToggle, onEdit }) {
        const metric = selectPrimaryMetric(sup, t);
        const todayNumber = typeof sup.todayTokens === "number" ? sup.todayTokens : 0;
        const error = String(sup.error?.message || sup.error?.code || "");
        const detailId = `qm-detail-${sup.id}`;
        return h("article", { className: `qm-row${expanded ? " open" : ""}`, "data-supplier": sup.id },
          h("button", { type: "button", className: "qm-row-head", "data-qm-row": "", "aria-expanded": expanded, "aria-controls": detailId, onClick: onToggle },
            h("span", { className: `qm-dot ${stateClass(sup)}` }),
            h("b", { className: "qm-row-name" }, sup.name),
            sup.current ? h("span", { className: "qm-cur" }, t("current")) : null,
            h("span", { className: `qm-pill ${stateClass(sup)}` }, supplierStatus(sup, t)),
            h("span", { className: "qm-row-metric" }, metric.value),
            h("span", { className: "qm-row-today" }, `${t("todayLabel")} ${fmtBig(todayNumber)}`),
            h("span", { className: "qm-chevron", "aria-hidden": "true" }, expanded ? "▴" : "▾")),
          expanded ? h("div", { id: detailId, className: "qm-row-detail", role: "region", "aria-label": `${sup.name} ${t("detailTitle")}` },
            sup.state === "err" ? h("div", { className: "ci-err", role: "status" }, supplierStatus(sup, t), error ? `：${error.slice(0, 180)}` : "",
              error.length > 180 ? h("details", null, h("summary", null, t("errorDetails")), h("p", null, error)) : null) : null,
            sup.lastSuccessAt ? h("div", { className: "qm-data-time" }, `${t("lastSuccess")} ${new Date(sup.lastSuccessAt).toLocaleString()}`) : null,
            h(MetricTable, { supplier: sup, t }),
            h(TodayLine, { sup, t }),
            h(UsageSplit, { usage: sup.todayUsage, t }),
            h(SeasonBlock, { season, split: sup.seasonSplit, t }),
            h("div", { className: "qm-row-actions" }, h("button", { type: "button", onClick: () => onEdit(sup.id) }, t("openPage"))),
            Array.isArray(sup.usageDays) && sup.usageDays.length
              ? h(UsageChart, { sup, days: sup.usageDays, quota, windowTotal: sup.usageDays.reduce((sum, day) => sum + (Number(day?.total) || 0), 0), t })
              : null) : null);
      }

      function MetricTable({ supplier, t }) {
        const groups = metricRowsOf(supplier, t);
        if (!groups.length) return h("div", { className: "qm-empty-line" }, t("notQueried"));
        return h("div", { className: "qm-metric-tables" }, groups.map((group) =>
          h("table", { key: group.kind, className: "qm-metric-table", "aria-label": t(group.titleKey) },
            h("thead", null, h("tr", null, group.columns.map((column) => h("th", { key: column.key, scope: "col" }, t(column.labelKey))))),
            h("tbody", null, group.rows.map((row) =>
              h("tr", { key: row.key, title: row.aria },
                h("th", { scope: "row" }, row.name),
                group.columns.slice(1).map((column) =>
                  h("td", { key: column.key, className: column.key === "used" ? `qm-tone ${row.tone}` : column.key === "value" ? "qm-num" : "" }, row[column.key] ?? "—"))))))));
      }

      function TodayLine({ sup, t }) {
        const total = fmtBig(typeof sup.todayTokens === "number" ? sup.todayTokens : 0);
        const ratio = usageRatioOf(sup.todayUsage);
        const detailText = ratio ? t("ratioAria", { hit: fmtBig(ratio.hitValue), miss: fmtBig(ratio.missValue), out: fmtBig(ratio.outValue) }) : "";
        return h("div", { className: "qm-today-line" },
          h("span", { className: "qm-today-text" }, t("today", { n: total })),
          ratio ? h("span", { className: "qm-ratio", title: detailText },
            h("b", { className: "r-hit" }, ratio.hit), " : ", h("b", { className: "r-miss" }, ratio.miss), " : ", h("b", { className: "r-out" }, ratio.out)) : null);
      }

      /** 五分量分布：条与图例一一对应；今日比例只取前三项，写缓存与未细分在这里出现。 */
      function UsageSplit({ usage, t }) {
        const parts = splitPartsOf(usage);
        const total = parts.reduce((sum, part) => sum + part.value, 0);
        if (!total) return null;
        return h("div", { className: "qm-usage-split" },
          h("span", { className: "qm-split-bar qm-split-lg" }, parts.map((part) =>
            h("i", { key: part.key, className: `seg-${part.cls}`, style: { width: `${(part.value / total) * 100}%` } }))),
          h("div", { className: "qm-usage-legend" }, parts.map((part) =>
            h("span", { key: part.key }, h("i", { className: `seg-${part.cls}` }), `${t(part.label)} ${fmtBig(part.value)}`))));
      }

      function SeasonBlock({ season, split, t }) {
        if (!season || !split) return null;
        const peak = Number(split.peakTokens) || 0;
        const valley = Number(split.valleyTokens) || 0;
        const unknown = Number(split.unknownTokens) || 0;
        const total = peak + valley + unknown;
        if (total <= 0) return null;
        const pct = (value) => `${Math.round((value / total) * 100)}%`;
        return h("div", { className: "qm-season-block", "data-qm-season-block": season.tier },
          h("div", { className: "qm-kv" }, h("span", null, t("seasonTier")), h("span", null, seasonLabelOf(season, t))),
          h("div", { className: "qm-kv" }, h("span", null, t("seasonNext")), h("span", null, seasonCountdown(season, t) || "—")),
          season.beijing && seasonUsesBeijingNote() ? h("div", { className: "qm-kv" }, h("span", null, t("seasonBeijingNow")), h("span", null, `${season.beijing.weekday} ${season.beijing.clock}`)) : null,
          h("div", { className: "qm-split-stats" },
            peak > 0 ? h("span", { className: "qm-split-stat" }, h("i", { className: "seg-warn" }), t("seasonSplitPeak", { n: fmtBig(peak), pct: pct(peak) })) : null,
            valley > 0 ? h("span", { className: "qm-split-stat" }, h("i", { className: "seg-ok" }), t("seasonSplitValley", { n: fmtBig(valley), pct: pct(valley) })) : null,
            unknown > 0 ? h("span", { className: "qm-split-stat" }, h("i", { className: "seg-unsplit" }), t("seasonSplitUnknown", { n: fmtBig(unknown) })) : null));
      }

      // ---------- 供应商页：目录 + 全局设置 + 可添加 ----------
      function SuppliersView({ state, t, ctl }) {
        const all = state.suppliers || [];
        const added = all.filter((s) => s.added !== false).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
        const addable = all.filter((s) => s.added === false).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
        const det = state.detect || {};
        const density = useDensity();
        const [addableOpen, setAddableOpen] = React.useState(false);
        const [globalOpen, setGlobalOpen] = React.useState(!!state.season?.warning);
        React.useEffect(() => { if (ctl.freshIds.length) setAddableOpen(true); }, [ctl.freshIds]);
        React.useEffect(() => { if (state.season?.warning) setGlobalOpen(true); }, [state.season?.warning]);
        const scanLine = () => {
          const time = det.at ? String(det.at) : null;
          if (ctl.scanBusy) return h("span", null, t("scanLineBusy"));
          if (det.error) return h("span", { className: "err", title: String(det.error).slice(0, 300) },
            t("scanLineFail", { err: String(det.error || "").slice(0, 60) }), time ? ` · ${time}` : "");
          if (!det.at) return h("span", null, t("scanLineIdle"));
          return h("span", null, h("b", { className: "ok" }, t("connectedChip", { n: added.length })), time ? ` · ${time}` : "");
        };
        return h(React.Fragment, null,
          h("div", { className: "qm-pages-title qm-head-b" },
            h("b", null, t("supplierPages")),
            h("div", { className: "qm-title-actions" },
              h("span", { className: "chip" }, t("connectedChip", { n: added.length })),
              h("button", { type: "button", className: `qm-rescan-btn${ctl.scanBusy ? " busy" : ""}`, disabled: ctl.scanBusy, onClick: ctl.runRescan }, `⟳ ${t("rescan")}`))),
          h("div", { className: "qm-scanline" }, scanLine()),
          added.length ? orderedRows(added, t, ctl) : h(Empty, { text: t("emptyAdded"), action: t("rescan"), onAction: ctl.runRescan }),
          addable.length ? h("details", { className: "qm-addable", open: addableOpen, onToggle: (e) => setAddableOpen(e.currentTarget.open) },
            h("summary", null, h("span", null, t("addableTitle")), h("span", { className: "cnt" }, addable.length)),
            h("div", { className: "addable-list" }, addable.map((a) => h("div", { key: a.id, className: `qm-add-row${ctl.freshIds.includes(a.id) ? " fresh" : ""}` },
              h("span", { className: `qm-dot ${stateClass(a)}` }),
              h("span", { className: "qm-page-name" }, a.name),
              h("span", { className: "qm-page-pill" }, t(a.meta?.credentialLabelKey || "apiKey")),
              h("button", { type: "button", className: "s-test qm-pri-soft", onClick: () => ctl.openSupplier(a.id) }, t("openPage")))))) : null,
          state.detectedUnmapped && state.detectedUnmapped.length
            ? h("div", { className: "qm-unmapped", title: state.detectedUnmapped.map((u) => `${u.displayName || u.route}${u.detail ? t("unmappedDetail", { detail: u.detail }) : ""}`).join("、") },
              `${t("unmapped")} ${state.detectedUnmapped.length}`) : null,
          state.season?.warning ? h("div", { className: "qm-season-warn", role: "status" }, state.season.warning) : null,
          h("details", { className: "s-group qm-global", open: globalOpen, onToggle: (e) => setGlobalOpen(e.currentTarget.open) },
            h("summary", null, t("global")),
            h("div", { className: "s-grid" },
              h("label", null, t("interval"), h("input", { type: "number", min: 10, max: 3600, value: ctl.globalForm?.intervalSeconds ?? 60, disabled: ctl.globalBusy, onChange: (e) => ctl.setGlobalForm((g) => ({ ...g, intervalSeconds: e.target.value })) })),
              h("label", null, t("retention"), h("input", { type: "number", min: 1, max: 90, value: ctl.globalForm?.retentionDays ?? 7, disabled: ctl.globalBusy, onChange: (e) => ctl.setGlobalForm((g) => ({ ...g, retentionDays: e.target.value })) }))),
            h("label", { className: "qm-holidays" }, h("span", null, t("holidaysLabel"), h(InfoHint, { t, text: t("holidaysHint") })),
              h("textarea", { rows: 4, spellCheck: false, placeholder: t("holidaysPlaceholder"), "aria-label": t("holidaysLabel"), disabled: ctl.globalBusy,
                value: ctl.globalForm?.holidays ?? "", onChange: (e) => ctl.setGlobalForm((g) => ({ ...g, holidays: e.target.value })) })),
            h("div", { className: "s-row", style: { justifyContent: "flex-end" } },
              h("button", { type: "button", className: "qm-pri", disabled: ctl.globalBusy, onClick: ctl.saveGlobal }, t("save")))),
          h("div", { className: "qm-display-row" },
            h("span", null, t("sidebarDisplay"), h(InfoHint, { t, text: t("browserOnly") })),
            h("select", { "aria-label": t("sidebarDisplay"), value: density, onChange: e => preferences.set(e.target.value) },
              h("option", { value: "expanded" }, t("expanded")), h("option", { value: "compact" }, t("compact")))));
      }

      function orderedRows(added, t, ctl) {
        return h("div", { className: "qm-page-list" }, added.map((sup) =>
          h("div", { key: sup.id, "data-supplier": sup.id, className: "qm-page-row" },
            h("div", { className: "qm-page-main" },
              h("span", { className: `qm-dot ${stateClass(sup)}` }),
              h("span", { className: "qm-page-name", title: sup.meta?.compat ? t("compatSource") : undefined }, sup.name),
              h("span", { className: "qm-row-metric" }, selectPrimaryMetric(sup, t).value),
              h("span", { className: `qm-pill ${stateClass(sup)}` }, supplierStatus(sup, t)),
              h("span", { className: "qm-page-pill" }, t(sup.meta?.credentialLabelKey || "apiKey"))),
            h("div", { className: "qm-page-actions" },
              h("label", { className: "qm-page-toggle" },
                h("input", { type: "checkbox", checked: !!sup.enabled, disabled: !!ctl.toggling[sup.id] || [...settingsWrites].some(operation => operation.supplierId === sup.id), onChange: () => ctl.toggleEnabled(sup) }),
                h("span", null, t("enable"))),
              h("button", { type: "button", className: "s-test qm-pri-soft", onClick: () => ctl.openSupplier(sup.id) }, t("openPage"))))));
      }

      // ---------- 供应商配置子页 ----------
      function needsLabel(sup, need, t) {
        if (need.key === "apiKey") return t(sup.meta?.credentialLabelKey || "apiKey");
        if (need.key === "allowanceToken") return t("allowanceToken");
        if (need.key === "orgId") return t("orgId");
        return need.label || need.key;
      }
      function secretPlaceholder(sup, need, t) {
        if (sup[`${need.key}Set`]) return t("keySet");
        if (need.key === "apiKey" && sup.apiKeyEnv) return sup.keyRefResolved ? t("keyRefResolved", { env: sup.apiKeyEnv }) : t("keyRefMissing", { env: sup.apiKeyEnv });
        if (need.key === "apiKey" && sup.autoDetected && sup.envKeySet) return t("keyAuto", { env: sup.autoEnvName || t("dshKey") });
        return t("keyEmpty");
      }
      function testResultOf(testState, id, t) {
        const result = testState[id];
        if (!result) return null;
        if (typeof result === "string") return h("span", { className: "s-test-res bad" }, result);
        return h("span", { className: `s-test-res ${result.ok ? "ok" : "bad"}` }, result.ok ? t("testOk") : (result.error || t("testFail")));
      }

      function SupplierEditor({ state, t, ctl }) {
        const sup = (state.suppliers || []).find((s) => s.id === ctl.view.id);
        const editor = ctl.editor;
        if (!sup || !editor) return h("div", { className: "qm-sub", role: "status" }, t("loading"));
        const f = editor.form;
        const needsInputs = (sup.meta?.needs || []).map((need) =>
          h("label", { key: need.key }, needsLabel(sup, need, t),
            h("input", {
              type: need.secret ? "password" : "text",
              placeholder: need.secret ? secretPlaceholder(sup, need, t) : t("keyEmpty"),
              value: f[need.key] || "",
              disabled: ctl.opBusy,
              onChange: (e) => ctl.setEditorField(need.key, e.target.value),
            })));
        return h(React.Fragment, null,
          h("div", { className: "qm-page-head" },
            h("button", { type: "button", className: "s-test", onClick: ctl.closeEditor }, `← ${t("back")}`),
            h("b", null, sup.name),
            h("label", { className: "qm-inline-toggle" },
              h("input", { type: "checkbox", checked: !!f.enabled, disabled: ctl.opBusy, onChange: (e) => ctl.setEditorField("enabled", e.target.checked) }),
              h("span", null, t("enable"))),
            h("span", { className: `qm-pill ${stateClass(sup)}` }, supplierStatus(sup, t)),
            h("span", { className: "qm-page-pill" }, t(sup.meta?.credentialLabelKey || "apiKey"))),
          h("div", { className: "s-group qm-quota-preview" },
            h("div", { className: "qm-section-head" }, h("h5", null, t("currentQuota")), h(InfoHint, { t, text: t("previewSaved") })),
            h(MetricTable, { supplier: sup, t })),
          h("div", { className: "s-group" },
            h("div", { className: "qm-section-head" }, h("h5", null, t("credentials")), h(InfoHint, { t, text: t("settingsSub") })),
            needsInputs,
            h("label", null, h("span", null, t("apiKeyEnv"), h(InfoHint, { t, text: t("apiKeyEnvHint") })),
              h("input", { type: "text", placeholder: t("apiKeyEnvPlaceholder"), value: f.apiKeyEnv || "", disabled: ctl.opBusy, onChange: (e) => ctl.setEditorField("apiKeyEnv", e.target.value) })),
            sup.apiKeyEnv && !sup.apiKeySet ? h("span", { className: "qm-ref-state" }, t(sup.keyRefResolved ? "keyRefResolved" : "keyRefMissing", { env: sup.apiKeyEnv })) : null),
          h(WatchedLimits, { supplier: sup, form: f, t, disabled: ctl.opBusy, onChange: (keys) => ctl.setEditorField("displayKeys", keys) }),
          h("details", { ref: ctl.advancedRef, className: "s-group qm-advanced", open: ctl.advanced, onToggle: e => ctl.setAdvanced(e.currentTarget.open) },
            h("summary", null, t("advanced")),
            h("label", null, t("baseUrl"), h("input", { type: "text", value: f.baseUrl || "", disabled: ctl.opBusy, onChange: (e) => ctl.setEditorField("baseUrl", e.target.value) })),
            h("div", { className: "s-grid" },
              h("label", null, t("warnPct"), h("input", { type: "number", min: 1, max: 99, value: f.warnPct, disabled: ctl.opBusy, onChange: (e) => ctl.setEditorField("warnPct", e.target.value) })),
              h("label", null, t("critPct"), h("input", { type: "number", min: 1, max: 100, value: f.critPct, disabled: ctl.opBusy, onChange: (e) => ctl.setEditorField("critPct", e.target.value) })))),
          h("div", { className: "s-row" },
            h("button", { type: "button", className: "s-test", disabled: ctl.opBusy || ctl.testBusy === sup.id, onClick: () => ctl.runTest(sup.id) }, ctl.testBusy === sup.id ? t("testing") : `⟳ ${t("test")}`),
            testResultOf(ctl.testState, sup.id, t)),
          h("div", { className: "s-actions" },
            ctl.saved === sup.id ? h("span", { className: "s-saved" }, t("saved")) : null,
            h("button", { type: "button", onClick: ctl.closeEditor, disabled: ctl.opBusy }, t("cancel")),
            h("button", { type: "button", className: "qm-pri", onClick: ctl.saveSupplier, disabled: ctl.opBusy }, t("save"))));
      }

      /** 关注限额：供应商卡片第 2 行画哪些条目（有序多选）。 */
      function WatchedLimits({ supplier, form, t, disabled, onChange }) {
        const available = (supplier.entries || []).filter((e) => e?.key && Number.isFinite(e?.pct));
        const byKey = new Map(available.map((e) => [e.key, e]));
        const watchedKeys = Array.isArray(form.displayKeys) ? form.displayKeys : [];
        const rows = [
          ...watchedKeys.map((key) => ({ key, entry: byKey.get(key) || null, watched: true })),
          ...available.filter((e) => !watchedKeys.includes(e.key)).map((e) => ({ key: e.key, entry: e, watched: false })),
        ];
        if (!rows.length) return null;
        const toggle = (key, on) => onChange(on ? [...watchedKeys, key] : watchedKeys.filter((k) => k !== key));
        const move = (index, delta) => {
          const target = index + delta;
          if (index < 0 || target < 0 || target >= watchedKeys.length) return;
          const next = [...watchedKeys];
          [next[index], next[target]] = [next[target], next[index]];
          onChange(next);
        };
        return h("div", { className: "s-group" },
          h("div", { className: "qm-section-head" }, h("h5", null, t("watchTitle")), h(InfoHint, { t, text: t("watchDefaultHint") })),
          watchedKeys.length ? null : h("p", { className: "qm-empty-line" }, t("watchDefaultShort")),
          h("div", { className: "qm-watch" }, rows.map(({ key, entry, watched }) => {
            const index = watchedKeys.indexOf(key);
            return h("div", { key, className: `w-row${watched ? " watched" : ""}${entry ? "" : " off"}` },
              h("input", { type: "checkbox", checked: watched, disabled, onChange: (e) => toggle(key, e.target.checked) }),
              h("span", { className: "w-name", title: entry?.name || key }, entry?.name || key),
              h("span", { className: "w-val" }, entry ? pctText(entry.pct) : t("watchUnavailable")),
              h("span", { className: "w-move" },
                h("button", { type: "button", disabled: disabled || index <= 0, "aria-label": t("moveUp"), title: t("moveUp"), onClick: () => move(index, -1) }, "↑"),
                h("button", { type: "button", disabled: disabled || index >= watchedKeys.length - 1, "aria-label": t("moveDown"), title: t("moveDown"), onClick: () => move(index, 1) }, "↓")));
          })));
      }

      function HistoryTable({ rows, t }) {
        if (!rows.length) return null;
        return h("details", { className: "qm-history" }, h("summary", { tabIndex: 0 }, t("historySummary", { n: rows.length })),
          h("div", { className: "qm-history-scroll", tabIndex: 0, role: "region", "aria-label": t("historySummary", { n: rows.length }) },
            h("table", null,
              h("thead", null, h("tr", null, ...["colTime", "colSupplier", "colTier", "colResult", "colMain", "colNote"].map(key => h("th", { key, scope: "col" }, t(key))))),
              h("tbody", null, rows.map((row, i) => h("tr", { key: i }, h("td", null, row.t), h("td", null, row.supplier),
                h("td", { className: row.tier === "peak" ? "h-peak" : row.tier === "valley" ? "h-valley" : "" },
                  row.tier === "peak" ? t("seasonPeak") : row.tier === "valley" ? t("seasonValley") : "—"),
                h("td", { className: row.ok ? "h-ok" : "h-bad" }, t(row.ok ? "colOk" : "colFail")), h("td", null, row.summary), h("td", null, row.error || "")))))));
      }

      /**
       * 一张图两套量纲：柱 = 每日 token 消耗（左轴，总量），线 = 各窗口剩余额度（右轴，固定 0–100%）。
       * 共用一条时间轴，所以「今天烧了多少」和「这个窗口还剩多少」能直接对着看。
       */
      function UsageChart({ sup, days, quota, windowTotal, t }) {
        const domain = chartDomainOf(days);
        const [cursor, setCursor] = React.useState(null);
        if (!domain) return null;
        const legend = quotaLegendOf(quota, sup.entries, t);
        const W = 600, H = 120, padL = 4, padR = 6, padT = 10, padB = 6;
        const plotW = W - padL - padR, plotH = H - padT - padB;
        const scaleX = (ms) => padL + plotW * Math.min(1, Math.max(0, (ms - domain.start) / (domain.end - domain.start)));
        const scaleY = (pct) => padT + plotH * (Math.max(0, Math.min(100, Number(pct) || 0)) / 100);
        const px = (ms) => `${((scaleX(ms) / W) * 100).toFixed(3)}%`;
        const py = (pct) => `${((scaleY(pct) / H) * 100).toFixed(3)}%`;
        const maxDay = Math.max(...days.map((day) => Number(day?.total) || 0), 1);
        /** 每日柱的几何：柱、标签、刻度共用同一套坐标，避免两处公式漂移。 */
        const dayBars = days.map((day, index) => {
          const start = dayStartOf(day?.day);
          if (!Number.isFinite(start)) return null;
          const end = Math.min(start + 24 * 3600_000, domain.end);
          const total = Math.max(0, Number(day?.total) || 0);
          const height = plotH * (total / maxDay);
          const x0 = scaleX(start), x1 = scaleX(end);
          return { day, index, total, height, x0, x1, x: x0 + 0.75, width: Math.max(0.5, x1 - x0 - 1.5) };
        }).filter(Boolean);
        const visibleBars = dayBars.filter((bar) => bar.height > 0);
        // 标签密度：最多 10 个；更长的窗口只标峰值那根，避免 30/90 天糊成一片
        const labeledBars = visibleBars.length <= 10 ? visibleBars : [visibleBars.slice(1).reduce(
          (best, bar) => (bar.total > best.total ? bar : best), visibleBars[0])];
        const summary = [
          `${t("statsWindow", { n: days.length })} token ${fmtBig(windowTotal)}`,
          legend.length ? legend.map((item) => `${item.label} ${t("remainLabel", { n: item.remaining })}`).join(" · ") : null,
        ].filter(Boolean).join("；");
        const cursorDay = cursor === null ? null : days.find((day) => {
          const start = dayStartOf(day?.day);
          return Number.isFinite(start) && cursor >= start && cursor < start + 24 * 3600_000;
        });
        const readout = cursor === null ? [] : legend.map((item) => {
          const used = quotaUsedAt(item.samples, cursor);
          return used === null ? null : { key: item.key, label: item.label, color: item.color, remaining: Math.round(100 - used) };
        }).filter(Boolean);
        const tipX = cursor === null ? 0 : (scaleX(cursor) / W) * 100;
        const sampleTimes = legend.flatMap((item) => item.samples.map(([at]) => at));
        const snap = (at) => {
          const limit = ((domain.end - domain.start) * 8) / plotW;
          let best = null, gap = Infinity;
          for (const time of sampleTimes) {
            const distance = Math.abs(time - at);
            if (distance < gap) { gap = distance; best = time; }
          }
          return best !== null && gap <= limit ? best : at;
        };
        return h("div", { className: "qm-chart" },
          h("div", { className: "qm-chart-cap" }, h("span", null, `${t("statsWindow", { n: days.length })} ${fmtBig(windowTotal)} token`)),
          h("div", {
            className: "qm-chart-plot", role: "img", "aria-label": summary, "data-qm-chart": sup.id, tabIndex: 0,
            onPointerMove: (ev) => {
              const box = ev?.currentTarget?.getBoundingClientRect?.();
              if (!box?.width) return;
              const ratio = Math.min(1, Math.max(0, (ev.clientX - box.left) / box.width));
              const stepped = Math.round(ratio * W) / W;
              setCursor(snap(domain.start + stepped * (domain.end - domain.start)));
            },
            onPointerLeave: (ev) => { if (ev?.pointerType !== "touch") setCursor(null); },
            onKeyDown: (ev) => {
              if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
              ev.preventDefault();
              const stepMs = (domain.end - domain.start) / 48;
              const from = cursor === null ? domain.end : cursor;
              setCursor(Math.min(domain.end, Math.max(domain.start, from + (ev.key === "ArrowLeft" ? -stepMs : stepMs))));
            },
            onBlur: () => setCursor(null),
          },
            h("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", "aria-hidden": "true", focusable: "false" },
              visibleBars.map((bar) => h("rect", { key: bar.day?.day || bar.index, className: "qm-chart-bar", x: bar.x.toFixed(1),
                y: (padT + plotH - bar.height).toFixed(1), width: bar.width.toFixed(1), height: bar.height.toFixed(1), rx: 1.5 })),
              h("line", { className: "qm-chart-grid", x1: padL, x2: W - padR, y1: padT, y2: padT }),
              h("line", { className: "qm-chart-axis", x1: padL, x2: W - padR, y1: padT + plotH, y2: padT + plotH }),
              legend.flatMap((item) => item.segments.filter((segment) => segment.length > 1).map((segment, index) =>
                h("polyline", { key: `${item.key}-${index}`, className: "qm-chart-line", fill: "none",
                  stroke: item.color, "vector-effect": "non-scaling-stroke",
                  points: segment.map(([at, pct]) => `${scaleX(at).toFixed(1)},${scaleY(pct).toFixed(1)}`).join(" ") })))),
            h("svg", { className: "qm-chart-overlay", "aria-hidden": "true", focusable: "false" },
              legend.flatMap((item) => item.segments.slice(1).map((segment, index) => {
                const previous = item.segments[index];
                const from = previous[previous.length - 1], to = segment[0];
                return h("line", { key: `${item.key}-drop-${index}`, className: "qm-chart-drop", stroke: item.color,
                  x1: px(from[0]), y1: py(from[1]), x2: px(to[0]), y2: py(to[1]) });
              })),
              legend.flatMap((item) => item.samples.map(([at, pct], index) =>
                h("circle", { key: `${item.key}-dot-${index}`, className: at === cursor ? "qm-chart-dot is-on" : "qm-chart-dot",
                  cx: px(at), cy: py(pct), r: at === cursor ? 3.2 : 2, fill: item.color }))),
              cursor === null ? null : h("line", { className: "qm-chart-cursor", x1: px(cursor), y1: py(100), x2: px(cursor), y2: py(0) })),
            labeledBars.length ? h("div", { className: "qm-chart-labels", "aria-hidden": "true" }, labeledBars.map((bar) => {
              const inside = bar.height >= plotH * 0.18;
              const top = ((padT + plotH - bar.height) / H) * 100;
              const left = ((bar.x + bar.width / 2) / W) * 100;
              return h("span", { key: bar.day?.day || bar.index, className: "qm-chart-value",
                style: { left: `${left.toFixed(3)}%`, top: `calc(${top.toFixed(3)}% ${inside ? "+" : "-"} 3px)`,
                  transform: `translate(-50%, ${inside ? "0" : "-100%"})` } }, fmtBig(bar.total));
            })) : null,
            cursor === null ? null : h("div", { className: "qm-chart-tip", "aria-hidden": "true",
              style: { left: `${tipX.toFixed(2)}%`, transform: `translateX(${tipX < 20 ? "0" : tipX > 80 ? "-100%" : "-50%"})` } },
              h("b", null, clockOf(cursor)),
              cursorDay && Number(cursorDay.total) > 0 ? h("span", { className: "qm-chart-tip-tok" }, `${fmtBig(Number(cursorDay.total))} token`) : null,
              readout.map((row) => h("span", { key: row.key, className: "qm-chart-tip-row" },
                h("i", { style: { background: row.color } }), `${row.label} ${t("remainLabel", { n: row.remaining })}`)))),
          h("div", { className: "qm-chart-ticks", "aria-hidden": "true" }, days.map((day, index) => {
            const start = dayStartOf(day?.day);
            if (!Number.isFinite(start)) return null;
            const end = Math.min(start + 24 * 3600_000, domain.end);
            const center = (start + end) / 2;
            const fraction = (center - domain.start) / (domain.end - domain.start);
            const left = ((padL + plotW * fraction) / W) * 100;
            return h("span", { key: day?.day || index, className: "qm-chart-tick", style: { left: `${left.toFixed(2)}%` } },
              String(day?.day || "").slice(5));
          })),
          legend.length ? h("div", { className: "qm-chart-legend" }, legend.map((item) =>
            h("span", { key: item.key, className: "qm-chart-key", "data-qm-line": item.key },
              h("i", { style: { background: item.color } }), `${item.label} ${t("remainLabel", { n: item.remaining })}`))) : null);
      }

      function SettingsSection({ t }) {
        const panel = useSurface();
        // 用 passive effect：useSyncExternalStore 的订阅在 layout 阶段之后才生效，
        // 在 layout effect 里 attachPage 会让宿主页错过第一次快照，直到保存结束才挂上。
        React.useEffect(() => {
          surface.attachPage();
          return () => surface.detachPage();
        }, []);
        return panel.host === "page" ? h(PanelHost, { t, host: "page", onClose: () => {} }) : null;
      }
      // ---------- 通用小 hook ----------
      function useDialog(onClose, returnFocusRef, enabled = true) {
        const ref = React.useRef(null);
        const close = React.useRef(onClose);
        close.current = onClose;
        React.useEffect(() => {
          const node = ref.current;
          if (!node || !enabled) return;
          const previous = document.activeElement;
          const focusable = () => Array.from(node.querySelectorAll(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]',
          )).filter((el) => el.getClientRects().length > 0);
          (focusable()[0] || node).focus();
          const onKey = (event) => {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close.current(); }
            if (event.key !== "Tab") return;
            const items = focusable(), first = items[0], last = items[items.length - 1];
            if (!first) { event.preventDefault(); node.focus(); }
            else if (event.shiftKey && (document.activeElement === first || !node.contains(document.activeElement) || document.activeElement === node)) {
              event.preventDefault(); last.focus();
            } else if (!event.shiftKey && (document.activeElement === last || !node.contains(document.activeElement) || document.activeElement === node)) {
              event.preventDefault(); first.focus();
            }
          };
          document.addEventListener("keydown", onKey, true);
          return () => {
            document.removeEventListener("keydown", onKey, true);
            // 对话框关闭后返回持久的侧栏入口。
            const target = returnFocusRef?.current || previous;
            if (target?.isConnected) target.focus();
          };
        }, [enabled]);
        return ref;
      }

      // ---------- 本地化 ----------
      const LOCALES = {
        zh: {
          current: "当前",
          moreInfo: "说明",
          colMetric: "指标",
          colLimit: "限额",
          colReset: "重置",
          colValue: "数值",
          colPeriod: "周期",
          watchDefaultShort: "未选：默认周窗口",
          overviewEmpty: "尚未添加供应商",
          manageSuppliers: "管理供应商",
          errorDetails: "错误详情",
          resetUnavailable: "重置时间未公布",
          unlimited: "未设额度上限",
          accountBalance: "账户余额",
          overview: "概览",
          suppliers: "供应商",
          expanded: "完整",
          compact: "紧凑",
          sidebarDisplay: "侧栏显示",
          browserOnly: "仅当前浏览器，选择后立即生效",
          expand: "展开",
          collapse: "收起",
          balance: "余额",
          cost: "报告费用",
          usage: "报告用量",
          moreMetrics: "另有 {n} 项",
          staleFailure: "更新失败 · 上次数据",
          unavailable: "暂时无法获取",
          disabled: "未启用",
          notQueried: "尚未查询",
          lastSuccess: "数据时间",
          todayScope: "当前供应商的今日 Token 用量，按宿主本地日统计",
          eventsObserved: "已观测到调用事件",
          previewSaved: "已保存配置的最近查询结果；编辑草稿不会改变此预览。",
          advanced: "高级选项",
          unsaved: "存在未保存的修改",
          keepEditing: "继续编辑",
          discard: "放弃修改",
          all: "全部",
          attention: "需关注",
          noAttention: "暂无需要关注的供应商",
          loading: "正在获取数据…",
          invalidThreshold: "阈值必须满足 1 ≤ 警告 < 临界 ≤ 100",
          invalidGlobal: "轮询间隔应为 10–3600 秒，保留期应为 1–90 天。",
          invalidHolidays: "节假日日期应为 YYYY-MM-DD：{list}",

          // ---- 峰谷计费时段（峰值/谷值判定在宿主 lib/season.js，客户端只展示） ----
          seasonPeak: "峰价",
          seasonValley: "谷价",
          seasonHoliday: "法定节假日",
          seasonWeekend: "周末",
          seasonTier: "计费时段",
          seasonNext: "下次切换",
          seasonBeijingNow: "北京时间",
          seasonBeijingOnly: "按北京时间判定",
          seasonFlipInM: "{m} 分钟后切换",
          seasonFlipInHM: "{h}h{m}m 后切换",
          seasonFlipInDH: "{d}d{h}h 后切换",
          seasonFlipSoon: "即将切换",
          seasonSplitLabel: "今日按时段",
          seasonSplitPeak: "高峰 {n}（{pct}）",
          seasonSplitValley: "空闲 {n}（{pct}）",
          seasonSplitUnknown: "未标记 {n}",
          holidaysLabel: "节假日覆盖表（每行一个日期）",
          holidaysPlaceholder: "2027-01-01\n2027-02-06",
          holidaysHint: "留空使用内置表。内置表按国务院公布的年度安排维护；缺次年时工作日假期会被误判为峰价，粘贴覆盖表可即时修正。",

          // ---- 常驻卡片：plan 名 + 周窗口进度条 ----
          weekTag: "周",
          barAria: "{name} 已用 {pct}",

          title: "用量监控",
          connWarn: "已连接 · 降级",
          connStandby: "待命",
          resetInHM: "{h}h{m}m 后重置",
          resetInDH: "{d}d{h}h 后重置",
          // 卡片条上的裸倒计时：不带叙述词，靠列对齐与弱色表达归属
          resetHM: "{h}h{m}m",
          resetDH: "{d}d{h}h",
          resetSoon: "即将重置",
          watchTitle: "关注限额",
          watchUnavailable: "当前不可用",
          watchDefaultHint: "不勾选时按默认规则：周窗口优先，缺少周窗口取已用比例最高的有效窗口。",
          moveUp: "上移",
          moveDown: "下移",
          todayLabel: "今日",
          noneActive: "暂无调用",
          today: "今日用量 {n} tokens",
          todayShort: "今日 {n}",
          statsWindow: "近 {n} 天",
          remainLabel: "剩余 {n}%",
          ratioAria: "缓存命中 {hit} · 缓存未命中 {miss} · 输出 {out}",
          cacheHit: "缓存命中",
          cacheMiss: "缓存未命中",
          outputLabel: "输出",
          cacheWrite: "缓存写入",
          unsplit: "未细分",
          refresh: "刷新",
          refreshing: "刷新中…",
          close: "关闭",
          cancel: "取消",
          save: "保存",
          saved: "已保存 ✓",
          stateOk: "正常",
          stateWarn: "警告",
          stateCrit: "临界",
          stateErr: "取数失败",
          stateOff: "未配置",
          quota: "限额",
          usedShort: "已用",
          detailTitle: "明细",
          historySummary: "刷新历史（最近 {n} 条）",
          colTime: "时间",
          colSupplier: "供应商",
          colResult: "结果",
          colOk: "成功",
          colFail: "失败",
          colMain: "主指标",
          colNote: "备注",
          colTier: "时段",
          settingsSub: "密钥保存在 DSH 配置中，此处不显示原文；留空可保留已有密钥",
          global: "全局设置",
          supplierPages: "供应商",
          rescan: "重新扫描",
          connectedChip: "已接入 {n}",
          scanLineBusy: "扫描中…",
          scanLineIdle: "未扫描",
          scanLineFail: "扫描失败：{err}",
          addableTitle: "可添加供应商",
          addableCount: "{n} 个",
          emptyAdded: "尚未接入供应商",
          openPage: "配置",
          back: "返回",
          credentials: "凭据",
          compatSource: "兼容来源",

          enable: "启用",
          test: "测试连接",
          testing: "测试中…",
          testOk: "连接正常",
          testFail: "失败",
          apiKey: "API Key",
          managementKey: "Management Key",
          adminKey: "Admin Key",
          codingPlanKey: "Coding Plan Key",
          tokenPlanKey: "Token Plan Key",
          currentQuota: "当前额度（最近一次取数）",
          unmappedDetail: "（{detail}）",
          keySet: "已设置（留空保持不变）",
          keyEmpty: "未设置",
          keyAuto: "自动读取 {env}",
          apiKeyEnv: "凭据引用",
          apiKeyEnvPlaceholder: "如 COMMAND_CODE_API_KEY",
          apiKeyEnvHint: "填 DSH 凭据库里的记录名或环境变量名；密钥本体不写进本插件配置。",
          keyRefResolved: "引用 {env}（已解析）",
          keyRefMissing: "引用 {env}（未解析）",
          dshKey: "DSH 密钥",
          allowanceToken: "allowance Token（OAuth）",
          orgId: "org id（可选）",
          baseUrl: "Base URL",
          warnPct: "警告阈值 %",
          critPct: "临界阈值 %",
          interval: "轮询间隔（秒，10–3600）",
          retention: "用量保留期（天，1–90）",
          unmapped: "另探测到 DSH 内已添加但本插件暂不支持的供应商",
        },
        en: {
          current: "Current",
          moreInfo: "More info",
          colMetric: "Metric",
          colLimit: "Limit",
          colReset: "Resets",
          colValue: "Value",
          colPeriod: "Period",
          watchDefaultShort: "None selected — weekly window",
          overviewEmpty: "No suppliers yet",
          manageSuppliers: "Manage suppliers",
          errorDetails: "Error details",
          resetUnavailable: "Reset time unavailable",
          unlimited: "No quota limit",
          accountBalance: "Account balance",
          overview: "Overview",
          suppliers: "Suppliers",
          expanded: "Expanded",
          compact: "Compact",
          sidebarDisplay: "Sidebar display",
          browserOnly: "Only this browser; changes apply immediately",
          expand: "Expand",
          collapse: "Collapse",
          balance: "Balance",
          cost: "Reported cost",
          usage: "Reported usage",
          moreMetrics: "{n} more",
          staleFailure: "Update failed · previous data",
          unavailable: "Temporarily unavailable",
          disabled: "Disabled",
          notQueried: "Not queried yet",
          lastSuccess: "Data updated",
          todayScope: "Today's Token usage for current suppliers, measured by the host local day",
          eventsObserved: "Call events observed",
          previewSaved: "Latest query for the saved configuration. Draft edits do not change this preview.",
          advanced: "Advanced options",
          unsaved: "You have unsaved changes",
          keepEditing: "Continue editing",
          discard: "Discard changes",
          all: "All",
          attention: "Needs attention",
          noAttention: "No suppliers need attention",
          loading: "Loading data…",
          invalidThreshold: "Thresholds must satisfy 1 ≤ warning < critical ≤ 100",
          invalidGlobal: "Poll interval must be 10–3600 seconds; retention must be 1–90 days.",
          invalidHolidays: "Holiday dates must be YYYY-MM-DD: {list}",

          // ---- DeepSeek peak/valley billing windows (decided host-side in lib/season.js) ----
          seasonPeak: "Peak",
          seasonValley: "Off-peak",
          seasonHoliday: "public holiday",
          seasonWeekend: "weekend",
          seasonTier: "Billing window",
          seasonNext: "Next switch",
          seasonBeijingNow: "Beijing time",
          seasonBeijingOnly: "decided in Beijing time",
          seasonFlipInM: "switches in {m}m",
          seasonFlipInHM: "switches in {h}h{m}m",
          seasonFlipInDH: "switches in {d}d{h}h",
          seasonFlipSoon: "switching now",
          seasonSplitLabel: "Today by window",
          seasonSplitPeak: "peak {n} ({pct})",
          seasonSplitValley: "off-peak {n} ({pct})",
          seasonSplitUnknown: "untagged {n}",
          holidaysLabel: "Holiday overrides (one per line)",
          holidaysPlaceholder: "2027-01-01\n2027-02-06",
          holidaysHint: "Empty uses the built-in table. That table only covers years the State Council has published; without next year's dates, weekday holidays count as peak — paste an override to correct it immediately.",

          // ---- sidebar card: plan name + weekly progress bar ----
          weekTag: "Week",
          barAria: "{name} used {pct}",

          title: "Usage monitor",
          connWarn: "Connected · degraded",
          connStandby: "Standby",
          resetInHM: "resets in {h}h{m}m",
          resetInDH: "resets in {d}d{h}h",
          resetHM: "{h}h{m}m",
          resetDH: "{d}d{h}h",
          resetSoon: "resetting now",
          watchTitle: "Watched limits",
          watchUnavailable: "Unavailable now",
          watchDefaultHint: "With nothing checked the card falls back to the weekly window, then the highest-used valid window.",
          moveUp: "Move up",
          moveDown: "Move down",
          todayLabel: "Today",
          noneActive: "No calls yet",
          today: "Today {n} tokens",
          todayShort: "Today {n}",
          statsWindow: "Last {n} days",
          remainLabel: "{n}% left",
          ratioAria: "Cache hits {hit} · cache misses {miss} · output {out}",
          cacheHit: "Cache hits",
          cacheMiss: "Cache misses",
          outputLabel: "Output",
          cacheWrite: "Cache writes",
          unsplit: "Unsplit",
          refresh: "Refresh",
          refreshing: "Refreshing…",
          close: "Close",
          cancel: "Cancel",
          save: "Save",
          saved: "Saved ✓",
          stateOk: "OK",
          stateWarn: "Warning",
          stateCrit: "Critical",
          stateErr: "Fetch failed",
          stateOff: "Not configured",
          quota: "Limit",
          usedShort: "Used",
          detailTitle: "Details",
          historySummary: "Refresh history (latest {n})",
          colTime: "Time",
          colSupplier: "Supplier",
          colResult: "Result",
          colOk: "OK",
          colFail: "Failed",
          colMain: "Headline",
          colNote: "Note",
          colTier: "Tier",
          settingsSub: "Secrets are stored in DSH configuration and are never displayed here. Leave blank to keep the existing secret.",
          global: "Global settings",
          supplierPages: "Suppliers",
          rescan: "Rescan",
          connectedChip: "Connected {n}",
          scanLineBusy: "Scanning…",
          scanLineIdle: "Not scanned",
          scanLineFail: "Scan failed: {err}",
          addableTitle: "Addable suppliers",
          addableCount: "{n}",
          emptyAdded: "No suppliers connected yet",
          openPage: "Configure",
          back: "Back",
          credentials: "Credentials",
          compatSource: "compat",

          enable: "Enable",
          test: "Test connection",
          testing: "Testing…",
          testOk: "Connected",
          testFail: "Failed",
          apiKey: "API Key",
          managementKey: "Management Key",
          adminKey: "Admin Key",
          codingPlanKey: "Coding Plan Key",
          tokenPlanKey: "Token Plan Key",
          currentQuota: "Current quota (latest fetch)",
          unmappedDetail: "({detail})",
          keySet: "Set (blank keeps current)",
          keyEmpty: "Not set",
          keyAuto: "Auto-read {env}",
          apiKeyEnv: "Credential reference",
          apiKeyEnvPlaceholder: "e.g. COMMAND_CODE_API_KEY",
          apiKeyEnvHint: "Name of a DSH credential record or an environment variable; the key itself is never written to this plugin's config.",
          keyRefResolved: "ref {env} (resolved)",
          keyRefMissing: "ref {env} (unresolved)",
          dshKey: "DSH key",
          allowanceToken: "allowance Token (OAuth)",
          orgId: "org id (optional)",
          baseUrl: "Base URL",
          warnPct: "Warn threshold %",
          critPct: "Critical threshold %",
          interval: "Poll interval (s, 10–3600)",
          retention: "Usage retention (days, 1–90)",
          unmapped: "Detected DSH suppliers this plugin does not support yet",
        },
      };

      // ---------- 样式（一次性注入，作用域化） ----------
      const CSS = `
[data-qm-entry],.qm-density{box-sizing:border-box;color:var(--dsw-alias-label-primary,#dbe2ee);font:12px var(--dsw-font-family),system-ui,sans-serif;}
div:has(> div[data-slot="sidebar.footer.action"] > [data-qm-linerow]){flex-wrap:wrap;}
[data-qm-linerow]{flex:1 1 100%;min-width:100%;box-sizing:border-box;order:-1;margin:2px 0;}
.qm-footer{position:relative;display:flex;flex-direction:column;align-items:stretch;border:1px solid var(--dsw-alias-border-l2,#363d4d);border-radius:9px;background:var(--dsw-alias-bg-layer-2,#151922);overflow:hidden;}
.qm-density{position:absolute;right:4px;top:4px;width:26px;height:24px;border:0;border-radius:5px;background:transparent;cursor:pointer;}
.qm-l1{display:flex;gap:8px;align-items:center;padding-right:26px;}
.qm-plan{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.qm-fetch-status{font-size:10px;min-width:0;color:var(--dsw-alias-state-error-primary,#f87171);}
/* 第 2 行：窗口标签 + 已用百分比进度条 + 百分比数字（颜色即阈值分档，不再另设圆点）
   关注限额可以是多条：四列网格让所有行共享 label/条/百分比/倒计时列宽，行与行严格对齐 */
.qm-bars{display:grid;grid-template-columns:minmax(0,max-content) minmax(24px,1fr) max-content max-content;
  column-gap:6px;row-gap:6px;align-items:center;min-width:0;}
/* 回落成主指标文字（只有余额/报告）时同样要能截断：这一行放不下就省略，不许撑破卡片 */
.qm-l2{display:flex;align-items:center;gap:6px;min-width:0;}
.qm-l2>.qm-primary{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
/* 长度上限用 em 而不是百分比：百分比在 grid 自动轨道里会对尚未确定的轨道尺寸解析，
   把「月用量」夹成十几像素只剩省略号。em 是绝对长度，列宽由最长（但受限）的 label 决定。 */
.qm-bar-label{font-size:10px;line-height:14px;max-width:5.5em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#a9b2c5);}
.qm-bar{min-width:24px;height:6px;border-radius:3px;overflow:hidden;background:var(--dsw-alias-border-l1,#1d2330);}
.qm-bar-fill{display:block;height:100%;border-radius:3px;background:var(--dsw-alias-label-tertiary,#6b7280);}
.qm-bar-fill.ok{background:var(--dsw-alias-state-success-primary,#34d399);}
.qm-bar-fill.warn{background:var(--dsw-alias-state-warn-primary,#fbbf24);}
.qm-bar-fill.crit{background:var(--dsw-alias-state-error-primary,#f87171);}
.qm-bar-pct{font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#a9b2c5);}
/* 裸倒计时：不带「后重置」这类叙述词，靠右对齐 + 弱色 + min-width 保证多行对齐 */
.qm-bar-reset{min-width:36px;margin-left:4px;text-align:right;font-size:10px;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-tertiary,#8b94a8);}
.qm-primary{font-weight:600;font-variant-numeric:tabular-nums;}
/* 卡片标题行：供应商名 + 今日用量，点击进统计；监控条与时段留在下方主按钮里。
   padding-right 给绝对定位的密度按钮（右侧 4px 起、宽 26px）留位，不与今日数重叠 */
.qm-head{display:flex;align-items:center;gap:8px;border:0;background:transparent;cursor:pointer;text-align:left;
  color:inherit;font:inherit;line-height:17px;padding:8px 32px 0 8px;}
.qm-today-chip{margin-left:auto;flex:none;font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#a9b2c5);}
/* 详情弹窗：今日用量与归一比例同一行；窄栏放不下就换行，不把总量和数字拆散。
   左右内缩 10px，与时段块、指标卡的文字对齐 */
.qm-today-line{display:flex;align-items:baseline;flex-wrap:wrap;gap:2px 10px;margin:8px 10px 6px;
  color:var(--dsw-alias-label-secondary,#a9b2c5);font-size:11px;font-variant-numeric:tabular-nums;}
.qm-today-text{flex:none;}
/* 分布条：详情行只有一条五段条（命中/未命中/输出/写缓存/未细分）；段宽 = 分量占比 */
.qm-split-bar{display:inline-flex;flex:1 1 64px;min-width:48px;height:5px;border-radius:2.5px;overflow:hidden;
  background:var(--dsw-alias-border-l1,#1d2330);}
.qm-split-bar i{display:block;height:100%;}
.qm-split-lg{flex-basis:120px;height:8px;border-radius:4px;}
.seg-hit{background:var(--dsw-alias-state-success-primary,#34d399);}
.seg-miss{background:var(--dsw-alias-state-business-primary,#4f8cff);}
.seg-out{background:#a78bfa;}
.seg-write{background:var(--dsw-alias-label-tertiary,#8b94a8);}
.seg-unsplit{background:var(--dsw-alias-border-l2,#363d4d);}
/* 归一比例：三个数字分别着段色，与分布条一一对应；分隔冒号保持弱色。
   必须是 inline 而不是 flex：flex 容器会把分隔用的空白裁掉，冒号两侧就贴住了。 */
.qm-ratio{display:inline;font-weight:600;font-variant-numeric:tabular-nums;}
.qm-ratio b{font-weight:700;}
.qm-ratio .r-hit{color:var(--dsw-alias-state-success-primary,#34d399);}
.qm-ratio .r-miss{color:var(--dsw-alias-state-business-primary,#4f8cff);}
.qm-ratio .r-out{color:#a78bfa;}
/* 合并图：柱 = 每日 token（左轴量级），线 = 各窗口剩余额度（右轴恒定 0–100%） */
.qm-chart{margin-top:12px;}
.qm-chart-cap{display:flex;justify-content:space-between;flex-wrap:wrap;gap:2px 8px;font-size:10px;
  color:var(--dsw-alias-label-tertiary,#5c6577);font-variant-numeric:tabular-nums;}
.qm-chart-plot{position:relative;margin-top:2px;height:112px;cursor:crosshair;outline:none;}
.qm-chart-plot:focus-visible{outline:1px solid var(--dsw-alias-border-l2,#363d4d);outline-offset:2px;border-radius:4px;}
/* preserveAspectRatio=none 让 svg 铺满容器；折线用 non-scaling-stroke 保持 1.5px 不被横向拉扁 */
.qm-chart-plot svg{display:block;width:100%;height:100%;overflow:visible;}
/* 柱值标签：按绘图区百分比定位，文字本身不参与 svg 的横向拉伸 */
.qm-chart-labels{position:absolute;inset:0;pointer-events:none;}
.qm-chart-value{position:absolute;transform:translateX(-50%);font-size:10px;line-height:1;white-space:nowrap;
  font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#a9b2c5);pointer-events:none;}
.qm-chart-bar{fill:var(--dsw-alias-state-business-primary,#4f8cff);fill-opacity:.32;}
.qm-chart-grid{stroke:var(--dsw-alias-border-l2,#363d4d);stroke-width:1;stroke-dasharray:3 3;vector-effect:non-scaling-stroke;}
.qm-chart-axis{stroke:var(--dsw-alias-border-l2,#363d4d);stroke-width:1;vector-effect:non-scaling-stroke;}
.qm-chart-line{stroke-width:1.5;stroke-linejoin:round;stroke-linecap:round;}
/* 叠加层不参与坐标拉伸：点是像素半径，线是像素宽度 */
.qm-chart-overlay{position:absolute;inset:0;pointer-events:none;}
.qm-chart-dot{stroke:none;}
.qm-chart-dot.is-on{stroke:var(--dsw-alias-bg-base,#0b0e13);stroke-width:1.5;}
.qm-chart-drop{fill:none;stroke-width:1;stroke-dasharray:2.5 2.5;opacity:.55;vector-effect:non-scaling-stroke;}
.qm-chart-cursor{stroke:var(--dsw-alias-label-tertiary,#8b94a8);stroke-width:1;opacity:.75;vector-effect:non-scaling-stroke;}
.qm-chart-tip{position:absolute;top:0;z-index:2;pointer-events:none;display:flex;flex-direction:column;gap:2px;
  padding:5px 8px;border-radius:7px;white-space:nowrap;font-size:11px;line-height:1.45;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-secondary,#a9b2c5);background:var(--dsw-alias-bg-base,#0b0e13);
  border:1px solid var(--dsw-alias-border-l2,#363d4d);box-shadow:0 4px 14px #0006;}
.qm-chart-tip b{font-weight:600;color:var(--dsw-alias-label-primary,#dbe2ee);}
.qm-chart-tip-tok{color:var(--dsw-alias-label-tertiary,#8b94a8);}
.qm-chart-tip-row{display:flex;align-items:center;gap:6px;}
.qm-chart-tip-row i{display:inline-block;flex:none;width:7px;height:7px;border-radius:1px;}
.qm-chart-ticks{position:relative;height:12px;margin-top:1px;}
.qm-chart-tick{position:absolute;transform:translateX(-50%);font-size:10px;white-space:nowrap;
  color:var(--dsw-alias-label-tertiary,#5c6577);font-variant-numeric:tabular-nums;}
.qm-chart-legend{display:flex;gap:12px;flex-wrap:wrap;margin-top:6px;font-size:11px;
  color:var(--dsw-alias-label-secondary,#a9b2c5);font-variant-numeric:tabular-nums;}
.qm-chart-key{display:inline-flex;align-items:center;gap:5px;}
.qm-chart-key i{display:inline-block;width:10px;height:2px;border-radius:1px;}
/* 供应商配置页：关注限额复选列表（勾选顺序即卡片排列顺序） */
.qm-watch{border:1px solid var(--dsw-alias-border-l2,#262d3d);border-radius:8px;padding:8px 10px 4px;}
.qm-watch .w-hint{color:var(--dsw-alias-label-tertiary,#8b94a8);font-size:11px;}
.qm-watch .w-row{display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--dsw-alias-border-l1,#1d2330);}
.qm-watch .w-row:last-child{border-bottom:none;}
.qm-watch .w-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.qm-watch .w-val{flex:none;font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#a9b2c5);}
.qm-watch .w-row.off .w-name,.qm-watch .w-row.off .w-val{color:var(--dsw-alias-label-tertiary,#8b94a8);}
.qm-watch .w-move{flex:none;display:flex;gap:2px;visibility:hidden;}
.qm-watch .w-row.watched .w-move{visibility:visible;}
.qm-watch .w-move button{width:20px;height:20px;border:1px solid var(--dsw-alias-border-l2,#262d3d);border-radius:5px;
  background:none;color:var(--dsw-alias-label-secondary,#a9b2c5);cursor:pointer;font-size:10px;line-height:1;padding:0;}
.qm-watch .w-move button:hover:not(:disabled){color:var(--dsw-alias-label-primary,#dbe2ee);border-color:var(--dsw-alias-state-business-primary,#4f8cff);}
.qm-watch .w-move button:disabled{opacity:.35;cursor:default;}
.qm-season{display:flex;align-items:center;gap:5px;font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#a9b2c5);}
.qm-season b{font-weight:600;}
.qm-season.peak b,.qm-season-dot.peak{color:var(--dsw-alias-state-warn-primary,#fbbf24);}
.qm-season.valley b{color:var(--dsw-alias-state-success-primary,#34d399);}
.qm-season-dot{width:6px;height:6px;border-radius:50%;flex:none;display:inline-block;background:var(--dsw-alias-label-tertiary,#6b7280);}
.qm-season-dot.peak{background:var(--dsw-alias-state-warn-primary,#fbbf24);}
.qm-season-dot.valley{background:var(--dsw-alias-state-success-primary,#34d399);}
.qm-season-block{margin:0 10px 10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1,#1d2330);border-radius:8px;}
.qm-season-block .qm-season-row{display:flex;justify-content:space-between;gap:8px;font-size:11px;color:var(--dsw-alias-label-secondary,#a9b2c5);}
.qm-season-block .qm-season-row+.qm-season-row{margin-top:4px;}
.qm-season-warn{margin-top:6px;font-size:11px;color:var(--dsw-alias-state-warn-primary,#fbbf24);}
.qm-settings .qm-holidays textarea{width:100%;box-sizing:border-box;resize:vertical;font:11px var(--dsw-font-family),ui-monospace,monospace;
  background:var(--dsw-alias-bg-layer-2,#151922);border:1px solid var(--dsw-alias-border-l2,#262d3d);border-radius:8px;
  color:var(--dsw-alias-label-primary,#dbe2ee);padding:6px 8px;}
.qm-settings .qm-holidays textarea:focus{outline:2px solid var(--dsw-alias-state-business-primary,#4f8cff);outline-offset:1px;}
.qm-compact-line{display:flex;gap:5px;align-items:center;padding:8px 24px 0 0;white-space:nowrap;}
.qm-compact-line .qm-provider{min-width:24px;max-width:32%;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto;}
.qm-compact-line .qm-primary{min-width:0;display:flex;gap:3px;align-items:center;flex:1;font-size:11px;}
.qm-metric-name{min-width:0;overflow:hidden;text-overflow:ellipsis;}
.qm-metric-value,.qm-more{flex:none;}
.qm-rail{width:32px;height:32px;border:none;border-radius:8px;background:transparent;cursor:pointer;}
.qm-dot{width:7px;height:7px;border-radius:50%;flex:none;display:inline-block;background:var(--dsw-alias-label-tertiary,#6b7280);}
.qm-dot.ok{background:var(--dsw-alias-state-success-primary,#34d399);}
.qm-dot.warn{background:var(--dsw-alias-state-warn-primary,#fbbf24);}
.qm-dot.crit{background:var(--dsw-alias-state-error-primary,#f87171);}
.qm-overlay{position:fixed;inset:0;z-index:1500;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;}
.qm-overlay .qm-card{width:min(960px,calc(100vw - 32px));max-height:86vh;overflow:auto;
  background:var(--dsw-alias-bg-base,#0b0e13);border:1px solid var(--dsw-alias-border-l2,#262d3d);
  border-radius:14px;padding:20px 24px 24px;color:var(--dsw-alias-label-primary,#dbe2ee);
  font-family:var(--dsw-font-family),sans-serif;box-sizing:border-box;}
.qm-overlay .qm-card h3{margin:0 0 4px;font-size:15px;}
.qm-overlay .qm-sub{color:var(--dsw-alias-label-tertiary,#8b94a8);font-size:11px;margin-bottom:12px;}
/* 设置页版设置面板：已嵌在设置面板内容列里，不再要遮罩/卡片边框与宽度上限 */
.qm-settings-page{color:var(--dsw-alias-label-primary,#dbe2ee);font-family:var(--dsw-font-family),sans-serif;padding-top:8px;}
.qm-settings-page h3{margin:0 0 4px;font-size:15px;}
.qm-settings-page .qm-sub{color:var(--dsw-alias-label-tertiary,#8b94a8);font-size:11px;margin-bottom:12px;}
.qm-pill{display:inline-block;padding:0 8px;border-radius:9px;font-size:11px;
  border:1px solid var(--dsw-alias-border-l2,#262d3d);color:var(--dsw-alias-label-secondary,#8b94a8);}
.qm-pill.warn{color:var(--dsw-alias-state-warn-primary,#fbbf24);border-color:var(--dsw-alias-state-warn-primary,#fbbf24);}
.qm-pill.crit{color:var(--dsw-alias-state-error-primary,#f87171);border-color:var(--dsw-alias-state-error-primary,#f87171);}
.qm-pill.err{color:var(--dsw-alias-label-tertiary,#6b7280);}
.qm-pill.ok{color:var(--dsw-alias-state-success-primary,#34d399);}
.qm-pill.off{color:var(--dsw-alias-label-tertiary,#6b7280);}
.qm-history{margin-top:14px;border:1px solid var(--dsw-alias-border-l1,#262d3d);border-radius:10px;
  background:var(--dsw-alias-bg-layer-2,#151922);}
.qm-history summary{cursor:pointer;padding:8px 12px;font-size:12px;color:var(--dsw-alias-label-secondary,#8b94a8);}
.qm-history table{width:100%;border-collapse:collapse;font-size:11px;}
.qm-history td,.qm-history th{padding:4px 8px;border-top:1px solid var(--dsw-alias-border-l1,#1d2330);text-align:left;color:var(--dsw-alias-label-secondary,#8b94a8);}
.qm-history .h-ok{color:var(--dsw-alias-state-success-primary,#34d399);}
.qm-history .h-peak{color:var(--dsw-alias-state-warn-primary,#fbbf24);}
.qm-history .h-valley{color:var(--dsw-alias-state-success-primary,#34d399);}
.qm-history .h-bad{color:var(--dsw-alias-state-error-primary,#f87171);}
.qm-settings input[type=text],.qm-settings input[type=password],.qm-settings input[type=number]{
  width:100%;box-sizing:border-box;background:var(--dsw-specific-input-major,#1c2230);
  border:1px solid var(--dsw-alias-border-l2,#262d3d);border-radius:8px;color:var(--dsw-alias-label-primary,#dbe2ee);
  padding:6px 8px;font-size:12px;font-family:inherit;margin-top:2px;}
.qm-settings input:focus{outline:2px solid var(--dsw-alias-state-business-primary,#4f8cff);outline-offset:1px;}
.qm-settings label{display:block;margin-bottom:10px;font-size:12px;color:var(--dsw-alias-label-secondary,#8b94a8);}
.qm-settings .s-group{border:1px solid var(--dsw-alias-border-l1,#262d3d);border-radius:10px;padding:10px 12px;margin-bottom:10px;
  background:var(--dsw-alias-bg-layer-2,#151922);}
.qm-settings .s-group h5{margin:0 0 8px;font-size:13px;display:flex;justify-content:space-between;align-items:center;}
.qm-settings .s-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 12px;}
.qm-settings .s-row{display:flex;gap:8px;align-items:center;margin-bottom:6px;}
.qm-settings .s-row input[type=checkbox]{accent-color:var(--dsw-alias-state-business-primary,#4f8cff);}
.qm-settings .s-test{margin-left:8px;border:1px solid var(--dsw-alias-border-l2,#262d3d);background:none;border-radius:6px;
  color:var(--dsw-alias-label-primary,#dbe2ee);cursor:pointer;padding:2px 10px;font-size:11px;font-family:inherit;}
.qm-settings .s-test-res{font-size:11px;margin-left:8px;}
.qm-settings .s-test-res.ok{color:var(--dsw-alias-state-success-primary,#34d399);}
.qm-settings .s-test-res.bad{color:var(--dsw-alias-state-error-primary,#f87171);}
.qm-settings .s-actions{display:flex;gap:8px;justify-content:flex-end;}
.qm-settings .s-actions button{border:1px solid var(--dsw-alias-border-l2,#262d3d);background:none;border-radius:8px;
  color:var(--dsw-alias-label-primary,#dbe2ee);cursor:pointer;padding:5px 14px;font-size:12px;font-family:inherit;}
.qm-settings .s-actions button.qm-pri{background:var(--dsw-alias-button-info-fill,#4f8cff);border-color:transparent;color:#fff;}
.qm-settings .s-saved{color:var(--dsw-alias-state-success-primary,#34d399);font-size:11px;align-self:center;}

.qm-settings .qm-pages-title{display:flex;justify-content:space-between;margin:4px 0 8px;color:var(--dsw-alias-label-secondary,#8b94a8);font-size:12px;}
.qm-settings .qm-pages-title span{color:var(--dsw-alias-label-tertiary,#5c6577);font-size:10px;}
.qm-page-list{display:flex;flex-direction:column;gap:6px;}
.qm-page-row{display:flex;align-items:center;gap:10px;border:1px solid var(--dsw-alias-border-l1,#262d3d);border-radius:10px;padding:6px 10px;background:var(--dsw-alias-bg-layer-2,#151922);}
.qm-page-main{flex:1 1 0;min-width:0;display:flex;align-items:center;gap:8px;cursor:pointer;}
.qm-page-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.qm-page-pill{flex:none;padding:1px 8px;border-radius:8px;font-size:10px;border:1px solid var(--dsw-alias-border-l2,#262d3d);color:var(--dsw-alias-label-secondary,#8b94a8);}
.qm-page-pill.ghost{opacity:.6;}
.qm-page-actions{flex:none;display:flex;align-items:center;gap:6px;font-size:11px;}
.qm-page-toggle{display:flex;gap:4px;align-items:center;margin:0;font-size:11px;}
.qm-page-toggle input[type=checkbox]{accent-color:var(--dsw-alias-state-business-primary,#4f8cff);}
.qm-settings .s-test.qm-pri-soft{border-color:var(--dsw-alias-state-business-primary,#4f8cff);color:var(--dsw-alias-state-business-primary,#4f8cff);}
.qm-settings .qm-page-head{display:flex;align-items:center;gap:8px;margin-bottom:8px;}
.qm-settings .qm-page-head b{flex:1 1 0;font-size:14px;}
.qm-settings .qm-inline-toggle{display:flex;align-items:center;gap:6px;margin:8px 0 0;font-size:12px;}
.qm-settings .qm-inline-toggle input[type=checkbox]{accent-color:var(--dsw-alias-state-business-primary,#4f8cff);}
/* v1.1：已添加过滤目录 + 重新扫描标题行 + 可添加折叠列表 */
.qm-settings .qm-pages-title.qm-head-b{align-items:center;}
.qm-settings .qm-pages-title .qm-added-only{margin-left:6px;color:var(--dsw-alias-label-tertiary,#5c6577);font-size:10px;font-weight:400;}
.qm-settings .qm-title-actions{display:flex;align-items:center;gap:8px;flex:none;}
.qm-settings .chip{display:inline-block;padding:1px 8px;border-radius:8px;font-size:10px;border:1px solid var(--dsw-alias-border-l2,#262d3d);color:var(--dsw-alias-label-secondary,#8b94a8);background:var(--dsw-alias-bg-layer-2,#151922);white-space:nowrap;}
.qm-rescan-btn{border:1px solid var(--dsw-alias-border-l2,#262d3d);background:none;border-radius:8px;color:var(--dsw-alias-label-primary,#dbe2ee);cursor:pointer;padding:3px 12px;font-size:11px;font-family:inherit;white-space:nowrap;}
.qm-rescan-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#20283a);}
.qm-rescan-btn:disabled{cursor:default;opacity:.55;}
.qm-settings .qm-scanline{display:flex;justify-content:flex-end;align-items:center;gap:6px;flex-wrap:wrap;min-height:16px;
  margin:-4px 0 8px;color:var(--dsw-alias-label-tertiary,#8b94a8);font-size:11px;}
.qm-settings .qm-scanline b{font-weight:600;}
.qm-settings .qm-scanline .ok{color:var(--dsw-alias-state-success-primary,#34d399);}
.qm-settings .qm-scanline .err{color:var(--dsw-alias-state-error-primary,#f87171);}
.qm-settings .qm-scanline .names{max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;vertical-align:middle;}
.qm-settings .qm-empty-added{color:var(--dsw-alias-label-tertiary,#8b94a8);text-align:center;padding:18px 8px;
  border:1px dashed var(--dsw-alias-border-l1,#262d3d);border-radius:10px;margin-bottom:4px;}
.qm-settings .qm-addable{margin-top:10px;border:1px dashed var(--dsw-alias-border-l2,#262d3d);border-radius:10px;}
.qm-settings .qm-addable summary{cursor:pointer;padding:8px 12px;font-size:12px;color:var(--dsw-alias-label-secondary,#8b94a8);list-style:none;display:flex;align-items:center;gap:8px;user-select:none;}
.qm-settings .qm-addable summary::-webkit-details-marker{display:none;}
.qm-settings .qm-addable summary::before{content:"▸";font-size:10px;color:var(--dsw-alias-label-tertiary,#5c6577);transition:transform .15s;}
.qm-settings .qm-addable[open] summary::before{transform:rotate(90deg);}
.qm-settings .qm-addable .cnt{color:var(--dsw-alias-label-tertiary,#8b94a8);font-size:10px;}
.qm-settings .addable-list{padding:0 8px 8px;display:flex;flex-direction:column;gap:6px;}
.qm-settings .qm-add-row{display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-border-l1,#262d3d);border-radius:8px;padding:5px 8px;background:var(--dsw-alias-bg-layer-2,#151922);}
.qm-settings .qm-add-row.fresh{animation:qm-fresh 1.8s ease-out;}
@keyframes qm-fresh{from{background:rgba(79,140,255,.30);}to{background:transparent;}}

.qm-card{container-type:inline-size;min-width:0;overflow-wrap:anywhere;}
.qm-card button,.qm-card select{font:inherit;font-size:12px;color:var(--dsw-alias-label-primary,#dbe2ee);background:var(--dsw-alias-bg-layer-2,#151922);border:1px solid var(--dsw-alias-border-l2,#363d4d);border-radius:7px;padding:5px 10px;cursor:pointer;}
.qm-card button:disabled{opacity:.55;cursor:default;}
.qm-card button:focus-visible,.qm-card summary:focus-visible,.qm-card select:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4f8cff);outline-offset:2px;}
.qm-panel-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px;}
.qm-panel-head h3{flex:1;}
.qm-tabs{display:flex;gap:8px;border-bottom:1px solid var(--dsw-alias-border-l2,#363d4d);padding-bottom:10px;margin-bottom:16px;}
.qm-tabs [aria-selected=true]{color:var(--dsw-alias-state-business-primary,#4f8cff);border-color:currentColor;}
@container (max-width:460px){.qm-settings .s-grid{grid-template-columns:minmax(0,1fr);}.qm-page-actions{width:100%;}.qm-chart-value{font-size:9px;}}
/* 极窄面板（内容宽 ≤240px）里柱值会互相压住：只保留日期刻度与悬停读数 */
@container (max-width:240px){.qm-chart-value{display:none;}}
.qm-cur{color:var(--dsw-alias-state-business-primary,#4f8cff);font-weight:400;}
.qm-history-scroll{overflow-x:auto;}
.qm-history-scroll table{min-width:560px;}
.ci-err{color:var(--dsw-alias-state-error-primary,#f87171);font-size:12px;margin:8px 0;white-space:pre-wrap;}
.qm-page-row,.qm-add-row{flex-wrap:wrap;}
.qm-page-main{cursor:default;flex-wrap:wrap;min-width:150px;}
.qm-row-metric{font-size:11px;font-variant-numeric:tabular-nums;}
.qm-page-actions{flex-wrap:wrap;}
.qm-settings .qm-page-toggle{display:flex;align-items:center;margin:0;}
.qm-settings .qm-pages-title{flex-wrap:wrap;gap:8px;}
.qm-settings .qm-page-head{flex-wrap:wrap;}
.qm-settings .qm-page-head b{min-width:100px;}
.qm-advanced summary{cursor:pointer;font-size:13px;margin-bottom:10px;}
.qm-confirm{position:sticky;bottom:0;padding:14px;border:2px solid var(--dsw-alias-state-warn-primary,#fbbf24);border-radius:10px;background:var(--dsw-alias-bg-base,#0b0e13);box-shadow:0 3px 14px #0004;z-index:1;}
.qm-confirm button{margin-right:8px;}
.qm-empty{text-align:center;padding:18px 8px;color:var(--dsw-alias-label-tertiary,#8b94a8);}
.qm-empty p{margin:0 0 8px;}
/* 卡片：标题行 + 监控条合并为一个按钮，密度切换仍是同级兄弟 */
.qm-card-body{flex:1;min-width:0;display:flex;flex-direction:column;align-items:stretch;gap:1px;padding:0 6px 8px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;}
.qm-card-body:hover,.qm-density:hover{background:var(--dsw-alias-interactive-bg-hover,#20283a);}
.qm-card-body:focus-visible,.qm-density:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4f8cff);outline-offset:-2px;}
.qm-head{display:flex;align-items:center;gap:8px;padding:8px 24px 0 0;margin-bottom:3px;text-align:left;}
.qm-season-meta{color:var(--dsw-alias-label-tertiary,#8b94a8);}
/* 概览：供应商行 + 展开明细 */
.qm-overview-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:2px 0 10px;font-size:12px;}
.qm-today-total{display:flex;align-items:baseline;gap:5px;font-variant-numeric:tabular-nums;}
.qm-today-total b{font-size:15px;}
.qm-today-total>span:first-child{color:var(--dsw-alias-label-secondary,#a9b2c5);}
.qm-filter{display:flex;gap:6px;margin-left:auto;}
.qm-filter button{font-size:11px;padding:3px 8px;}
.qm-filter .qm-count{opacity:.65;margin-left:5px;}
.qm-rows{display:flex;flex-direction:column;gap:8px;}
.qm-row{border:1px solid var(--dsw-alias-border-l2,#363d4d);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#151922);overflow:hidden;}
.qm-row-head{width:100%;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;}
.qm-row-head:hover{background:var(--dsw-alias-interactive-bg-hover,#20283a);}
.qm-row-head:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4f8cff);outline-offset:-2px;}
.qm-row-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.qm-row-metric{margin-left:auto;font-weight:700;font-variant-numeric:tabular-nums;}
.qm-row-today{font-size:11px;color:var(--dsw-alias-label-secondary,#a9b2c5);font-variant-numeric:tabular-nums;}
.qm-chevron{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary,#8b94a8);}
.qm-row-detail{padding:0 10px 10px;border-top:1px solid var(--dsw-alias-border-l1,#1d2330);}
.qm-row-actions{display:flex;justify-content:flex-end;margin:8px 0;}
.qm-data-time{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b94a8);margin:6px 0;}
.qm-metric-tables{display:flex;flex-direction:column;gap:8px;margin-top:8px;overflow-x:auto;}
.qm-metric-table{width:100%;border-collapse:collapse;font-size:11px;font-variant-numeric:tabular-nums;}
.qm-metric-table th{font-weight:500;color:var(--dsw-alias-label-secondary,#a9b2c5);text-align:left;padding:4px 6px;border-bottom:1px solid var(--dsw-alias-border-l1,#1d2330);white-space:nowrap;}
/* 列头与单元格同侧：首列（指标名）左，其余数值/重置列右 */
.qm-metric-table th:not(:first-child){text-align:right;}
.qm-metric-table td{padding:4px 6px;border-bottom:1px solid var(--dsw-alias-border-l1,#1d2330);text-align:right;white-space:nowrap;}
.qm-metric-table tr:last-child th,.qm-metric-table tr:last-child td{border-bottom:none;}
.qm-tone.ok{color:var(--dsw-alias-state-success-primary,#34d399);}
.qm-tone.warn{color:var(--dsw-alias-state-warn-primary,#fbbf24);}
.qm-tone.crit{color:var(--dsw-alias-state-error-primary,#f87171);}
.qm-tone.neutral{color:var(--dsw-alias-label-primary,#dbe2ee);}
.qm-num{font-variant-numeric:tabular-nums;}
.qm-kv{display:flex;justify-content:space-between;gap:8px;font-size:11px;color:var(--dsw-alias-label-secondary,#a9b2c5);margin-top:6px;}
.qm-kv>span:first-child{color:var(--dsw-alias-label-tertiary,#8b94a8);}
.qm-split-stats{display:flex;gap:10px;flex-wrap:wrap;margin-top:8px;font-size:11px;color:var(--dsw-alias-label-secondary,#a9b2c5);}
.qm-split-stat{display:flex;align-items:center;gap:4px;}
.qm-split-stat i{width:8px;height:8px;border-radius:2px;display:inline-block;}
.qm-split-stat b{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#dbe2ee);}
.qm-split-stat .seg-warn{background:var(--dsw-alias-state-warn-primary,#fbbf24);}
.qm-split-stat .seg-ok{background:var(--dsw-alias-state-success-primary,#34d399);}
.qm-split-stat .seg-unsplit{background:var(--dsw-alias-label-tertiary,#6b7280);}
.qm-empty-line{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b94a8);margin:6px 0;}
.qm-section-head{display:flex;align-items:center;gap:6px;}
.qm-section-head h5{margin:0;}
.qm-info{display:inline-block;margin-left:4px;vertical-align:middle;}
.qm-info summary{list-style:none;cursor:pointer;color:var(--dsw-alias-label-tertiary,#8b94a8);font-size:11px;}
.qm-info summary::-webkit-details-marker{display:none;}
.qm-info p{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,#a9b2c5);margin:4px 0 0;max-width:46em;}
.qm-display-row{display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12px;color:var(--dsw-alias-label-secondary,#a9b2c5);}
.qm-display-row select{margin-left:auto;}
.qm-global summary{cursor:pointer;font-size:13px;color:var(--dsw-alias-label-secondary,#a9b2c5);list-style:none;display:flex;align-items:center;gap:6px;}
.qm-global summary::-webkit-details-marker{display:none;}
.qm-global summary::before{content:"▸";font-size:10px;color:var(--dsw-alias-label-tertiary,#5c6577);}
.qm-global[open] summary::before{transform:rotate(90deg);}
.qm-global[open] summary{margin-bottom:8px;}
.qm-unmapped{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b94a8);margin-top:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.qm-ref-state{display:block;font-size:11px;color:var(--dsw-alias-label-tertiary,#8b94a8);margin-top:-4px;}
.qm-usage-split{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:4px 10px 0;}
.qm-usage-legend{display:flex;gap:10px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary,#a9b2c5);}
.qm-usage-legend span{display:inline-flex;align-items:center;gap:4px;}
.qm-usage-legend i{width:8px;height:8px;border-radius:2px;display:inline-block;}
      `;

      function ensureStyle() {
        const tagId = "dsh-token-quota/widget.css";
        // 热替换会再次执行 apply：复用同一个 <style> 并重写内容，否则新 JS 只能配旧 CSS。
        let tag = document.querySelector(`style[data-plugin-css="${tagId}"]`);
        if (!tag) {
          tag = document.createElement("style");
          tag.dataset.plugin = "dsh-token-quota";
          tag.dataset.pluginCss = tagId;
          document.head.appendChild(tag);
        }
        tag.textContent = CSS;
      }

      // ---------- 应用入口 ----------
      const inject = ["slots", "locale", "sessions"];

      function apply(ctx) {
        ensureStyle();


        // 本地化词典（DSH 官方模式：locale.register 后由槽位注入 t）。
        // localeT 是同一份词典的绑定视图：槽位导航项（label thunk）拿不到注入的 t，用它取文案。
        let disposeLocale = null;
        let localeT = null;
        try {
          disposeLocale = ctx.locale.register(NS, LOCALES);
          localeT = typeof ctx.locale.bind === "function" ? ctx.locale.bind(NS) : null;
        } catch (error) {
          console.warn("[dsh-token-quota] locale register failed", error);
        }

        // 装配「当前显示页」订阅源：官方 sessions.list（Session Controller 客户端）。
        // 切页 → sessions.list 变化 → FooterSlotWithSession 即时重渲并带新 sessionId 重新拉 /state。
        sessionListSource = null;
        try {
          const sessions = ctx.get ? ctx.get("sessions") : ctx.sessions;
          const list = sessions?.list;
          if (list && typeof list.subscribe === "function" && typeof list.getSnapshot === "function") {
            sessionListSource = {
              getSnapshot: () => {
                try {
                  return selectedSessionId(list.getSnapshot());
                } catch {
                  return "";
                }
              },
              subscribe: (listener) => {
                try {
                  return list.subscribe(listener) || (() => {});
                } catch {
                  return () => {};
                }
              },
            };
          }
        } catch (error) {
          console.warn("[dsh-token-quota] sessions service unavailable, sidebar shows global latest", error);
        }

        displayController?.dispose();
        displayController = createDisplayController(sessionListSource);

        // 侧边栏底槽：小组件（list slot，keyed id，官方渲染契约）
        let disposeFooter = null;
        let disposeCard = null;
        try {
          disposeFooter = ctx.slots.inject("sidebar.footer.action", () =>
            ctx.slots.register({
              name: "sidebar.footer.action",
              id: "dsh-token-quota",
              locale: NS,
            }, FooterSlotWithSession),
          );
        } catch (error) {
          console.warn("[dsh-token-quota] sidebar footer slot unavailable", error);
        }

        // DSH 设置面板：本插件自成一页（0.1.7 起 settings.plugin.item 槽位已移除，
        // 列表式 settings.section 取代它；导航项文案随 locale 版本重取）。
        try {
          disposeCard = ctx.slots.inject("settings.section", () =>
            ctx.slots.register({
              name: "settings.section",
              id: NS,
              order: 20,
              label: () => (localeT ? localeT("title") : "用量监控"),
              locale: NS,
            }, SettingsSection),
          );
        } catch (error) {
          console.warn("[dsh-token-quota] settings section slot unavailable", error);
        }

        ctx.effect(() => () => {
          disposeLocale?.();
          disposeFooter?.();
          disposeCard?.();
          displayController.dispose();
          surface.close();
        }, "dsh-token-quota: slot disposers");
      }

      exports.apply = apply;
      exports.inject = inject;
      return module.exports;
    },
  });
})();
