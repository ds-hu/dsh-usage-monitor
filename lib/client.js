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
      const supplierStatus = (s, tr) => s?.state === "err"
        ? tr(s.entries?.length ? "staleFailure" : "unavailable")
        : s?.enabled === false ? tr("disabled") : !s?.entries?.length ? tr("notQueried") : tr(stateToken(s));
      const todayTotal = (state) => (state?.suppliers || []).filter(s => s.current)
        .reduce((sum, s) => sum + (typeof s.todayTokens === "number" ? s.todayTokens : 0), 0);

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
      // 面板会话只在界面存在期间持有草稿，不进入展示缓存或本地存储。
      const createPanelSession = () => ({ view: { name: "overview" }, globalForm: null, editor: null, editorId: 0, positions: {}, pendingSave: null });
      const settingsWrites = new Set();
      let panelSession = createPanelSession();
      let panelSnapshot = { popover: false, detail: false, dialog: false, page: null, focus: 0, opening: false };
      const panelListeners = new Set();
      const panelStore = {
        subscribe(fn) { panelListeners.add(fn); return () => panelListeners.delete(fn); },
        getSnapshot: () => panelSnapshot,
        update(patch) { panelSnapshot = { ...panelSnapshot, ...patch }; for (const fn of panelListeners) fn(); },
        togglePopover() { panelStore.update({ popover: !panelSnapshot.popover }); },
        closePopover() { if (panelSnapshot.popover) panelStore.update({ popover: false }); },
        openDetails() { panelStore.update({ popover: false, detail: true }); },
        closeDetails() { panelStore.update({ detail: false }); },
        open() {
          panelSession.view = { name: "overview" };
          const focus = panelSnapshot.focus + 1;
          const waiting = panelSnapshot.opening || (!panelSnapshot.dialog && !panelSnapshot.page && settingsWrites.size > 0);
          panelStore.update({ popover: false, detail: false, dialog: !panelSnapshot.page, focus, opening: waiting });
          if (waiting) void Promise.allSettled([...settingsWrites].map(operation => operation.promise)).then(() => displayController.reload()).finally(() => {
            if (panelSnapshot.focus === focus) panelStore.update({ opening: false });
          });
        },
        close() { panelSession = createPanelSession(); panelStore.update({ popover: false, detail: false, dialog: false, opening: false }); },
      };
      const usePanel = () => React.useSyncExternalStore(panelStore.subscribe, panelStore.getSnapshot, panelStore.getSnapshot);

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
      const queryOf = (sessionId) => (sessionId === undefined ? "" : `?session=${encodeURIComponent(sessionId || "")}`);

      /** GET /state：校验 HTTP 状态与载荷 ok 字段；signal 释放请求，超时由局部 helper 统一管理。 */
      const getState = async (sessionId, { signal } = {}) => {
        const guard = timeoutController(signal, REQUEST_TIMEOUT_MS);
        try {
          const response = await fetch(`${API}/state${queryOf(sessionId)}`, { cache: "no-store", signal: guard.signal });
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
        return { ...snapshot, refresh: displayController.refresh };
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

      // 宿主在视口 <1024px 时自动收起侧栏（@deepseek-ai/dsh-client-ui-layout 的
      // SIDEBAR_AUTO_COLLAPSE）。该布局下锚定图标栏的浮卡在手机上是多余的一跳：
      // 点击入口直接给独立详情，详情头部本来就有「刷新」与「设置」。桌面宽布局保持浮卡。
      const MOBILE_LAYOUT_QUERY = "(max-width: 1023px)";
      const mobileMedia = () => typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia(MOBILE_LAYOUT_QUERY) : null;
      const subscribeMobileLayout = (onChange) => {
        const media = mobileMedia();
        if (!media) return () => {};
        if (typeof media.addEventListener === "function") {
          media.addEventListener("change", onChange);
          return () => media.removeEventListener("change", onChange);
        }
        media.addListener(onChange);
        return () => media.removeListener(onChange);
      };
      const isMobileLayout = () => !!mobileMedia()?.matches;
      const useMobileLayout = () => React.useSyncExternalStore(subscribeMobileLayout, isMobileLayout, isMobileLayout);

      function FooterWidget({ wide, t }) {
        const entryRef = React.useRef(null), widthRef = React.useRef(null);
        const preference = useDensity(), panel = usePanel();
        const mobileLayout = useMobileLayout();
        const [narrow, setNarrow] = React.useState(false);
        const { state, loadError } = useQuotaState();
        // 手机／窄布局一次点击直达详情；宽布局仍是先浮卡。展开态如实反映当前打开的那一层，
        // 视口跨过断点时也不会把开着的浮卡说成收起。
        const activateEntry = () => (mobileLayout ? panelStore.openDetails() : panelStore.togglePopover());
        const entryExpanded = panel.detail || panel.popover;
        React.useEffect(() => () => panelStore.closePopover(), []);
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
        // 第 1 行只报 plan 名（= 供应商名）：模型名不进卡片。
        const name = active?.name || t("noneActive");
        // 第 2 行：关注限额（可多条，各带自己的百分比与裸倒计时）；没有可画的条目才回落成主指标文字。
        const bars = selectBarMetrics(supplier, t);
        const barText = bars.length ? bars.map(bar => `${bar.entry.name} ${pctText(bar.entry.pct)}`).join(" · ") : null;
        const resetText = bars.length ? bars.map(bar => bar.reset).filter(Boolean).join(" · ") : metric.reset;
        const failure = loadError ? t(state ? "staleFailure" : "unavailable") : supplier?.state === "err" ? supplierStatus(supplier, t) : "";
        const conn = connStateOf(state);
        const connText = t(conn.key === "ok" ? "eventsObserved" : conn.key === "warn" ? "connWarn" : "connStandby");
        // 时段常显（不绑定在用供应商）：DeepSeek 的峰谷价是账户级事实，看其他供应商时也有意义。
        // 紧凑模式的字符预算不够，文案整体进 title/aria-label，行内不加。
        const season = state?.season || null;
        // 倒计时每秒都在变，渲染一次取一次，避免两处各算一次导致文案与 title 不一致。
        const seasonCount = season ? seasonCountdown(season, t) : null;
        const seasonTitle = season
          ? [seasonLabelOf(season, t), seasonCount, `${t("seasonBeijingNow")} ${season.beijing?.weekday || ""} ${season.beijing?.clock || ""}`.trim(),
            seasonUsesBeijingNote() ? t("seasonBeijingOnly") : null].filter(Boolean).join(" · ")
          : "";
        // 卡片自身不再显示模型名与连接圆点，但无障碍标签仍要能读到状态（含连接健康度）。
        const title = [name, barText || metric.text, resetText, seasonTitle, failure, t("todayScope"), t("today", { n: state ? fmtBig(todayTotal(state)) : "—" }), connText].filter(Boolean).join(" · ");
        return h(React.Fragment, null,
          !wide ? h("button", { type: "button", ref: entryRef, "data-qm-entry": "", className: "qm-rail", "aria-label": t("title"), "aria-haspopup": "dialog", "aria-expanded": entryExpanded, title, onClick: activateEntry }, "◉") :
          h("div", { "data-qm-linerow": "", "data-qm-density": compact ? "compact" : "expanded", ref: widthRef, className: "qm-footer" },
            h("button", { type: "button", ref: entryRef, "data-qm-entry": "", className: "qm-strip", title, "aria-label": title, "aria-haspopup": "dialog", "aria-expanded": entryExpanded, onClick: activateEntry },
              compact ? h("div", { className: "qm-compact-line" }, h("span", { className: "qm-provider" }, name),
                h("span", { className: "qm-primary" },
                  h("span", { className: "qm-metric-name" }, failure || [metric.name, metric.kind === "quota" ? t("usedShort") : metric.label].filter(Boolean).join(" ")),
                  h("strong", { className: "qm-metric-value" }, metric.value),
                  metric.more > 0 ? h("span", { className: "qm-more", title: t("moreMetrics", { n: metric.more }) }, `+${metric.more}`) : null)) :
              h(React.Fragment, null,
                h("div", { className: "qm-l1" }, h("b", { className: "qm-plan", title: name }, name), failure ? h("span", { className: "qm-fetch-status" }, failure) : null),
                // 有百分比才画条：未知/缺失绝不折成 0% 的空条，回落成原来的主指标文字。
                bars.length ? h("div", { className: "qm-bars" }, bars.flatMap((bar, i) => [
                  h("span", { key: `l${i}`, className: "qm-bar-label", title: bar.entry.name }, bar.label),
                  h("span", { key: `b${i}`, className: "qm-bar", "data-qm-bar": "", "data-qm-tone": bar.tone, "data-qm-window": bar.weekly ? "week" : "other",
                    role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": bar.entry.pct,
                    "aria-label": t("barAria", { name: bar.entry.name, pct: pctText(bar.entry.pct) }) },
                    h("i", { className: `qm-bar-fill ${bar.tone}`, style: { width: `${Math.max(0, Math.min(100, bar.entry.pct))}%` } })),
                  h("span", { key: `p${i}`, className: "qm-bar-pct" }, pctText(bar.entry.pct)),
                  // 每条自带自己的重置倒计时：条与时刻必须属于同一个窗口，不借用别人的
                  bar.reset ? h("span", { key: `r${i}`, className: "qm-bar-reset" }, bar.reset) : null,
                ])) : h("div", { className: "qm-l2" }, h("span", { className: "qm-primary", title: metric.text }, metric.text)),
                season ? h("div", { className: `qm-season ${season.peak ? "peak" : "valley"}`, "data-qm-season": season.tier, title: seasonTitle },
                  h("span", { className: `qm-season-dot ${season.peak ? "peak" : "valley"}` }),
                  h("b", null, seasonTierOf(season, t)),
                  seasonCount ? h("span", null, ` · ${seasonCount}`) : null,
                  seasonUsesBeijingNote() ? h("span", { className: "qm-season-note" }, ` · ${t("seasonBeijingOnly")}`) : null,
                ) : null),
            ),
            h("button", { type: "button", className: "qm-density", "aria-label": t(compact ? "expand" : "collapse"), title: t(compact ? "expand" : "collapse"),
              onClick: () => preferences.set(compact ? "expanded" : "compact") }, compact ? "▾" : "▴")),
          panel.popover ? createPortal(h(UsagePopover, { t, anchorRef: entryRef }), document.body) : null,
          panel.detail ? createPortal(h(DetailModal, { t, returnFocusRef: entryRef }), document.body) : null,
          panel.dialog && !panel.page ? createPortal(h(MonitorPanel, { t, onClose: panelStore.close, variant: "dialog", returnFocusRef: entryRef }), document.body) : null);
      }
      function FooterSlotWithSession(props) { return h(FooterWidget, props); }

      function UsagePopover({ t, anchorRef }) {
        const { state, refresh, refreshing, loadError } = useQuotaState();
        const cardRef = React.useRef(null), restoreFocus = React.useRef(true);
        const [style, setStyle] = React.useState({ visibility: "hidden" });
        React.useLayoutEffect(() => {
          const place = () => {
            const anchor = anchorRef.current, card = cardRef.current;
            if (!anchor || !card) return;
            const rect = anchor.getBoundingClientRect();
            const width = Math.min(320, Math.max(0, window.innerWidth - 16));
            const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
            const above = Math.max(0, rect.top - 16), below = Math.max(0, window.innerHeight - rect.bottom - 16);
            const onTop = above >= Math.min(card.scrollHeight, 240) || above >= below;
            setStyle({ left, width, ...(Math.max(above, below) < 80
              ? { top: 8, maxHeight: Math.max(0, window.innerHeight - 16) }
              : onTop ? { bottom: window.innerHeight - rect.top + 8, maxHeight: above }
                : { top: rect.bottom + 8, maxHeight: below }) });
          };
          place();
          const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
          if (cardRef.current) observer?.observe(cardRef.current);
          if (anchorRef.current) observer?.observe(anchorRef.current);
          window.addEventListener("resize", place);
          window.addEventListener("scroll", place, true);
          return () => { observer?.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
        }, [anchorRef]);
        React.useEffect(() => {
          const node = cardRef.current;
          if (!node) return;
          node.querySelector("button")?.focus();
          const dismiss = event => {
            if (node.contains(event.target) || anchorRef.current?.contains(event.target)) return;
            restoreFocus.current = false; panelStore.closePopover();
          };
          const onKey = event => {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); panelStore.closePopover(); }
          };
          const onFocus = event => {
            if (!node.contains(event.target) && !anchorRef.current?.contains(event.target)) {
              restoreFocus.current = false; panelStore.closePopover();
            }
          };
          document.addEventListener("pointerdown", dismiss, true);
          document.addEventListener("keydown", onKey, true);
          document.addEventListener("focusin", onFocus);
          return () => {
            document.removeEventListener("pointerdown", dismiss, true);
            document.removeEventListener("keydown", onKey, true);
            document.removeEventListener("focusin", onFocus);
            if (restoreFocus.current && anchorRef.current?.isConnected) anchorRef.current.focus();
          };
        }, [anchorRef]);
        const suppliers = (state?.suppliers || []).filter(s => s.added !== false);
        const updated = typeof state?.now === "number" ? new Date(state.now).toLocaleTimeString() : state?.now || "—";
        // 浮卡不再重复计费时段：档位与倒计时由常驻卡片最后一行常显，成因与缺次年告警在明细/设置里。
        return h("div", { ref: cardRef, className: "qm-pop", role: "dialog", "aria-label": t("quickTitle"), tabIndex: -1, style },
          h("div", { className: "qm-pop-head" }, h("b", null, t("quickTitle")), h("span", null,
            t("poll", { n: state?.poll?.intervalSeconds ?? 60 }),
            h("button", { type: "button", className: "qm-pop-btn", disabled: refreshing, onClick: refresh }, refreshing ? t("refreshing") : `⟳ ${t("refresh")}`))),
          loadError ? h("div", { role: "alert", className: "qm-srow-status err" }, `${t(state ? "staleFailure" : "unavailable")}：${loadError}`) : null,
          !state ? h("p", { role: "status", className: "qm-pop-empty" }, t(loadError ? "unavailable" : "loading")) :
            !suppliers.length ? h("p", { className: "qm-pop-empty" }, t("overviewEmpty")) :
              h("div", { className: "qm-srows" }, suppliers.map(sup => {
                const metric = selectPrimaryMetric(sup, t);
                const split = seasonSplitText(sup.seasonSplit, t);
                return h("article", { key: sup.id, className: "qm-srow", "data-supplier": sup.id },
                  h("div", { className: "qm-srow-main" }, h("span", { className: `qm-dot ${stateClass(sup)}` }),
                    h("b", { className: "qm-srow-name" }, sup.name), h("strong", { className: `qm-srow-head ${metric.tone}` }, metric.value)),
                  sup.entries?.length ? h("div", { className: "qm-srow-entry" }, [metric.name, metric.reset, metric.more > 0 ? t("moreMetrics", { n: metric.more }) : null].filter(Boolean).join(" · ")) : null,
                  // 峰谷拆分只在宿主给了拆分（= DeepSeek）时出现，其他供应商不串口径
                  split ? h("div", { className: "qm-srow-entry qm-season-split", "data-qm-season-split": sup.id }, `${t("seasonSplitLabel")} ${split}`) : null,
                  sup.state === "err" || sup.enabled === false || !sup.entries?.length
                    ? h("div", { className: `qm-srow-status ${sup.state === "err" ? "err" : ""}`, title: sup.error?.message || "" },
                      sup.state === "err" ? "⚠ " : "", supplierStatus(sup, t)) : null);
              })),
          h("div", { className: "qm-pop-foot" }, h("span", { className: "qm-pop-time" }, `${t("lastRefresh")} ${updated}`),
            h("div", { className: "qm-pop-actions" },
              h("button", { type: "button", className: "qm-pop-btn", onClick: panelStore.openDetails }, t("detail")),
              h("button", { type: "button", className: "qm-pop-btn", onClick: panelStore.open }, t("settings")),
              h("button", { type: "button", className: "qm-pop-btn", onClick: panelStore.closePopover }, t("close")))));
      }

      function EntryCard({ e, t, supplier, warnPct, critPct, detail = false }) {
        const view = buildEntryView(e, supplier || { warnPct, critPct }, t);
        return h("div", { className: "qm-card-item", "data-metric-kind": view.kind },
          h("div", { className: "ci-name" }, h("span", null, view.name), view.reset || detail ? h("span", null, view.reset || "—") : null),
          h("div", { className: `ci-big ${view.tone}` }, view.value, view.warning ? h("span", { className: "qm-warning" }, ` · ${view.warning}`) : null),
          view.kind === "quota" ? h("div", { className: "ci-row" }, h("span", null, `${t("quota")} ${displayValue(e.limit)}`), h("span", null, `${t("usedShort")} ${displayValue(e.used)}`)) : null,
          view.note ? h("div", { className: "ci-row" }, view.note) : null);
      }
      function SupplierMetrics({ supplier, t, detail = false }) {
        const groups = new Map();
        const error = String(supplier.error?.message || supplier.error?.code || "");
        for (const e of supplier.entries || []) {
          const key = buildEntryView(e, supplier, t).kind;
          if (!groups.has(key)) groups.set(key, []); groups.get(key).push(e);
        }
        return h(React.Fragment, null,
          supplier.state === "err" ? h("div", { className: "ci-err", role: "status" }, supplierStatus(supplier, t), error ? `：${error.slice(0, 180)}` : "",
            error.length > 180 ? h("details", null, h("summary", null, t("errorDetails")), h("p", null, error)) : null) : null,
          supplier.lastSuccessAt ? h("div", { className: "pnote" }, `${t("lastSuccess")} ${new Date(supplier.lastSuccessAt).toLocaleString()}`) : null,
          groups.size ? detail ? supplier.entries.map((e, i) => h(EntryCard, { key: i, e, t, supplier, detail: true })) : [...groups].map(([kind, entries]) => h("section", { key: kind, className: "qm-metric-group" }, h("h6", null, t(kind)),
            entries.map((e, i) => h(EntryCard, { key: i, e, t, supplier })))) : h("p", { className: "pnote" }, supplierStatus(supplier, t)));
      }

      /**
       * 关注限额：供应商卡片第 2 行画哪些条目（有序多选）。
       * 候选项 = 上次成功查询里带 key 且有百分比的条目（当前不可用但已勾选的行也保留，标灰）。
       * 勾选顺序即卡片排列顺序；全不勾 = 默认规则（周窗口优先 → 最紧窗口）。
       * 没有候选也没有已勾选项（纯余额/报告费用供应商）时整段不出现 —— 不写「本供应商不支持」这类空话。
       */
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
          h("h5", null, t("watchTitle"),
            watchedKeys.length > 1 ? h("span", { className: "w-hint" }, ` · ${t("watchHint")}`) : null),
          h("div", { className: "qm-watch" }, rows.map(({ key, entry, watched }) => {
            const index = watchedKeys.indexOf(key);
            return h("div", { key, className: `w-row${watched ? " watched" : ""}${entry ? "" : " off"}` },
              h("input", { type: "checkbox", checked: watched, disabled, onChange: (e) => toggle(key, e.target.checked) }),
              h("span", { className: "w-name", title: entry?.name || key }, entry?.name || key),
              h("span", { className: "w-val" }, entry ? pctText(entry.pct) : t("watchUnavailable")),
              h("span", { className: "w-move" },
                h("button", { type: "button", disabled: disabled || index <= 0, "aria-label": t("moveUp"), title: t("moveUp"), onClick: () => move(index, -1) }, "↑"),
                h("button", { type: "button", disabled: disabled || index >= watchedKeys.length - 1, "aria-label": t("moveDown"), title: t("moveDown"), onClick: () => move(index, 1) }, "↓")));
          })),
          // 默认规则只在「一条都没勾」时说明：勾了就是在覆盖它，不必再占一行
          watchedKeys.length ? null : h("p", { className: "pnote" }, t("watchDefaultHint")));
      }

      function DetailModal({ t, returnFocusRef }) {
        const { state, refresh, refreshing, loadError } = useQuotaState();
        const dialogRef = useDialog(panelStore.closeDetails, returnFocusRef);
        const shown = (state?.suppliers || []).filter(s => s.added !== false);
        const history = (state?.history || []).slice(0, 50);
        const season = state?.season || null;
        return h("div", { className: "qm-overlay", onClick: ev => ev.target === ev.currentTarget && panelStore.closeDetails() },
          h("div", { ref: dialogRef, tabIndex: -1, className: "qm-card qm-details", role: "dialog", "aria-modal": true, "aria-label": t("detailTitle") },
            h("div", { className: "qm-panel-head" }, h("h3", null, t("detailTitle")),
              h("button", { type: "button", disabled: refreshing, onClick: refresh }, t(refreshing ? "refreshing" : "refresh")),
              h("button", { type: "button", onClick: panelStore.open }, t("settings")),
              h("button", { type: "button", onClick: panelStore.closeDetails }, t("close"))),
            h("div", { className: "qm-sub" }, `${t("detailAdded", { n: shown.length })} · ${t("poll", { n: state?.poll?.intervalSeconds ?? 60 })}`),
            state?.storageError ? h("div", { role: "alert", className: "ci-err" }, state.storageError) : null,
            loadError ? h("div", { role: "alert", className: "ci-err" }, `${t(state ? "staleFailure" : "unavailable")}：${loadError}`) : null,
            !state ? h("p", { role: "status" }, t(loadError ? "unavailable" : "loading")) :
              h("div", { className: "qm-cols" }, shown.map(sup => h("article", { key: sup.id, className: "qm-col", "data-supplier": sup.id },
                h("h5", null, h("span", null, sup.name, sup.current ? h("span", { className: "qm-cur" }, ` · ${t("current")}`) : null),
                  h("span", { className: `qm-pill ${stateClass(sup)}` }, supplierStatus(sup, t))),
                // 今日用量原先在卡片第 3 行；卡片只留监控项，数字搬到这里（各供应商自己的口径）
                h("div", { className: "qm-today-line" }, t("today", { n: fmtBig(typeof sup.todayTokens === "number" ? sup.todayTokens : 0) })),
                // 峰谷只挂在 DeepSeek 那一栏：拆分的存在本身就是「这个供应商适用峰谷价」的证据
                season && sup.seasonSplit ? h("div", { className: "qm-season-block", "data-qm-season-block": season.tier },
                  h("div", { className: "qm-season-row" },
                    h("span", null, t("seasonTier")),
                    h("span", { className: `qm-season ${season.peak ? "peak" : "valley"}` },
                      h("span", { className: `qm-season-dot ${season.peak ? "peak" : "valley"}` }),
                      h("b", null, seasonLabelOf(season, t)))),
                  h("div", { className: "qm-season-row" },
                    h("span", null, t("seasonNext")),
                    h("span", null, seasonCountdown(season, t) || "—")),
                  season.beijing ? h("div", { className: "qm-season-row" },
                    h("span", null, t("seasonBeijingNow")),
                    h("span", null, `${season.beijing.weekday} ${season.beijing.clock}${seasonUsesBeijingNote() ? ` · ${t("seasonBeijingOnly")}` : ""}`)) : null,
                  seasonSplitText(sup.seasonSplit, t) ? h("div", { className: "qm-season-row qm-season-split" },
                    h("span", null, t("seasonSplitLabel")), h("span", null, seasonSplitText(sup.seasonSplit, t))) : null,
                  season.warning ? h("div", { className: "qm-season-warn", role: "status" }, season.warning) : null) : null,
                h(SupplierMetrics, { supplier: sup, t, detail: true })))),
            state && !shown.length ? h("p", { className: "qm-empty" }, t("overviewEmpty")) : null,
            h("details", { className: "qm-history" }, h("summary", { tabIndex: 0 }, t("historySummary", { n: history.length })),
              h("div", { className: "qm-history-scroll", tabIndex: 0, role: "region", "aria-label": t("historySummary", { n: history.length }) },
                h("table", null,
                  h("thead", null, h("tr", null, ...["colTime", "colSupplier", "colTier", "colResult", "colMain", "colNote"].map(key => h("th", { key, scope: "col" }, t(key))))),
                  h("tbody", null, history.map((row, i) => h("tr", { key: i }, h("td", null, row.t), h("td", null, row.supplier),
                    // 刷新当时的计费时段：历史按当时规则标注，未知（早于峰谷定价）显示 —
                    h("td", { className: row.tier === "peak" ? "h-peak" : row.tier === "valley" ? "h-valley" : "" },
                      row.tier === "peak" ? t("seasonPeak") : row.tier === "valley" ? t("seasonValley") : "—"),
                    h("td", { className: row.ok ? "h-ok" : "h-bad" }, t(row.ok ? "colOk" : "colFail")), h("td", null, row.summary), h("td", null, row.error || "")))))))));
      }


      // ---------- 共用监控面板 ----------
      // 设置面板本体：设置页 section（variant="page"，嵌在设置面板里）与小组件弹层
      // （variant="dialog"，遮罩 + 对话框语义）共用同一份内容与同一套保存路径。
      function MonitorPanel({ t, onClose, variant = "dialog", returnFocusRef }) {
        const { state, refresh, refreshing, loadError } = useQuotaState();
        const panel = usePanel(), density = useDensity();
        const [view, setViewLocal] = React.useState(panelSession.view);
        const viewRef = React.useRef(view);
        const setView = (next) => { panelSession.view = next; viewRef.current = next; setViewLocal(next); };
        const [globalForm, setGlobalLocal] = React.useState(panelSession.globalForm);
        const setGlobalForm = (next) => setGlobalLocal(old => { const value = typeof next === "function" ? next(old) : next; panelSession.globalForm = value; return value; });
        const [editor, setEditorLocal] = React.useState(panelSession.editor);
        const setEditor = (next) => setEditorLocal(old => { const value = typeof next === "function" ? next(old) : next; panelSession.editor = value; return value; });
        const [confirmation, setConfirmation] = React.useState(null);
        const [advanced, setAdvanced] = React.useState(false);
        const [filter, setFilter] = React.useState("all");
        const comparable = form => ({ ...form, warnPct: Number(form.warnPct), critPct: Number(form.critPct) });
        const dirty = !!editor && JSON.stringify(comparable(editor.form)) !== JSON.stringify(comparable(editor.initial));
        // globalDirty 决定「放弃修改」确认框是否出现：节假日覆盖表也算用户改动，
        // 否则清空覆盖表后直接关面板会静默丢弃这次编辑。
        const globalDirty = !!globalForm && (Number(globalForm.intervalSeconds) !== (state?.poll?.intervalSeconds ?? 60)
          || Number(globalForm.retentionDays) !== (state?.poll?.retentionDays ?? 7)
          || holidaysTextOf(globalForm.holidays) !== holidaysTextOf(state?.holidays));
        const guarded = (action, all = false) => { if (dirty || (all && globalDirty)) setConfirmation(() => action); else action(); };
        const requestClose = () => guarded(onClose, true);
        const dialogRef = useDialog(requestClose, returnFocusRef, variant === "dialog");
        const scrollContainer = () => {
          let node = dialogRef.current;
          while (node) {
            if (/(auto|scroll)/.test(window.getComputedStyle?.(node).overflowY || "")) return node;
            node = node.parentElement;
          }
          return document.scrollingElement || dialogRef.current;
        };
        const rememberPosition = () => { panelSession.positions[view.name] = scrollContainer()?.scrollTop || 0; };
        const advancedRef = React.useRef(null);
        React.useEffect(() => { if (panel.focus) { setView(panelSession.view); dialogRef.current?.querySelector("h3")?.focus(); } }, [panel.focus]);
        // 表单里 holidays 一律按文本框字符串保存（每行一个日期）：这样「脏检查」两侧同型，
        // 也避免把数组直接塞进 textarea 的 value（数组会被隐式拼成逗号串，回读就变样）。
        React.useEffect(() => { if (state && !panel.opening && !globalForm) setGlobalForm({ intervalSeconds: state.poll?.intervalSeconds ?? 60, retentionDays: state.poll?.retentionDays ?? 7, holidays: holidaysTextOf(state.holidays ?? []) }); }, [state, panel.opening]);
        React.useLayoutEffect(() => { const node = scrollContainer(); if (node) node.scrollTop = panelSession.positions[view.name] || 0; }, [view.name]);
        const [testState, setTestState] = React.useState({});
        const [saved, setSaved] = React.useState(null); // 'global' | supplierId
        const [saveError, setSaveError] = React.useState(null);
        const [scanBusy, setScanBusy] = React.useState(false); // 重新扫描进行中
        const [freshIds, setFreshIds] = React.useState([]); // 重扫新发现的「可添加」项 id（高亮 + 自动展开）
        const addableRef = React.useRef(null);

        // ---- 异步操作身份（A2）----
        // 关闭/返回目录/切换编辑器都会让在途回调失去回写资格；但已经发出的设置保存仍可能成功，
        // 重新打开时以服务端为准，不自动重试结果不确定的保存。
        const opRef = React.useRef({ editorId: panelSession.editorId, opSeq: 0, revision: editor?.revision || 0 });
        const testSeq = React.useRef(0);
        const mountedRef = React.useRef(true);
        React.useEffect(() => {
          const session = panelSession;
          mountedRef.current = true;
          return () => {
            mountedRef.current = false;
            // 接管保留面板会话；真正销毁对话框时清理秘密草稿。
            if (variant === "dialog" && !panelStore.getSnapshot().page && panelSession === session) panelStore.close();
          };
        }, []);
        const inheritedSave = panelSession.pendingSave?.editorId === panelSession.editorId ? panelSession.pendingSave : null;
        const [opBusy, setOpBusy] = React.useState(!!inheritedSave);
        const opBusyRef = React.useRef(!!inheritedSave);
        const [testBusy, setTestBusy] = React.useState(null);
        const [toggling, setToggling] = React.useState({});
        const togglingRef = React.useRef(new Set());
        const nextEditorId = () => { const id = ++opRef.current.editorId; panelSession.editorId = id; opRef.current.revision = 0; return id; };
        const discardEditor = () => { nextEditorId(); testSeq.current++; setTestBusy(null); opBusyRef.current = false; setOpBusy(false); setEditor(null); setView({ name: editor?.origin || "suppliers" }); setSaveError(null); };
        const closeEditor = () => guarded(discardEditor);
        const reload = React.useCallback(() => displayController.reload(), []);
        React.useEffect(() => { if (editor) { opRef.current.editorId = editor.editorId; opRef.current.revision = editor.revision; } }, []);
        // 原生设置分区接管时继承同一保存锁；结算只影响同一编辑身份。
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
              if (viewRef.current.name === "supplier") setView({ name: editor.origin || "suppliers" });
              setEditor(null); nextEditorId();
            }
          });
        }, []);
        const beginSave = (supplierId, trackOnly = false) => {
          const session = panelSession;
          let resolve;
          const promise = new Promise(done => { resolve = done; });
          const pending = { supplierId, promise, editorId: opRef.current.editorId };
          if (!trackOnly) session.pendingSave = pending;
          settingsWrites.add(pending);
          return result => {
            if (session.pendingSave === pending) session.pendingSave = null;
            settingsWrites.delete(pending); resolve(result); panelStore.update({});
          };
        };

        // 每个供应商一个独立配置页（参考 Token-Consumption-Monitoring 的页面模型）
        const openSupplier = (id) => {
          const sup = (state?.suppliers || []).find((s) => s.id === id);
          if (!sup) return;
          if (editor?.supplierId === id) { setView({ name: "supplier", id }); return; }
          if (dirty) { setConfirmation(() => () => { setEditor(null); enterSupplier(sup); }); return; }
          enterSupplier(sup);
        };
        const enterSupplier = (sup) => {
          const id = sup.id;
          const pending = [...settingsWrites].find(operation => operation.supplierId === id);
          if (pending) {
            const identity = nextEditorId();
            setEditor(null); setView({ name: "supplier", id });
            void pending.promise.then(async () => {
              await reload();
              if (!mountedRef.current || opRef.current.editorId !== identity || viewRef.current.name !== "supplier" || viewRef.current.id !== id) return;
              const saved = displayController.getSnapshot().state?.suppliers?.find(s => s.id === id);
              if (saved) openSupplierClean(saved);
            });
            return;
          }
          openSupplierClean(sup);
        };
        const openSupplierClean = (sup) => {
          rememberPosition();
          const id = sup.id;
          const form = supplierDraft(sup);
          const editorId = nextEditorId(); // 同一供应商的两次编辑必须能区分
          setEditor({ editorId, supplierId: id, form, initial: { ...form }, origin: view.name === "supplier" ? "suppliers" : view.name, revision: 0 });
          setAdvanced(false);
          setView({ name: "supplier", id });
          testSeq.current++;
          setTestState({});
          setTestBusy(null);
          setSaved(null);
          setSaveError(null);
          setOpBusy(false);
          opBusyRef.current = false;
        };
        const setEditorField = (key, value) => {
          opRef.current.revision++; // ref 先行：异步回调在任何一次渲染之后都能读到最新修订号
          testSeq.current++;        // 已发出的测试结果失效；其「测试中…」提示也不再属于新草稿
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
          // 节假日覆盖表在前端解析（每行一个或逗号/空格分隔），再让宿主逐条校验：
          // 宿主会拒绝而不是静默丢弃，所以这里必须把非法项原样传过去暴露出来。
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
          const { editorId, supplierId, form } = editor;
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
            const p = supplierPatch(sup, form); // 表单快照：保存期间的表单变化不进入本次请求
            await post(`${API}/settings`, { suppliers: { [supplierId]: p } });
            await reload(); // 保存已提交时始终刷新共享状态，UI 回写另行校验身份。
            outcome = { ok: true };
            if (!latest()) return;
            setSaved(supplierId);
            opBusyRef.current = false;
            setOpBusy(false);
            if (viewRef.current.name === "supplier") setView({ name: editor.origin || "suppliers" });
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
        /** 连接测试：绑定 editorId 与草稿修订号；改了字段后旧结果不得再显示为当前草稿的结果。 */
        const runTest = (id) => {
          const sup = (state?.suppliers || []).find((s) => s.id === id);
          const editing = editor?.supplierId === id ? editor : null;
          const editorId = editing ? opRef.current.editorId : null;
          const revision = editing ? opRef.current.revision : null;
          const config = editing ? supplierPatch(sup, editing.form) : undefined;
          const seq = ++testSeq.current;
          setTestState((x) => ({ ...x, [id]: t("testing") }));
          setTestBusy(id);
          // 判定必须读 ref（发起时的闭包会停留在旧渲染上，读闭包变量会误判为「仍是当前草稿」）
          const stillCurrent = () => mountedRef.current && seq === testSeq.current
            && (!editing || opRef.current.editorId === editorId && opRef.current.revision === revision);
          post(`${API}/test`, { supplier: id, config })
            .then((r) => { if (stillCurrent()) setTestState((x) => ({ ...x, [id]: r })); })
            .catch((error) => { if (stillCurrent()) setTestState((x) => ({ ...x, [id]: { ok: false, error: error.message } })); })
            .finally(() => { if (mountedRef.current && seq === testSeq.current) setTestBusy(null); });
        };

        // R2：手动重新扫描 = 复用宿主周期自动探测（自动启用/官方 BaseURL/密钥拷贝，幂等）
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
            const fresh = nowAddable.filter((s) => !prevAddable.has(s.id)).map((s) => s.id);
            setFreshIds(fresh);
            // 发现新的可添加供应商 → 自动展开列表并高亮新增项
            if (fresh.length) requestAnimationFrame(() => { if (addableRef.current) addableRef.current.open = true; });
          } catch (error) {
            if (!mountedRef.current) return;
            setSaveError(t("scanLineFail", { err: error.message }));
            console.error("[dsh-token-quota] rescan failed", error);
            await reload(); // 保留旧状态并刷新一次（标题行将显示 detect.error）
          } finally {
            if (mountedRef.current) setScanBusy(false);
          }
        };

        // 字段标签/占位（按供应商 needs 元数据）
        const needsLabel = (sup, need) => {
          if (need.key === "apiKey") return t(sup.meta?.credentialLabelKey || "apiKey");
          if (need.key === "allowanceToken") return t("allowanceToken");
          if (need.key === "orgId") return t("orgId");
          return need.label || need.key;
        };
        const secretPlaceholder = (sup, need) => {
          if (sup[`${need.key}Set`]) return t("keySet");
          if (need.key === "apiKey" && sup.apiKeyEnv) {
            return sup.keyRefResolved
              ? t("keyRefResolved", { env: sup.apiKeyEnv })
              : t("keyRefMissing", { env: sup.apiKeyEnv });
          }
          if (need.key === "apiKey" && sup.autoDetected && sup.envKeySet) {
            return t("keyAuto", { env: sup.autoEnvName || t("dshKey") });
          }
          return t("keyEmpty");
        };


        const testResult = (id) => {
          const r = testState[id];
          if (!r) return null;
          if (typeof r === "string") return h("span", { className: "s-test-res bad" }, r);
          return h("span", { className: `s-test-res ${r.ok ? "ok" : "bad"}` }, r.ok ? t("testOk") : (r.error || t("testFail")));
        };
        const savedBanner = saved
          ? h("div", { className: "s-saved", style: { marginBottom: 8 } }, t("saved"))
          : null;

        // ---- 主视图：全局设置 + 供应商页目录（每页进入独立配置） ----
        const renderSettings = () => h(React.Fragment, null,
          h("div", { className: "s-group" },
            h("h5", null, h("span", null, t("global"))),
            h("div", { className: "s-grid" },
              h("label", null, t("interval"),
                h("input", { type: "number", min: 10, max: 3600,
                  value: globalForm?.intervalSeconds ?? 60, disabled: opBusy || [...settingsWrites].some(operation => operation.supplierId === null),
                  onChange: (e) => setGlobalForm((g) => ({ ...g, intervalSeconds: e.target.value })) }),
              ),
              h("label", null, t("retention"),
                h("input", { type: "number", min: 1, max: 90,
                  value: globalForm?.retentionDays ?? 7, disabled: opBusy || [...settingsWrites].some(operation => operation.supplierId === null),
                  onChange: (e) => setGlobalForm((g) => ({ ...g, retentionDays: e.target.value })) }),
              ),
            ),
            // 峰谷时段的节假日覆盖表：内置表只覆盖国务院已公布年份，缺次年会把工作日假期
            // 静默当成峰价，所以这里给一个显式入口，而不是让用户去改配置文件。
            h("label", { className: "qm-holidays" }, t("holidaysLabel"),
              h("textarea", { rows: 4, spellCheck: false, placeholder: t("holidaysPlaceholder"),
                "aria-label": t("holidaysLabel"), disabled: opBusy || [...settingsWrites].some(operation => operation.supplierId === null),
                value: globalForm?.holidays ?? "", onChange: (e) => setGlobalForm((g) => ({ ...g, holidays: e.target.value })) }),
            ),
            h("p", { className: "pnote" }, t("holidaysHint")),
            // 缺次年必须点名，且要点在能立即修正的地方（浮卡不再有时段块，这里就是覆盖表的旁边）。
            state?.season?.warning ? h("div", { className: "qm-season-warn", role: "status" }, state.season.warning) : null,
            h("div", { className: "s-row", style: { justifyContent: "flex-end" } },
              h("button", { type: "button", className: "qm-pri", disabled: opBusy || [...settingsWrites].some(operation => operation.supplierId === null), onClick: saveGlobal }, t("save")),
            ),
          ),
          h("div", { className: "s-group" }, h("h5", null, t("sidebarDisplay")),
            h("p", { className: "pnote" }, t("browserOnly")),
            h("select", { "aria-label": t("sidebarDisplay"), value: density, onChange: e => preferences.set(e.target.value) },
              h("option", { value: "expanded" }, t("expanded")), h("option", { value: "compact" }, t("compact")))));
        const renderSuppliers = () => h(React.Fragment, null,
          (() => {
            // R1：主目录只列「已添加」（宿主推导 sup.added）；未添加进底部「可添加」折叠列表
            const all = state.suppliers || [];
            const addedList = all.filter((s) => s.added !== false);
            const addableList = all.filter((s) => s.added === false);
            const order = (list) => [...list].sort((a, b) =>
              a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
            const ordered = order(addedList);
            const det = state.detect || {};
            const scanLine = () => {
              const time = det.at ? String(det.at) : null;
              if (scanBusy) return h("span", null, t("scanLineBusy"));
              if (det.error) {
                return h("span", { className: "err", title: String(det.error).slice(0, 300) },
                  t("scanLineFail", { err: String(det.error || "").slice(0, 90) }), time ? ` · ${time}` : "");
              }
              if (!det.at) return h("span", null, t("scanLineIdle"));
              const names = ordered.map((s) => s.name);
              return h("span", null,
                h("b", { className: "ok" }, t("connectedChip", { n: ordered.length })),
                names.length ? h("span", { className: "names", title: names.join("、") }, ` · ${names.join("、")}`) : null,
                addableList.length ? ` · ${t("moreAddable", { n: addableList.length })}` : null,
                ` · ${time}`,
              );
            };
            return h(React.Fragment, null,
              // 标题行（变体 B）：首行 = 标题 +「已接入 N」计数芯片 + ⟳重新扫描；结果独立一行
              h("div", { className: "qm-pages-title qm-head-b" },
                h("b", null, t("supplierPages"),
                  h("span", { className: "qm-added-only" }, t("addedOnly"))),
                h("div", { className: "qm-title-actions" },
                  h("span", { className: "chip" }, t("connectedChip", { n: ordered.length })),
                  h("button", { type: "button", className: `qm-rescan-btn${scanBusy ? " busy" : ""}`,
                    disabled: scanBusy, onClick: runRescan }, `⟳ ${t("rescan")}`),
                ),
              ),
              h("div", { className: "qm-scanline" }, scanLine()),
              ordered.length === 0
                ? h("div", { className: "qm-empty-added" }, t("emptyAdded"))
                : h("div", { className: "qm-page-list" },
                    ordered.map((sup) =>
                      h("div", { key: sup.id, "data-supplier": sup.id, className: "qm-page-row" },
                        h("div", { className: "qm-page-main" },
                          h("span", { className: `qm-dot ${stateClass(sup)}` }),
                          h("span", { className: "qm-page-name" }, sup.name),
                          h("span", { className: "qm-row-metric" }, selectPrimaryMetric(sup, t).text),
                          h("span", { className: "qm-pill" }, supplierStatus(sup, t)),
                          h("span", { className: "qm-page-pill" }, t(sup.meta?.credentialLabelKey || "apiKey")),
                          sup.meta?.compat
                            ? h("span", { className: "qm-page-pill ghost" }, t("compatSource"))
                            : null,
                          sup.autoDetected
                            ? h("span", { className: "qm-page-auto" }, sup.enabled ? t("autoDetectedShort") : t("autoSourceShort"))
                            : null,
                        ),
                        h("div", { className: "qm-page-actions" },
                          h("label", { className: "qm-page-toggle" },
                            h("input", { type: "checkbox", checked: !!sup.enabled, disabled: !!toggling[sup.id] || [...settingsWrites].some(operation => operation.supplierId === sup.id), onChange: () => toggleEnabled(sup) }),
                            h("span", null, t("enable")),
                          ),

                          h("button", { type: "button", className: "s-test qm-pri-soft", onClick: () => openSupplier(sup.id) }, t("openPage")),
                        ),
                      ),
                    ),
                  ),
              addableList.length
                ? h("details", { ref: addableRef, className: "qm-addable" },
                    h("summary", null,
                      h("span", null, t("addableTitle")),
                      h("span", { className: "cnt" }, t("addableCount", { n: addableList.length })),
                      h("span", { className: "hint" }, t("addableHint")),
                    ),
                    h("div", { className: "addable-list" },
                      addableList.map((a) =>
                        h("div", { key: a.id, className: `qm-add-row${freshIds.includes(a.id) ? " fresh" : ""}` },
                          h("span", { className: `qm-dot ${stateClass(a)}` }),
                          h("span", { className: "qm-page-name" }, a.name),
                          h("span", { className: "qm-page-pill" }, t(a.meta?.credentialLabelKey || "apiKey")),
                          a.meta?.compat
                            ? h("span", { className: "qm-page-pill ghost" }, t("compatSource"))
                            : null,
                          h("span", { className: "add-why" },
                            a.meta?.credentialClass && a.meta.credentialClass !== "api-key"
                              ? t("manualCredential", { label: t(a.meta.credentialLabelKey || "apiKey") })
                              : t("notInDsh")),
                          h("div", { className: "qm-page-actions" },
                            h("button", { type: "button", className: "s-test qm-pri-soft", onClick: () => openSupplier(a.id) }, t("openConfigAdd")),
                          ),
                        ),
                      ),
                    ),
                  )
                : null,
              state.detectedUnmapped && state.detectedUnmapped.length
                ? h("div", { className: "pnote", style: { marginTop: 8, whiteSpace: "pre-wrap" } },
                    `${t("unmapped")}：${state.detectedUnmapped.map((u) => `${u.displayName || u.route}${u.detail ? t("unmappedDetail", { detail: u.detail }) : ""}`).join("、")}`)
                : null,
            );
          })(),
        );

        // ---- 供应商独立配置页（参考项目的单页表单模型） ----
        const renderSupplierPage = () => {
          const sup = (state?.suppliers || []).find((s) => s.id === view.id);
          if (!sup || !editor) return h("div", { className: "qm-sub", role: "status" }, t("loading"));
          const f = editor.form;
          const needsInputs = (sup.meta?.needs || []).map((need) =>
            h("label", { key: need.key }, needsLabel(sup, need),
              h("input", {
                type: need.secret ? "password" : "text",
                placeholder: need.secret ? secretPlaceholder(sup, need) : t("keyEmpty"),
                value: f[need.key] || "",
                disabled: opBusy,
                onChange: (e) => setEditorField(need.key, e.target.value),
              }),
            ),
          );
          return h(React.Fragment, null,
            h("div", { className: "qm-page-head" },
              h("button", { type: "button", className: "s-test", onClick: closeEditor }, `← ${t("back")}`),
              h("b", null, sup.name),
              h("label", { className: "qm-inline-toggle" },
                h("input", { type: "checkbox", checked: !!f.enabled, disabled: opBusy, onChange: (e) => setEditorField("enabled", e.target.checked) }),
                h("span", null, t("enable")),
              ),
              h("span", { className: "qm-pill" }, supplierStatus(sup, t)),
              h("span", { className: "qm-page-pill" }, t(sup.meta?.credentialLabelKey || "apiKey")),
            ),
            h("div", { className: "s-group qm-quota-preview" }, h("h5", null, t("currentQuota")),
              h("p", { className: "pnote" }, t("previewSaved")), h(SupplierMetrics, { supplier: sup, t })),
            h("div", { className: "s-group" },
              h("h5", null, h("span", null, t("credentials"))),
              h("p", { className: "pnote" }, t("settingsSub")),
              needsInputs,
              h("label", null, t("apiKeyEnv"),
                h("input", {
                  type: "text",
                  placeholder: t("apiKeyEnvPlaceholder"),
                  value: f.apiKeyEnv || "",
                  disabled: opBusy,
                  onChange: (e) => setEditorField("apiKeyEnv", e.target.value),
                }),
              ),
              h("p", { className: "pnote" }, !sup.apiKeyEnv
                ? t("apiKeyEnvHint")
                : sup.keyRefResolved
                  ? t("keyRefResolvedNote", { env: sup.apiKeyEnv, source: t(sup.keyRefSource === "env" ? "env" : "credentialStore") })
                  : t("keyRefMissingNote", { env: sup.apiKeyEnv })),
            ),
            // 关注限额放在凭据之后、高级设置之前：它是日常会改的东西，
            // 不该藏进默认收起的「高级」里；没有可关注条目的供应商整段不渲染。
            h(WatchedLimits, {
              supplier: sup, form: f, t, disabled: opBusy,
              onChange: (keys) => setEditorField("displayKeys", keys),
            }),
            h("details", { ref: advancedRef, className: "s-group qm-advanced", open: advanced, onToggle: e => setAdvanced(e.currentTarget.open) },
              h("summary", null, t("advanced")),
              h("label", null, t("baseUrl"),
                h("input", { type: "text", value: f.baseUrl || "", disabled: opBusy, onChange: (e) => setEditorField("baseUrl", e.target.value) }),
              ),
              h("div", { className: "s-grid" },
                h("label", null, t("warnPct"),
                  h("input", { type: "number", min: 1, max: 99, value: f.warnPct, disabled: opBusy, onChange: (e) => setEditorField("warnPct", e.target.value) }),
                ),
                h("label", null, t("critPct"),
                  h("input", { type: "number", min: 1, max: 100, value: f.critPct, disabled: opBusy, onChange: (e) => setEditorField("critPct", e.target.value) }),
                ),
              ),
            ),
            h("div", { className: "s-row" },
              h("button", { type: "button", className: "s-test", disabled: opBusy || testBusy === sup.id, onClick: () => runTest(sup.id) }, testBusy === sup.id ? t("testing") : `⟳ ${t("test")}`),
              testResult(sup.id),
            ),
            h("div", { className: "s-actions" },
              saved === sup.id ? h("span", { className: "s-saved" }, t("saved")) : null,
              h("button", { type: "button", onClick: closeEditor, disabled: opBusy }, t("cancel")),
              h("button", { type: "button", className: "qm-pri", onClick: saveSupplier, disabled: opBusy }, t("save")),
            ),
          );
        };

        const renderOverview = () => {
          const suppliers = (state.suppliers || []).filter(s => s.added !== false).sort((a, b) =>
            Number(b.id === state.active?.supplierId) - Number(a.id === state.active?.supplierId) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
          const attention = s => s.state === "err" || (s.enabled !== false && ["stateWarn", "stateCrit"].includes(stateToken(s)));
          const shown = filter === "all" ? suppliers : suppliers.filter(attention);
          return h(React.Fragment, null,
            h("div", { className: "qm-summary" }, h("b", null, t("today", { n: fmtBig(todayTotal(state)) })),
              h("span", null, t("addedCount", { n: suppliers.length })), h("span", null, t("attentionCount", { n: suppliers.filter(attention).length }))),
            h("p", { className: "pnote" }, t("todayScope")),
            h("div", { className: "qm-toolbar" }, ...["all", "attention"].map(key => h("button", { key, type: "button", "aria-pressed": filter === key, onClick: () => setFilter(key) }, t(key)))),
            h("div", { className: "qm-overview-grid" }, shown.map(sup => h("article", { key: sup.id, className: "qm-supplier-card", "data-supplier": sup.id },
              h("header", null, h("b", null, sup.name), sup.id === state.active?.supplierId ? h("span", { className: "qm-pill" }, t("activeSupplier")) : null,
                h("span", { className: "qm-pill" }, supplierStatus(sup, t)), h("button", { type: "button", onClick: () => openSupplier(sup.id) }, t("openPage"))),
              h("p", { className: "pnote" }, [sup.meta?.region, t(sup.meta?.credentialLabelKey || "apiKey")].filter(Boolean).join(" · ")),
              h(SupplierMetrics, { supplier: sup, t })))),
            !shown.length ? h("div", { className: "qm-empty" }, h("p", null, t(filter === "attention" ? "noAttention" : "overviewEmpty")),
              filter === "all" ? h("button", { type: "button", onClick: () => navigate("suppliers") }, t("manageSuppliers")) : null) : null,
            h("details", { className: "qm-history" }, h("summary", null, t("historySummary", { n: Math.min(state.history?.length || 0, 50) })),
              (state.history || []).slice(0, 50).map((row, i) => h("div", { key: i, className: "qm-history-row" }, row.t, " · ", row.supplier, " · ", row.ok ? t("colOk") : t("colFail"), " · ", row.summary, row.error ? ` · ${row.error}` : ""))));
        };
        const dialog = variant === "dialog";
        const navigate = (name) => {
          rememberPosition();
          setView(name === "suppliers" && editor ? { name: "supplier", id: editor.supplierId } : { name });
        };
        const card = h("div", { ref: dialogRef, tabIndex: -1,
          ...(dialog ? { role: "dialog", "aria-modal": true, "aria-label": t("title") } : {}),
          className: `qm-card qm-settings${dialog ? "" : " qm-settings-page"}` },
          h("div", { className: "qm-panel-head" }, h("h3", { tabIndex: -1 }, t("title")),
            h("button", { type: "button", disabled: refreshing, onClick: refresh }, t(refreshing ? "refreshing" : "refresh")),
            dialog ? h("button", { type: "button", onClick: requestClose, "aria-label": t("close") }, t("close")) : null),
          h("div", { className: "qm-tabs", role: "tablist", "aria-label": t("title") }, ["overview", "suppliers", "settings"].map(name => h("button", {
            type: "button", role: "tab", key: name, "aria-selected": view.name === name || (name === "suppliers" && view.name === "supplier"), onClick: () => navigate(name) }, t(name)))),
          savedBanner,
          saveError ? h("div", { role: "alert", className: "ci-err" }, saveError) : null,
          state?.storageError ? h("div", { role: "alert", className: "ci-err" }, state.storageError) : null,
          loadError ? h("div", { role: "alert", className: "ci-err" }, `${t(state ? "staleFailure" : "unavailable")}：${loadError}`) : null,
          !state || panel.opening ? h("p", { role: "status" }, t(loadError ? "unavailable" : "loading")) :
            view.name === "supplier" ? renderSupplierPage() : view.name === "settings" ? renderSettings() : view.name === "suppliers" ? renderSuppliers() : renderOverview(),
          confirmation ? h("div", { role: "alertdialog", "aria-label": t("unsaved"), className: "qm-confirm" },
            h("p", null, t("unsaved")), h("button", { type: "button", autoFocus: true, onClick: () => setConfirmation(null) }, t("keepEditing")),
            h("button", { type: "button", onClick: () => { const action = confirmation; setConfirmation(null); action(); } }, t("discard"))) : null);
        return dialog ? h("div", { className: "qm-overlay", onClick: ev => ev.target === ev.currentTarget && requestClose() }, card) : card;
      }

      function SettingsSection({ t }) {
        const identity = React.useRef({}).current;
        const panel = usePanel();
        React.useLayoutEffect(() => {
          const waiting = panelStore.getSnapshot().opening || (!panelStore.getSnapshot().dialog && settingsWrites.size > 0);
          panelStore.update({ page: identity, popover: false, detail: false, dialog: false, opening: waiting });
          if (waiting) void Promise.allSettled([...settingsWrites].map(operation => operation.promise)).then(() => displayController.reload()).finally(() => {
            if (panelStore.getSnapshot().page === identity) panelStore.update({ opening: false });
          });
          return () => { if (panelStore.getSnapshot().page === identity) { panelSession = createPanelSession(); panelStore.update({ page: null }); } };
        }, []);
        return panel.page === identity ? h(MonitorPanel, { t, variant: "page" }) : null;
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
          overviewEmpty: "尚未添加供应商。可在供应商页重新扫描或填写凭据。",
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
          addedCount: "已添加 {n} 个",
          attentionCount: "需关注 {n} 个",
          activeSupplier: "当前会话",
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
          holidaysLabel: "节假日覆盖表（每行一个日期，留空使用内置表）",
          holidaysPlaceholder: "2027-01-01\n2027-02-06",
          holidaysHint: "内置表按国务院公布的年度安排维护；缺次年时工作日假期会被误判为峰价，粘贴覆盖表可即时修正。",
          colTier: "时段",

          // ---- 常驻卡片：plan 名 + 周窗口进度条 ----
          weekTag: "周",
          barAria: "{name} 已用 {pct}",

          title: "用量监控",
          quickTitle: "用量",
          connOk: "已连接",
          connWarn: "已连接 · 降级",
          connStandby: "待命",
          connDown: "未连接",
          connFailed: "取数失败 {n} 个",
          resetInHM: "{h}h{m}m 后重置",
          resetInDH: "{d}d{h}h 后重置",
          // 卡片条上的裸倒计时：不带叙述词，靠列对齐与弱色表达归属
          resetHM: "{h}h{m}m",
          resetDH: "{d}d{h}h",
          resetSoon: "即将重置",
          watchTitle: "关注限额",
          watchHint: "勾选顺序即卡片排列顺序",
          watchUnavailable: "当前不可用",
          watchDefaultHint: "不勾选时按默认规则：周窗口优先，缺少周窗口取已用比例最高的有效窗口。",
          moveUp: "上移",
          moveDown: "下移",
          todayLabel: "今日",
          noneActive: "暂无调用",
          justNow: "刚刚",
          minAgo: "{n} 分钟前",
          hourAgo: "{n} 小时前",
          dayAgo: "{n} 天前",
          today: "今日用量 {n} tokens",
          countBadge: "×{n}",
          refresh: "刷新",
          refreshing: "刷新中…",
          loadFailed: "状态获取失败",
          detail: "详情",
          settings: "设置",
          close: "关闭",
          cancel: "取消",
          save: "保存",
          saved: "已保存 ✓",
          lastRefresh: "上次刷新",
          poll: "每 {n}s",
          noSuppliers: "暂无当前供应商",
          openSettings: "打开设置",
          stale: "近 {n}h 无流量 · 按启用清单显示",
          stateOk: "正常",
          stateWarn: "警告",
          stateCrit: "临界",
          stateErr: "取数失败",
          stateOff: "未配置",
          noData: "无数据",
          quota: "限额",
          usedShort: "已用",
          detailTitle: "供应商限额明细",
          allConfigured: "全部已配置供应商（共 {n}）",
          recentRefresh: "最近刷新",
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
          supplierPages: "供应商页",
          supplierPagesSub: "分别配置各供应商使用的凭据",
          addedOnly: "仅显示已添加",
          rescan: "重新扫描",
          connectedChip: "已接入 {n}",
          scanLineBusy: "正在扫描 DeepSeek Harness…",
          scanLineIdle: "尚未扫描 DSH —— 点「重新扫描」探测已添加的模型供应商",
          scanLineFail: "扫描失败：{err}",
          moreAddable: "另有 {n} 个未接入可添加",
          addableTitle: "可添加供应商",
          addableCount: "{n} 个",
          addableHint: "填写凭据或启用后保存",
          openConfigAdd: "打开配置 → 添加",
          notInDsh: "DSH 未添加 · 可手动配置",
          detailAdded: "已添加 {n} 个供应商（未添加不显示）",
          emptyAdded: "尚未接入任何供应商 —— 点「重新扫描」从 DSH 探测，或展开下方「可添加供应商」手动添加",
          openPage: "配置",
          back: "返回",
          credentials: "凭据",
          endpoint: "连接与阈值",
          compatSource: "兼容来源",
          autoDetectedShort: "已自动接入",
          autoSourceShort: "自动探测到",

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
          manualCredential: "需手动填写 {label}，普通 API Key 不适用",
          currentQuota: "当前额度（最近一次取数）",
          quotaNotFetched: "尚无取数结果 —— 保存后等待下次轮询，或先点「测试连接」",
          unmappedDetail: "（{detail}）",
          keySet: "已设置（留空保持不变）",
          keyEmpty: "未设置",
          keyAuto: "自动读取 {env}",
          apiKeyEnv: "凭据引用",
          apiKeyEnvPlaceholder: "如 COMMAND_CODE_API_KEY",
          apiKeyEnvHint: "填 DSH 凭据库里的记录名或环境变量名；密钥本体不写进本插件配置。",
          keyRefResolved: "引用 {env}（已解析）",
          keyRefMissing: "引用 {env}（未解析）",
          keyRefResolvedNote: "引用 {env} · 来自{source}；密钥不落盘到本插件配置。",
          keyRefMissingNote: "引用 {env} 当前解析不到：凭据库没有这条记录，环境变量也是空的。",
          dshKey: "DSH 密钥",
          env: "环境变量",
          credentialStore: "DSH 凭据库",
          allowanceToken: "allowance Token（OAuth）",
          orgId: "org id（可选）",
          baseUrl: "Base URL",
          warnPct: "警告阈值 %",
          critPct: "临界阈值 %",
          interval: "轮询间隔（秒，10–3600）",
          retention: "用量保留期（天，1–90）",
          unmapped: "另探测到 DSH 内已添加但本插件暂不支持的供应商",
          autoDetectedOn: "已自动探测 DSH 的 {source} 配置：已启用、Base URL 与密钥已自动填入（来源 {env}，留空即可使用）",
          autoDetectedOff: "已自动探测 DSH 的 {source} 配置：Base URL 与密钥引用已填入，但密钥暂不可解析，未自动启用",
        },
        en: {
          current: "Current",
          overviewEmpty: "No suppliers have been added. Rescan or enter credentials on the Suppliers tab.",
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
          addedCount: "{n} added",
          attentionCount: "{n} need attention",
          activeSupplier: "Current session",
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
          holidaysLabel: "Holiday overrides (one date per line; empty uses the built-in table)",
          holidaysPlaceholder: "2027-01-01\n2027-02-06",
          holidaysHint: "The built-in table only covers years the State Council has published. Without next year's dates, weekday holidays count as peak; paste an override to correct it immediately.",

          // ---- sidebar card: plan name + weekly progress bar ----
          weekTag: "Week",
          barAria: "{name} used {pct}",

          title: "Usage monitor",
          quickTitle: "Usage",
          connOk: "Connected",
          connWarn: "Connected · degraded",
          connStandby: "Standby",
          connDown: "Disconnected",
          connFailed: "{n} fetch failed",
          resetInHM: "resets in {h}h{m}m",
          resetInDH: "resets in {d}d{h}h",
          resetHM: "{h}h{m}m",
          resetDH: "{d}d{h}h",
          resetSoon: "resetting now",
          watchTitle: "Watched limits",
          watchHint: "Check order sets the card's bar order",
          watchUnavailable: "Unavailable now",
          watchDefaultHint: "With nothing checked the card falls back to the weekly window, then the highest-used valid window.",
          moveUp: "Move up",
          moveDown: "Move down",
          todayLabel: "Today",
          noneActive: "No calls yet",
          justNow: "just now",
          minAgo: "{n} min ago",
          hourAgo: "{n} h ago",
          dayAgo: "{n} d ago",
          today: "Today {n} tokens",
          countBadge: "×{n}",
          refresh: "Refresh",
          refreshing: "Refreshing…",
          loadFailed: "State fetch failed",
          detail: "Details",
          settings: "Settings",
          close: "Close",
          cancel: "Cancel",
          save: "Save",
          saved: "Saved ✓",
          lastRefresh: "Last refresh",
          poll: "every {n}s",
          noSuppliers: "No current suppliers",
          openSettings: "Open settings",
          stale: "No traffic in {n}h · showing enabled list",
          stateOk: "OK",
          stateWarn: "Warning",
          stateCrit: "Critical",
          stateErr: "Fetch failed",
          stateOff: "Not configured",
          noData: "No data",
          quota: "Limit",
          usedShort: "Used",
          detailTitle: "Supplier quota details",
          allConfigured: "All configured suppliers ({n})",
          recentRefresh: "Last refresh",
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
          supplierPages: "Supplier pages",
          supplierPagesSub: "Configure credentials separately for each supplier",
          addedOnly: "Added only",
          rescan: "Rescan",
          connectedChip: "Connected {n}",
          scanLineBusy: "Scanning DeepSeek Harness…",
          scanLineIdle: "Not scanned yet — click Rescan to discover suppliers added in DSH",
          scanLineFail: "Scan failed: {err}",
          moreAddable: "{n} more addable",
          addableTitle: "Addable suppliers",
          addableCount: "{n}",
          addableHint: "Enter credentials or enable, then save",
          openConfigAdd: "Open config → Add",
          notInDsh: "Not added in DSH — configure manually",
          detailAdded: "Added {n} suppliers (not-added ones hidden)",
          emptyAdded: "No suppliers connected yet — click Rescan to discover them in DSH, or expand “Addable suppliers” below",
          openPage: "Configure",
          back: "Back",
          credentials: "Credentials",
          endpoint: "Endpoint & thresholds",
          compatSource: "compat",
          autoDetectedShort: "auto-connected",
          autoSourceShort: "detected",

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
          manualCredential: "Enter {label} manually; a plain API Key cannot be used",
          currentQuota: "Current quota (latest fetch)",
          quotaNotFetched: "No quota fetched yet — save and wait for the next poll, or run a test connection",
          unmappedDetail: "({detail})",
          keySet: "Set (blank keeps current)",
          keyEmpty: "Not set",
          keyAuto: "Auto-read {env}",
          apiKeyEnv: "Credential reference",
          apiKeyEnvPlaceholder: "e.g. COMMAND_CODE_API_KEY",
          apiKeyEnvHint: "Name of a DSH credential record or an environment variable; the key itself is never written to this plugin's config.",
          keyRefResolved: "ref {env} (resolved)",
          keyRefMissing: "ref {env} (unresolved)",
          keyRefResolvedNote: "Reference {env} · from {source}; the key stays out of this plugin's config.",
          keyRefMissingNote: "Reference {env} does not resolve: no such credential record, and the environment variable is empty.",
          dshKey: "DSH key",
          env: "environment",
          credentialStore: "DSH credential store",
          allowanceToken: "allowance Token (OAuth)",
          orgId: "org id (optional)",
          baseUrl: "Base URL",
          warnPct: "Warn threshold %",
          critPct: "Critical threshold %",
          interval: "Poll interval (s, 10–3600)",
          retention: "Usage retention (days, 1–90)",
          unmapped: "Detected DSH suppliers this plugin does not support yet",
          autoDetectedOn: "Auto-detected DSH {source}: enabled, Base URL and key filled (from {env}; leave blank to use)",
          autoDetectedOff: "Auto-detected DSH {source}: Base URL and key reference filled, but the key is not resolvable yet — not enabled",
        },
      };

      // ---------- 样式（一次性注入，作用域化） ----------
      const CSS = `
[data-qm-entry],.qm-density{box-sizing:border-box;color:var(--dsw-alias-label-primary,#dbe2ee);font:12px var(--dsw-font-family),system-ui,sans-serif;}
div:has(> div[data-slot="sidebar.footer.action"] > [data-qm-linerow]){flex-wrap:wrap;}
[data-qm-linerow]{flex:1 1 100%;min-width:100%;box-sizing:border-box;order:-1;margin:2px 0;}
.qm-footer{position:relative;display:flex;align-items:stretch;border:1px solid var(--dsw-alias-border-l2,#363d4d);border-radius:9px;background:var(--dsw-alias-bg-layer-2,#151922);overflow:hidden;}
.qm-strip{flex:1;min-width:0;display:flex;flex-direction:column;align-items:stretch;gap:3px;padding:8px;border:0;color:inherit;background:transparent;cursor:pointer;text-align:left;line-height:17px;}
.qm-strip:hover,.qm-density:hover{background:var(--dsw-alias-interactive-bg-hover,#20283a);}
.qm-strip:focus-visible,.qm-density:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4f8cff);outline-offset:-2px;}
.qm-density{position:absolute;right:4px;top:4px;width:26px;height:24px;border:0;border-radius:5px;background:transparent;cursor:pointer;}
.qm-l1{display:flex;gap:8px;align-items:center;padding-right:26px;}
.qm-plan{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.qm-fetch-status{font-size:10px;min-width:0;color:var(--dsw-alias-state-error-primary,#f87171);}
/* 第 2 行：窗口标签 + 已用百分比进度条 + 百分比数字（颜色即阈值分档，不再另设圆点）
   关注限额可以是多条：四列网格让所有行共享 label/条/百分比/倒计时列宽，行与行严格对齐 */
.qm-bars{display:grid;grid-template-columns:minmax(0,max-content) minmax(24px,1fr) max-content max-content;
  column-gap:6px;row-gap:3px;align-items:center;min-width:0;}
/* 回落成主指标文字（只有余额/报告）时同样要能截断：这一行放不下就省略，不许撑破卡片 */
.qm-l2{display:flex;align-items:center;gap:6px;min-width:0;}
.qm-l2>.qm-primary{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
/* 长度上限用 em 而不是百分比：百分比在 grid 自动轨道里会对尚未确定的轨道尺寸解析，
   把「月用量」夹成十几像素只剩省略号。em 是绝对长度，列宽由最长（但受限）的 label 决定。 */
.qm-bar-label{max-width:5.5em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#a9b2c5);}
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
/* 详情弹窗：今日用量（原先在卡片第 3 行） */
.qm-today-line{color:var(--dsw-alias-label-secondary,#a9b2c5);font-size:11px;font-variant-numeric:tabular-nums;margin:2px 0 8px;}
/* 供应商配置页：关注限额复选列表（勾选顺序即卡片排列顺序） */
.qm-watch{border:1px solid var(--dsw-alias-border-l2,#262d3d);border-radius:8px;padding:8px 10px 4px;}
.qm-watch .w-head{display:flex;align-items:baseline;gap:8px;margin-bottom:2px;}
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
.qm-watch .w-foot{color:var(--dsw-alias-label-tertiary,#8b94a8);font-size:11px;padding:6px 0 2px;}
.qm-season{display:flex;align-items:center;gap:5px;font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#a9b2c5);}
.qm-season b{font-weight:600;}
.qm-season.peak b,.qm-season-dot.peak{color:var(--dsw-alias-state-warn-primary,#fbbf24);}
.qm-season.valley b{color:var(--dsw-alias-state-success-primary,#34d399);}
.qm-season-dot{width:6px;height:6px;border-radius:50%;flex:none;display:inline-block;background:var(--dsw-alias-label-tertiary,#6b7280);}
.qm-season-dot.peak{background:var(--dsw-alias-state-warn-primary,#fbbf24);}
.qm-season-dot.valley{background:var(--dsw-alias-state-success-primary,#34d399);}
.qm-season-note{color:var(--dsw-alias-label-tertiary,#8b94a8);}
.qm-season-block{margin:0 0 10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1,#1d2330);border-radius:8px;}
.qm-season-block .qm-season-row{display:flex;justify-content:space-between;gap:8px;font-size:11px;color:var(--dsw-alias-label-secondary,#a9b2c5);}
.qm-season-block .qm-season-row+.qm-season-row{margin-top:4px;}
.qm-season-split{margin-top:6px;}
.qm-season-warn{margin-top:6px;font-size:11px;color:var(--dsw-alias-state-warn-primary,#fbbf24);}
.qm-settings .qm-holidays textarea{width:100%;box-sizing:border-box;resize:vertical;font:11px var(--dsw-font-family),ui-monospace,monospace;
  background:var(--dsw-alias-bg-layer-2,#151922);border:1px solid var(--dsw-alias-border-l2,#262d3d);border-radius:8px;
  color:var(--dsw-alias-label-primary,#dbe2ee);padding:6px 8px;}
.qm-settings .qm-holidays textarea:focus{outline:2px solid var(--dsw-alias-state-business-primary,#4f8cff);outline-offset:1px;}
.qm-compact-line{display:flex;gap:5px;align-items:center;padding-right:20px;white-space:nowrap;}
.qm-compact-line .qm-provider{min-width:24px;max-width:32%;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto;}
.qm-compact-line .qm-primary{min-width:0;display:flex;gap:3px;align-items:center;flex:1;font-size:11px;}
.qm-metric-name{min-width:0;overflow:hidden;text-overflow:ellipsis;}
.qm-metric-value,.qm-more{flex:none;}
.qm-rail{width:32px;height:32px;border:none;border-radius:8px;background:transparent;cursor:pointer;}
.qm-dot{width:7px;height:7px;border-radius:50%;flex:none;display:inline-block;background:var(--dsw-alias-label-tertiary,#6b7280);}
.qm-dot.ok{background:var(--dsw-alias-state-success-primary,#34d399);}
.qm-dot.warn{background:var(--dsw-alias-state-warn-primary,#fbbf24);}
.qm-dot.crit{background:var(--dsw-alias-state-error-primary,#f87171);}
.qm-pop{position:fixed;z-index:1200;box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;width:320px;padding:12px;border-radius:10px;
  background:var(--dsw-alias-bg-base,#0b0e13);border:1px solid var(--dsw-alias-border-l2,#363d4d);box-shadow:var(--dsw-shadow-lv3,0 8px 24px #0005);
  color:var(--dsw-alias-label-primary,#dbe2ee);font:12px var(--dsw-font-family),system-ui,sans-serif;}
.qm-pop-head{display:flex;flex:none;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;}
.qm-pop-head b{font-size:14px;}.qm-pop-head>span{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary,#a9b2c5);}
.qm-srows{display:flex;flex-direction:column;gap:4px;min-height:0;overflow:auto;padding-bottom:12px;}
.qm-srow{min-width:0;padding:7px 8px;border-radius:8px;}.qm-srow:hover{background:var(--dsw-alias-interactive-bg-hover,#20283a);}
.qm-srow-main{display:flex;align-items:center;gap:8px;}.qm-srow-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.qm-srow-head{flex:none;font-variant-numeric:tabular-nums;}.qm-srow-head.warn{color:var(--dsw-alias-state-warn-primary,#fbbf24);}
.qm-srow-head.crit,.qm-srow-status.err{color:var(--dsw-alias-state-error-primary,#f87171);}
.qm-srow-entry,.qm-srow-status{margin-top:6px;padding-left:16px;font-size:11px;color:var(--dsw-alias-label-secondary,#a9b2c5);overflow-wrap:anywhere;}
.qm-pop-empty{margin:14px 4px;color:var(--dsw-alias-label-secondary,#a9b2c5);line-height:1.6;}
.qm-pop-foot{display:flex;flex:none;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2,#363d4d);}
.qm-pop-time{font-size:10px;color:var(--dsw-alias-label-secondary,#a9b2c5);font-variant-numeric:tabular-nums;}.qm-pop-actions{display:flex;gap:4px;margin-left:auto;}
.qm-pop-btn{border:0;background:none;color:var(--dsw-alias-state-business-primary,#4f8cff);font:inherit;padding:2px 4px;cursor:pointer;border-radius:4px;}
.qm-pop-btn:hover{text-decoration:underline;}.qm-pop-btn:disabled{opacity:.5;cursor:wait;}.qm-pop-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4f8cff);outline-offset:2px;}
.qm-card-btn{border:1px solid var(--dsw-alias-border-l2,#262d3d);background:none;
  color:var(--dsw-alias-label-primary,#dbe2ee);border-radius:8px;padding:6px 12px;cursor:pointer;font-size:12px;font-family:inherit;}
.qm-card-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#20283a);}
.qm-overlay{position:fixed;inset:0;z-index:1500;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;}
.qm-overlay .qm-card{width:min(960px,calc(100vw - 32px));max-height:86vh;overflow:auto;
  background:var(--dsw-alias-bg-base,#0b0e13);border:1px solid var(--dsw-alias-border-l2,#262d3d);
  border-radius:14px;padding:16px;color:var(--dsw-alias-label-primary,#dbe2ee);
  font-family:var(--dsw-font-family),sans-serif;box-sizing:border-box;}
.qm-overlay .qm-card h3{margin:0 0 4px;font-size:15px;}
.qm-overlay .qm-sub{color:var(--dsw-alias-label-tertiary,#8b94a8);font-size:11px;margin-bottom:12px;}
/* 设置页版设置面板：已嵌在设置面板内容列里，不再要遮罩/卡片边框与宽度上限 */
.qm-settings-page{color:var(--dsw-alias-label-primary,#dbe2ee);font-family:var(--dsw-font-family),sans-serif;}
.qm-settings-page h3{margin:0 0 4px;font-size:15px;}
.qm-settings-page .qm-sub{color:var(--dsw-alias-label-tertiary,#8b94a8);font-size:11px;margin-bottom:12px;}
.qm-overlay .qm-toolbar{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;}
.qm-overlay .qm-toolbar button{border:1px solid var(--dsw-alias-border-l2,#262d3d);background:none;
  color:var(--dsw-alias-label-primary,#dbe2ee);border-radius:8px;padding:4px 12px;cursor:pointer;font-size:12px;font-family:inherit;}
.qm-overlay .qm-toolbar button.qm-pri{background:var(--dsw-alias-button-info-fill,#4f8cff);border-color:transparent;color:#fff;}
.qm-card-item{padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,#1d2330);}
.qm-card-item:last-child{border-bottom:none;}
.qm-card-item .ci-name{color:var(--dsw-alias-label-secondary,#8b94a8);font-size:11px;display:flex;justify-content:space-between;}
.qm-card-item .ci-big{font-weight:700;font-size:14px;margin:2px 0;}
.qm-card-item .ci-big.ok{color:var(--dsw-alias-state-success-primary,#34d399);}
.qm-card-item .ci-big.warn{color:var(--dsw-alias-state-warn-primary,#fbbf24);}
.qm-card-item .ci-big.crit{color:var(--dsw-alias-state-error-primary,#f87171);}
.qm-card-item .ci-big.err{color:var(--dsw-alias-label-tertiary,#6b7280);}
.qm-card-item .ci-row{display:flex;justify-content:space-between;font-size:11px;color:var(--dsw-alias-label-tertiary,#8b94a8);}
.qm-card-item .ci-err{color:var(--dsw-alias-state-error-primary,#f87171);font-size:11px;margin-top:4px;}
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
.qm-settings .pnote{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b94a8);}

.qm-settings .qm-pages-title{display:flex;justify-content:space-between;margin:4px 0 8px;color:var(--dsw-alias-label-secondary,#8b94a8);font-size:12px;}
.qm-settings .qm-pages-title span{color:var(--dsw-alias-label-tertiary,#5c6577);font-size:10px;}
.qm-page-list{display:flex;flex-direction:column;gap:6px;}
.qm-page-row{display:flex;align-items:center;gap:10px;border:1px solid var(--dsw-alias-border-l1,#262d3d);border-radius:10px;padding:6px 10px;background:var(--dsw-alias-bg-layer-2,#151922);}
.qm-page-main{flex:1 1 0;min-width:0;display:flex;align-items:center;gap:8px;cursor:pointer;}
.qm-page-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.qm-page-pill{flex:none;padding:1px 8px;border-radius:8px;font-size:10px;border:1px solid var(--dsw-alias-border-l2,#262d3d);color:var(--dsw-alias-label-secondary,#8b94a8);}
.qm-page-pill.ghost{opacity:.6;}
.qm-page-auto{flex:none;font-size:10px;color:var(--dsw-alias-state-success-primary,#34d399);}
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
.qm-settings .qm-addable .hint{margin-left:auto;font-size:10px;color:var(--dsw-alias-label-tertiary,#5c6577);}
.qm-settings .addable-list{padding:0 8px 8px;display:flex;flex-direction:column;gap:6px;}
.qm-settings .qm-add-row{display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-border-l1,#262d3d);border-radius:8px;padding:5px 8px;background:var(--dsw-alias-bg-layer-2,#151922);}
.qm-settings .qm-add-row.fresh{animation:qm-fresh 1.8s ease-out;}
.qm-settings .qm-add-row .add-why{margin-left:auto;color:var(--dsw-alias-label-tertiary,#5c6577);font-size:10px;flex:none;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
@keyframes qm-fresh{from{background:rgba(79,140,255,.30);}to{background:transparent;}}

.qm-card{container-type:inline-size;min-width:0;overflow-wrap:anywhere;}
.qm-card button,.qm-card select{font:inherit;font-size:12px;color:var(--dsw-alias-label-primary,#dbe2ee);background:var(--dsw-alias-bg-layer-2,#151922);border:1px solid var(--dsw-alias-border-l2,#363d4d);border-radius:7px;padding:5px 10px;cursor:pointer;}
.qm-card button:disabled{opacity:.55;cursor:default;}
.qm-card button:focus-visible,.qm-card summary:focus-visible,.qm-card select:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4f8cff);outline-offset:2px;}
.qm-panel-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px;}
.qm-panel-head h3{flex:1;}
.qm-tabs{display:flex;gap:8px;border-bottom:1px solid var(--dsw-alias-border-l2,#363d4d);padding-bottom:10px;margin-bottom:16px;}
.qm-tabs [aria-selected=true],.qm-toolbar [aria-pressed=true]{color:var(--dsw-alias-state-business-primary,#4f8cff);border-color:currentColor;}
.qm-summary{display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-size:12px;font-variant-numeric:tabular-nums;}
.qm-overview-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;}
@container (min-width:720px){.qm-overview-grid{grid-template-columns:repeat(2,minmax(0,1fr));}}
.qm-supplier-card{min-width:0;border:1px solid var(--dsw-alias-border-l2,#363d4d);border-radius:10px;padding:12px;background:var(--dsw-alias-bg-layer-2,#151922);}
.qm-supplier-card header{display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:13px;}
.qm-supplier-card header b{flex:1;min-width:80px;}
.qm-cols{display:flex;gap:12px;overflow-x:auto;padding-bottom:6px;}
.qm-col{flex:1 0 210px;min-width:210px;border:1px solid var(--dsw-alias-border-l2,#363d4d);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#151922);}
.qm-col h5{margin:0;padding:10px;font-size:12px;display:flex;gap:8px;justify-content:space-between;align-items:center;border-bottom:1px solid var(--dsw-alias-border-l1,#262d3d);}
.qm-col h5>span:first-child{min-width:0;}
.qm-col .qm-pill{flex:none;}
.qm-col>.pnote,.qm-col>.ci-err{margin:8px 10px;}
.qm-details .pnote{font-size:11px;color:var(--dsw-alias-label-secondary,#8b94a8);}
.qm-cur{color:var(--dsw-alias-state-business-primary,#4f8cff);font-weight:400;}
.qm-details .ci-name{gap:8px;flex-wrap:wrap;}
.qm-history-scroll{overflow-x:auto;}
.qm-history-scroll table{min-width:560px;}
.qm-metric-group h6{font-size:11px;margin:12px 10px 2px;color:var(--dsw-alias-label-secondary,#a9b2c5);}
.ci-big{font-variant-numeric:tabular-nums;}
.ci-big.neutral{color:var(--dsw-alias-label-primary,#dbe2ee);}
.ci-err{color:var(--dsw-alias-state-error-primary,#f87171);font-size:12px;margin:8px 0;white-space:pre-wrap;}
.qm-warning{font-size:11px;}
.qm-history-row{font-size:11px;padding:6px 12px;border-top:1px solid var(--dsw-alias-border-l1,#262d3d);}
.qm-page-row,.qm-add-row{flex-wrap:wrap;}
.qm-page-main{cursor:default;flex-wrap:wrap;min-width:150px;}
.qm-row-metric{font-size:11px;font-variant-numeric:tabular-nums;}
.qm-page-actions{flex-wrap:wrap;}
.qm-settings .qm-page-toggle{display:flex;align-items:center;margin:0;}
.qm-settings .qm-pages-title{flex-wrap:wrap;gap:8px;}
.qm-settings .qm-page-head{flex-wrap:wrap;}
.qm-settings .qm-page-head b{min-width:100px;}
.qm-settings .qm-addable .hint{white-space:normal;}
.qm-advanced summary{cursor:pointer;font-size:13px;margin-bottom:10px;}
.qm-confirm{position:sticky;bottom:0;padding:14px;border:2px solid var(--dsw-alias-state-warn-primary,#fbbf24);border-radius:10px;background:var(--dsw-alias-bg-base,#0b0e13);box-shadow:0 3px 14px #0004;z-index:1;}
.qm-confirm button{margin-right:8px;}
@container (max-width:460px){.qm-settings .s-grid{grid-template-columns:minmax(0,1fr);}.qm-page-actions{width:100%;}.qm-settings .qm-add-row .add-why{max-width:100%;white-space:normal;}.qm-settings .qm-addable .hint{display:none;}}
      `;

      function ensureStyle() {
        const tagId = "dsh-token-quota/widget.css";
        if (document.querySelector(`style[data-plugin-css="${tagId}"]`)) return;
        const tag = document.createElement("style");
        tag.dataset.plugin = "dsh-token-quota";
        tag.dataset.pluginCss = tagId;
        tag.textContent = CSS;
        document.head.appendChild(tag);
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
          panelStore.close();
        }, "dsh-token-quota: slot disposers");
      }

      exports.apply = apply;
      exports.inject = inject;
      return module.exports;
    },
  });
})();
