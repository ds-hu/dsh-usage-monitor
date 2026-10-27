import { test, expect } from "@playwright/test";
import { PROVIDERS } from "../../lib/providers.js";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const BASE = "http://127.0.0.1:4179";
const baseConfig = { suppliers: { opencode: { enabled: true, orgId: "org-original" } } };
const visualDirectory = resolve(".scratch/sidebar-ui-visual");
const displayFixture = () => ({
  ok: true, now: Date.now(), traffic: { channelAlive: true },
  active: { supplierId: "opencode", name: "OpenCode", model: "deepseek-v4.1-flash-with-a-very-long-model-name", at: Date.now() },
  suppliers: [
    { id: "opencode", name: "OpenCode", enabled: true, added: true, current: true, state: "ok", todayTokens: 1_240_000,
      warnPct: 80, critPct: 95, lastSuccessAt: Date.now(), entries: [
        { kind: "win", name: "5 小时", pct: 63, limit: "100%", used: "63%", resetAt: Date.now() + 7_980_000 },
        { kind: "win", name: "周用量", pct: 40, limit: "100%", used: "40%" },
      ] },
    { id: "deepseek", name: "DeepSeek", enabled: true, added: true, current: true, state: "err", todayTokens: 12_000,
      lastSuccessAt: Date.now() - 3_600_000, error: { message: "查询超时" }, entries: [
        { kind: "bal", name: "USD", remain: "$3.20", pct: null },
        { kind: "bal", name: "CNY", remain: "¥41.99", pct: null },
      ] },
  ],
});
const useDisplayFixture = (page) => page.route(/\/api\/dsh-token-quota\/state(?:\?.*)?$/, (route) => route.fulfill({ json: displayFixture() }));

test("the billing tier stays on the card; the popover drops it and the warning moves to settings", async ({ page }) => {
  const fixture = displayFixture();
  fixture.season = {
    peak: false, tier: "valley", kind: "holiday", valleyReason: "holiday",
    flipAt: Date.now() + (41 * 3600 + 12 * 60) * 1000,
    beijing: { weekday: "周二", clock: "15:52", dayKey: "2026-10-06" },
    warning: "节假日表缺少 2027 年的安排，工作日假期会被误判为峰价。",
  };
  // 只有 DeepSeek 拿得到拆分：峰谷价是它的专属规则
  fixture.suppliers.find((s) => s.id === "deepseek").seasonSplit = { peakTokens: 1_200_000, valleyTokens: 3_600_000, unknownTokens: 0 };
  await page.route(/\/api\/dsh-token-quota\/state(?:\?.*)?$/, (route) => route.fulfill({ json: fixture }));
  await page.goto("/");

  const strip = page.locator("[data-qm-season]");
  await expect(strip).toHaveAttribute("data-qm-season", "valley");
  await expect(strip).toContainText("谷价");
  await expect(strip).toContainText("1d17h 后切换");
  // 卡片只报档位：成因属于明细，不进这一行
  await expect(strip).not.toContainText("法定节假日");
  // 圆点颜色必须真的区分峰谷，而不是只有文字
  const valleyColor = await strip.locator(".qm-season-dot").evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(valleyColor).not.toBe("rgba(0, 0, 0, 0)");

  await page.locator("[data-qm-entry]").click();
  // 浮卡不再重复时段块：档位与倒计时由常驻卡片承担
  await expect(page.locator(".qm-season-block")).toHaveCount(0);
  await expect(page.locator('[data-qm-season-split="deepseek"]')).toContainText("高峰 1.20M（25%）");
  await expect(page.locator('[data-qm-season-split="opencode"]')).toHaveCount(0);

  await page.locator(".qm-pop").getByRole("button", { name: "详情", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "供应商限额明细", exact: true });
  await expect(detail.locator('[data-supplier="deepseek"] [data-qm-season-block]')).toHaveCount(1);
  await expect(detail.locator('[data-supplier="deepseek"] [data-qm-season-block]')).toContainText("法定节假日");
  await expect(detail.locator('[data-supplier="opencode"] [data-qm-season-block]')).toHaveCount(0);

  // 缺次年必须点名，且要点在能立刻粘贴覆盖表的地方
  await detail.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "用量监控", exact: true });
  await settings.getByRole("tab", { name: "设置", exact: true }).click();
  await expect(settings.locator(".qm-season-warn")).toContainText("2027");
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);

  // 峰价必须换成另一档文案与另一种颜色（否则「区分峰谷」只是说法）
  fixture.season = { ...fixture.season, peak: true, tier: "peak", kind: "weekday", valleyReason: null,
    beijing: { weekday: "周二", clock: "10:00", dayKey: "2026-10-13" } };
  await page.reload();
  await expect(page.locator("[data-qm-season]")).toContainText("峰价");
  const peakColor = await page.locator("[data-qm-season] .qm-season-dot").evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(peakColor).not.toBe(valleyColor);
});

test("real provider parsing keeps unknown Command Code resets empty and valid OpenCode countdowns", async ({ page }) => {  const resetAt = Date.now() + 5 * 3600_000;
  const previousFetch = globalThis.fetch;
  let command, opencode;
  try {
    globalThis.fetch = async (url) => {
      const path = new URL(url).pathname;
      const body = path.endsWith("/whoami") ? { org: { id: "fixture-org" } }
        : path.endsWith("/credits") ? {
          credits: { planId: "goat", monthlyCredits: 70 },
          windowLimits: { fiveHour: { used: 0, cap: 14, resetAt: 0 }, weekly: { used: 0, cap: 35, resetAt: "0" } },
        } : path.endsWith("/subscriptions") ? { data: { currentPeriodEnd: new Date(resetAt).toISOString() } }
          : { usage: { rolling: { percent: 52, resetsAt: new Date(resetAt).toISOString() } } };
      return { ok: true, text: async () => JSON.stringify(body) };
    };
    const cfg = { apiKey: "fixture", warnPct: 80, critPct: 95 };
    command = await PROVIDERS.commandcode.query(cfg);
    opencode = await PROVIDERS.opencode.query(cfg);
  } finally { globalThis.fetch = previousFetch; }
  const fixture = displayFixture();
  fixture.suppliers = [
    { id: "commandcode", name: "Command Code", added: true, enabled: true, ...command },
    { id: "opencode", name: "OpenCode", added: true, enabled: true, ...opencode },
  ];
  await page.route(/\/api\/dsh-token-quota\/state(?:\?.*)?$/, route => route.fulfill({ json: fixture }));
  await page.goto("/");
  await page.locator("[data-qm-entry]").click();
  await page.locator(".qm-pop").getByRole("button", { name: "详情", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "供应商限额明细", exact: true });
  const entries = detail.locator(".qm-col").filter({ hasText: "Command Code" }).locator(".qm-card-item");
  await expect(entries).toHaveCount(3);
  await expect(entries.nth(0).locator(".ci-name span").last()).toHaveText("—");
  await expect(entries.nth(1).locator(".ci-name span").last()).toHaveText("—");
  await expect(entries.nth(0)).toContainText("未提供重置时刻");
  await expect(entries.nth(2).locator(".ci-name span").last()).toContainText(/4h59m|5h00m/);
  await expect(detail.locator(".qm-col").filter({ hasText: "OpenCode" })).toContainText(/4h59m|5h00m/);
  await expect(detail).not.toContainText("1月1日");
  await expect(detail).not.toContainText("NaN");
});
test("restored details show supplier columns and a bounded history table before settings", async ({ page }) => {
  const fixture = displayFixture();
  fixture.suppliers.push({ id: "commandcode", name: "Command Code", added: true, enabled: true, state: "ok",
    entries: [{ kind: "win", name: "5h 窗口", pct: 0, limit: "100%", used: "0%" }] });
  fixture.suppliers.push({ id: "hidden", name: "Unconfigured", added: false, entries: [] });
  fixture.history = Array.from({ length: 55 }, (_, i) => ({ t: `2026-10-04 12:00:${i}`, supplier: "OpenCode", ok: i !== 0, summary: "5h · 63%", error: i === 0 ? "fixture timeout" : null }));
  await page.route(/\/api\/dsh-token-quota\/state(?:\?.*)?$/, route => route.fulfill({ json: fixture }));
  await page.goto("/");
  await page.locator("[data-qm-entry]").click();
  await page.locator(".qm-pop").getByRole("button", { name: "详情", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "供应商限额明细", exact: true });
  await expect(detail).toBeVisible();
  await expect(detail.getByRole("tab")).toHaveCount(0);
  await expect(detail.locator(".qm-col")).toHaveCount(3);
  await expect(detail).not.toContainText("Unconfigured");
  const columns = await detail.locator(".qm-col").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top));
  expect(new Set(columns).size).toBe(1);
  await detail.getByRole("button", { name: "关闭", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(detail.locator(".qm-history summary")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(detail.getByRole("columnheader")).toHaveText(["时间", "供应商", "时段", "结果", "主指标", "备注"]);
  await expect(detail.locator("tbody tr")).toHaveCount(50);
  await expect(detail.locator("tbody tr").first()).toContainText("fixture timeout");
  // 这一页的夹具没有 season，历史记录也不带 tier：必须显示「—」而不是编造一个时段
  await expect(detail.locator("tbody tr").first().locator("td").nth(2)).toHaveText("—");
  await mkdir(visualDirectory, { recursive: true });
  await page.screenshot({ path: resolve(visualDirectory, "restored-details.png"), fullPage: true });
  await detail.getByRole("button", { name: "设置", exact: true }).click();
  await expect(detail).toHaveCount(0);
  const settings = page.getByRole("dialog", { name: "用量监控", exact: true });
  await expect(settings.getByRole("tab")).toHaveCount(3);
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await expect(page.locator("[data-qm-entry]")).toBeFocused();
});
test.beforeEach(async ({ request }) => {
  await request.post(`${BASE}/__control`, { data: { stateDelay: 0, settingsDelay: 0, settingsFail: false, postCount: 0, config: baseConfig } });
});

for (const [width, density] of [[240, "expanded"], [180, "compact"], [64, "rail"]]) {
  test(`A2 ${width}px sidebar opens an anchored popover and returns focus`, async ({ page }) => {
    await useDisplayFixture(page);
    await page.goto(density === "rail" ? "/?rail&width=64" : `/?width=${width}`);
    const opener = page.locator("[data-qm-entry]");
    if (density !== "rail") await expect(page.locator("[data-qm-density]")).toHaveAttribute("data-qm-density", density);
    if (density === "expanded") {
      // 第 2 行是周窗口（40%）的进度条，不是更紧的 5 小时窗口（63%）
      const bar = opener.locator("[data-qm-bar]");
      await expect(bar).toHaveAttribute("data-qm-window", "week");
      await expect(opener.locator(".qm-bar-label")).toHaveText("周");
      await expect(opener.locator(".qm-bar-pct")).toHaveText("40%");
      const entryBox = await opener.boundingBox(), barBox = await bar.boundingBox();
      expect(barBox.width).toBeGreaterThan(40);
      expect(barBox.x + barBox.width).toBeLessThanOrEqual(entryBox.x + entryBox.width);
    }
    if (density === "compact") {
      // 紧凑态放不下进度条：仍旧是主指标文字（最紧的 63%）
      await expect(opener.locator(".qm-primary")).toContainText("63%");
    }
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "用量", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).not.toHaveAttribute("aria-modal", "true");
    await expect(dialog.getByRole("tab")).toHaveCount(0);
    await expect(page.locator(".qm-overlay")).toHaveCount(0);
    const popupBox = await dialog.boundingBox(), anchorBox = await opener.boundingBox();
    expect(popupBox.y + popupBox.height).toBeLessThanOrEqual(anchorBox.y);
    expect(popupBox.x).toBeGreaterThanOrEqual(0);
    expect(popupBox.x + popupBox.width).toBeLessThanOrEqual(1180);
    if (width === 240) {
      await expect(dialog.locator('[data-supplier="deepseek"]')).toContainText("更新失败 · 上次数据");
      await expect(dialog.locator('[data-supplier="deepseek"]')).toContainText("另有 1 项");
      await mkdir(visualDirectory, { recursive: true });
      await page.screenshot({ path: resolve(visualDirectory, "overview-normal-and-stale.png"), fullPage: true });
    }
    await expect(page.locator(".qm-pop")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
  });
}

test("the card shows the plan name and a coloured weekly bar, and falls back to text without a window", async ({ page }) => {
  const cardDirectory = resolve(".scratch/sidebar-card-v2");
  const route = (fixture) => page.route(/\/api\/dsh-token-quota\/state(?:\?.*)?$/, (r) => r.fulfill({ json: fixture }));
  const fixtures = displayFixture();
  await route(fixtures);
  await page.goto("/");

  const opener = page.locator("[data-qm-entry]");
  const bar = opener.locator("[data-qm-bar]");
  await expect(opener.locator(".qm-plan")).toHaveText("OpenCode");
  await expect(opener).not.toContainText("deepseek-v4.1-flash-with-a-very-long-model-name", "模型名不再进卡片");
  await expect(opener.locator(".qm-dot")).toHaveCount(0, "卡片不再有阈值圆点");
  await expect(bar).toHaveAttribute("data-qm-window", "week");
  await expect(bar).toHaveAttribute("data-qm-tone", "ok");
  await expect(opener.locator(".qm-bar-label")).toHaveText("周");
  await expect(opener.locator(".qm-bar-pct")).toHaveText("40%");
  await expect(opener.locator(".qm-bar-fill")).toHaveCSS("width", /\d+(\.\d+)?px/);
  const okColor = await opener.locator(".qm-bar-fill").evaluate((node) => getComputedStyle(node).backgroundColor);
  await mkdir(cardDirectory, { recursive: true });
  await page.screenshot({ path: resolve(cardDirectory, "card-week-ok.png"), fullPage: true });

  // 跨过 95% 阈值必须真的换成告警色（颜色融入条内，不再另有圆点）
  const crit = displayFixture();
  crit.suppliers.find((s) => s.id === "opencode").entries.find((e) => e.name === "周用量").pct = 96;
  await route(crit);
  await page.reload();
  await expect(opener.locator("[data-qm-bar]")).toHaveAttribute("data-qm-tone", "crit");
  const critColor = await opener.locator(".qm-bar-fill").evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(critColor).not.toBe(okColor);
  await page.screenshot({ path: resolve(cardDirectory, "card-week-crit.png"), fullPage: true });

  // 没有窗口（纯余额）时回落成主指标文字，绝不画一条 0% 的空条
  const balance = displayFixture();
  Object.assign(balance.suppliers.find((s) => s.id === "opencode"),
    { entries: [{ kind: "bal", name: "CNY", remain: "¥41.99", pct: null }] });
  await route(balance);
  await page.reload();
  await expect(opener.locator("[data-qm-bar]")).toHaveCount(0);
  await expect(opener.locator(".qm-primary")).toContainText("¥41.99");
  await page.screenshot({ path: resolve(cardDirectory, "card-balance-only.png"), fullPage: true });

  // 浅色主题：条色必须来自主题变量，而不是深色模式下凑巧一样的硬编码
  await route(crit);
  await page.goto("/?light");
  await expect(opener.locator("[data-qm-bar]")).toHaveAttribute("data-qm-tone", "crit");
  const lightCrit = await opener.locator(".qm-bar-fill").evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(lightCrit).not.toBe(critColor);
  await page.screenshot({ path: resolve(cardDirectory, "card-week-crit-light.png"), fullPage: true });
});

test("A2 sidebar preference persists and automatic narrow layout never overwrites it", async ({ page }) => {
  await page.goto("/");
  const strip = page.locator("[data-qm-density]");
  await expect(strip).toHaveAttribute("data-qm-density", "expanded");
  await page.getByRole("button", { name: "收起", exact: true }).click();
  await expect(strip).toHaveAttribute("data-qm-density", "compact");
  await page.reload();
  await expect(strip).toHaveAttribute("data-qm-density", "compact");
  await page.getByRole("button", { name: "展开", exact: true }).click();
  await expect(strip).toHaveAttribute("data-qm-density", "expanded");
  await page.evaluate(() => window.__qmHost.setWidth(180));
  await expect(strip).toHaveAttribute("data-qm-density", "compact");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("dsh-token-quota.ui.v1")))).toEqual({ sidebarDensity: "expanded" });
  await page.evaluate(() => window.__qmHost.setWidth(240));
  await expect(strip).toHaveAttribute("data-qm-density", "expanded");
  await page.locator("[data-qm-entry]").click();
  await page.locator(".qm-pop").getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "用量监控", exact: true });
  await dialog.getByRole("tab", { name: "设置", exact: true }).click();
  await dialog.getByLabel("侧栏显示", { exact: true }).selectOption("compact");
  await expect(strip).toHaveAttribute("data-qm-density", "compact");
});

test("usage popover toggles, dismisses without a backdrop, and fits resized viewports", async ({ page }) => {
  await useDisplayFixture(page);
  await page.goto("/");
  const entry = page.locator("[data-qm-entry]");
  const popover = page.getByRole("dialog", { name: "用量", exact: true });
  await entry.click();
  await expect(entry).toHaveAttribute("aria-expanded", "true");
  await expect(popover).toBeVisible();
  await entry.click();
  await expect(popover).toHaveCount(0);
  await entry.click();
  await page.getByRole("button", { name: "打开原生设置", exact: true }).click();
  await expect(popover).toHaveCount(0);
  await expect(page.locator(".qm-settings-page")).toBeVisible();
  await entry.click();
  await page.setViewportSize({ width: 280, height: 380 });
  await expect(popover).toBeVisible();
  const box = await popover.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(280);
  expect(box.y + box.height).toBeLessThanOrEqual(380);
  await popover.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(popover).toHaveCount(0);
  await expect(entry).toBeFocused();
});

test("the host's narrow layout opens details on the first tap; the wide layout keeps the popover", async ({ page }) => {
  await useDisplayFixture(page);
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto("/?rail");
  await page.locator("[data-qm-entry]").click();
  await expect(page.locator(".qm-pop")).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "供应商限额明细", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 1180, height: 800 });
  await page.reload();
  await page.locator("[data-qm-entry]").click();
  await expect(page.locator(".qm-pop")).toHaveCount(1);
  await expect(page.getByRole("dialog", { name: "用量", exact: true })).toBeVisible();
});

test("A3 dialog traps focus, preserves organization and retains a rejected draft", async ({ page }) => {
  await page.goto("/");
  const opener = page.locator("[data-qm-entry]");
  await opener.click();
  await page.locator(".qm-pop").getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "用量监控", exact: true });
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect.poll(() => dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await dialog.locator("button:visible").last().focus();
  await page.keyboard.press("Tab");
  await expect.poll(() => dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await dialog.getByRole("tab", { name: "供应商", exact: true }).click();
  await dialog.locator('.qm-page-row[data-supplier="opencode"]').getByRole("button", { name: "配置", exact: true }).click();
  const orgInput = dialog.getByLabel("org id（可选）", { exact: true });
  await expect(orgInput).toHaveValue("org-original");
  const advanced = dialog.locator("details.qm-advanced");
  await expect(advanced).not.toHaveAttribute("open", "");
  await advanced.locator("summary").click();
  const warning = advanced.locator('input[type="number"][max="99"]');
  await warning.fill("150");
  await advanced.locator("summary").click();
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(advanced).toHaveAttribute("open", "");
  await expect(warning).toHaveValue("150");
  await expect(orgInput).toHaveValue("org-original");
  await warning.fill("80");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog.locator(".qm-page-list")).toBeVisible();
  await dialog.locator('.qm-page-row[data-supplier="opencode"]').getByRole("button", { name: "配置", exact: true }).click();
  await expect(dialog.getByLabel("org id（可选）", { exact: true })).toHaveValue("org-original");
});

for (const light of [false, true]) {
  test(`A3 ${light ? "light" : "dark"} narrow panel remains inside viewport`, async ({ page }) => {
    await useDisplayFixture(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/?rail${light ? "&light" : ""}`);
    const opener = page.locator("[data-qm-entry]");
    await opener.click();
    await expect(page.locator(".qm-pop")).toHaveCount(0);
    const dialog = page.getByRole("dialog", { name: "供应商限额明细", exact: true });
    await expect(dialog).toBeVisible();
    await expect(opener).toHaveAttribute("aria-expanded", "true");
    await expect(dialog.locator('[data-metric-kind="balance"]')).toHaveCount(2);
    const box = await dialog.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await mkdir(visualDirectory, { recursive: true });
    await page.screenshot({ path: resolve(visualDirectory, `narrow-${light ? "light" : "dark"}.png`), fullPage: true });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
  });
}

test("A3 embedded settings has no modal restrictions and sidebar reuses it", async ({ page }) => {
  await page.goto("/?settings");
  const panel = page.locator(".qm-settings-page");
  await expect(panel).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".qm-overlay")).toHaveCount(0);
  await panel.getByRole("tab", { name: "设置", exact: true }).click();
  await page.locator("#background").focus();
  await page.keyboard.press("Escape");
  await expect(panel).toBeVisible();
  await expect(page.locator("#background")).toBeFocused();
  await page.locator("[data-qm-entry]").click();
  await page.locator(".qm-pop").getByRole("button", { name: "设置", exact: true }).click();
  await expect(panel.getByRole("tab", { name: "概览", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await panel.locator("button:visible, summary:visible, input:visible, select:visible").last().focus();
  await page.keyboard.press("Tab");
  await expect.poll(() => panel.evaluate((node) => node.contains(document.activeElement))).toBe(false);
});

test("A3 native page takes over an open dialog and preserves its secret draft", async ({ page }) => {
  await page.goto("/");
  await page.locator("[data-qm-entry]").click();
  await page.locator(".qm-pop").getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "用量监控", exact: true });
  await dialog.getByRole("tab", { name: "供应商", exact: true }).click();
  await dialog.locator('.qm-page-row[data-supplier="opencode"]').getByRole("button", { name: "配置", exact: true }).click();
  await dialog.getByLabel("API Key", { exact: true }).fill("isolated-draft-key");
  await page.evaluate(() => window.__qmHost.mountSettings());
  const panel = page.locator(".qm-settings-page");
  await expect(panel).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(panel.getByLabel("API Key", { exact: true })).toHaveValue("isolated-draft-key");
  expect(await page.evaluate(() => localStorage.getItem("dsh-token-quota.ui.v1") ?? "")).not.toContain("isolated-draft-key");
});

test("A3 embedded page restores its host scroll position after supplier configuration", async ({ page }) => {
  await useDisplayFixture(page);
  await page.goto("/?settings");
  await page.locator("#settings").evaluate((node) => Object.assign(node.style, { width: "350px", height: "260px", overflow: "auto" }));
  const panel = page.locator(".qm-settings-page");
  const configure = panel.locator('.qm-supplier-card[data-supplier="deepseek"]').getByRole("button", { name: "配置", exact: true });
  await configure.scrollIntoViewIfNeeded();
  const scrollTop = await page.locator("#settings").evaluate((node) => node.scrollTop);
  expect(scrollTop).toBeGreaterThan(0);
  await configure.click();
  await expect(panel.locator(".qm-page-head")).toContainText("DeepSeek");
  await panel.getByRole("button", { name: "← 返回" }).click();
  await expect(panel.locator(".qm-overview-grid")).toBeVisible();
  await expect.poll(() => page.locator("#settings").evaluate((node) => node.scrollTop)).toBe(scrollTop);
});

// ---------- 关注限额：卡片多条进度条 + 配置页复选列表 ----------

/** 三个可关注窗口的 OpenCode 载荷；displayKeys 决定卡片画哪几条、按什么顺序。 */
const watchedFixture = (displayKeys, todayTokens = 1_240_000) => {
  const fixture = displayFixture();
  const opencode = fixture.suppliers.find((s) => s.id === "opencode");
  Object.assign(opencode, {
    todayTokens, displayKeys,
    entries: [
      { kind: "win", key: "window.5h", short: "5h", name: "5h 滚动", pct: 63, resetAt: Date.now() + 8_000_000 },
      { kind: "win", key: "window.weekly", short: "周", name: "周用量", pct: 40, resetAt: Date.now() + (2 * 24 + 5) * 3_600_000 },
      { kind: "win", key: "window.monthly", short: "月", name: "月用量", pct: 80, resetAt: Date.now() + 12 * 86_400_000 },
    ],
  });
  return fixture;
};

test("watched limits draw one aligned bar per configured window, each with its own countdown", async ({ page }) => {
  await page.route(/\/api\/dsh-token-quota\/state(?:\?.*)?$/, (r) => r.fulfill({ json: watchedFixture(["window.monthly", "window.weekly"]) }));
  await page.goto("/");
  const entry = page.locator("[data-qm-entry]");
  const bars = entry.locator("[data-qm-bar]");
  await expect(bars).toHaveCount(2);
  // 配置顺序 = 排列顺序（月在前），不是按百分比排序
  await expect(entry.locator(".qm-bar-label")).toHaveText(["月", "周"]);
  await expect(entry.locator(".qm-bar-pct")).toHaveText(["80%", "40%"]);
  // 每条倒计时是裸时长，属于自己那条窗口
  await expect(entry.locator(".qm-bar-reset")).toHaveText([/^12d\d+h$/, /^2d\d+h$/]);
  // 严格对齐：同一 x、同一宽度、倒计时右缘一致
  const [first, second] = [await bars.nth(0).boundingBox(), await bars.nth(1).boundingBox()];
  expect(first.x).toBeCloseTo(second.x, 1);
  expect(first.width).toBeCloseTo(second.width, 1);
  const resets = entry.locator(".qm-bar-reset");
  const [r1, r2] = [await resets.nth(0).boundingBox(), await resets.nth(1).boundingBox()];
  expect(r1.x + r1.width).toBeCloseTo(r2.x + r2.width, 1);
  // 卡片第 3 行（今日）已取消；今日用量改在详情弹窗里按供应商展示
  await expect(entry.locator(".qm-l3")).toHaveCount(0);
  await entry.click();
  await page.locator(".qm-pop").getByRole("button", { name: "详情", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "供应商限额明细", exact: true });
  await expect(detail.locator('[data-supplier="opencode"] .qm-today-line')).toContainText("1.24M tokens");
});

test("no watched limits keeps the weekly default, and an empty intersection falls back quietly", async ({ page }) => {
  await page.route(/\/api\/dsh-token-quota\/state(?:\?.*)?$/, (r) => r.fulfill({ json: watchedFixture([]) }));
  await page.goto("/");
  const entry = page.locator("[data-qm-entry]");
  await expect(entry.locator("[data-qm-bar]")).toHaveCount(1);
  await expect(entry.locator(".qm-bar-label")).toHaveText("周");
  await expect(entry.locator("[data-qm-bar]")).toHaveAttribute("data-qm-window", "week");
  // 配了但当前全都不可用 → 与「没配」同样回落，不报错、不画空条
  await page.route(/\/api\/dsh-token-quota\/state(?:\?.*)?$/, (r) => r.fulfill({ json: watchedFixture(["gone.key"]) }));
  await page.reload();
  await expect(entry.locator("[data-qm-bar]")).toHaveCount(1);
  await expect(entry.locator(".qm-bar-label")).toHaveText("周");
});

test("the supplier page lists watchable limits and saves displayKeys in check order", async ({ page }) => {
  await page.route(/\/api\/dsh-token-quota\/state(?:\?.*)?$/, (r) => r.fulfill({ json: watchedFixture([]) }));
  await page.goto("/");
  await page.locator("[data-qm-entry]").click();
  await page.locator(".qm-pop").getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "用量监控", exact: true });
  await dialog.getByRole("tab", { name: "供应商", exact: true }).click();
  await dialog.locator('.qm-page-row[data-supplier="opencode"]').getByRole("button", { name: "配置", exact: true }).click();
  const rows = dialog.locator(".qm-watch .w-row");
  await expect(rows).toHaveCount(3);
  const saved = page.waitForResponse((r) => r.url().endsWith("/settings") && r.request().method() === "POST");
  await rows.filter({ hasText: "月用量" }).locator("input[type=checkbox]").check();
  await rows.filter({ hasText: "周用量" }).locator("input[type=checkbox]").check();
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  expect((await saved).request().postDataJSON().suppliers.opencode.displayKeys).toEqual(["window.monthly", "window.weekly"]);
});
