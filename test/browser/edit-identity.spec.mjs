import { test, expect } from "@playwright/test";

// A3 编辑器身份与阈值一致性：用真实插件后端 + 延迟与失败注入复现，
// 不只检查函数返回值（设置保存、目录刷新、连接测试都经真实路由往返）。

const API = "/api/dsh-token-quota";

/** 打开嵌入式监控面板。 */
async function openSettings(page) {
  await page.goto("/?settings");
  const panel = page.locator(".qm-settings-page");
  await expect(panel).toBeVisible();
  return panel;
}

/** 进入供应商页签并打开指定供应商。 */
async function openSupplier(page, dialog, name) {
  await dialog.getByRole("tab", { name: "供应商", exact: true }).click();
  // 精确匹配行内的供应商名容器，避免 hasText 命中「可添加」折叠区或按钮的可访问名
  const row = dialog.locator(".qm-page-row").filter({ has: page.locator("span.qm-page-name", { hasText: name }) });
  await row.first().getByRole("button", { name: "配置", exact: true }).click();
  await expect(dialog.locator(".qm-page-head")).toContainText(name);
}

/** 展开供应商页底部的全局设置折叠段。 */
async function openGlobal(panel) {
  const details = panel.locator("details.qm-global");
  if (!(await details.evaluate((el) => el.open))) await details.locator("summary").click();
  await expect(panel.locator('input[type="number"][min="10"]')).toBeVisible();
}

const BASE = "http://127.0.0.1:4179";
const control = (request, body) =>
  request.post(`${BASE}/__control`, { data: body }).then((r) => r.json());

const BASE_CONFIG = {
  suppliers: {
    opencode: { enabled: true, orgId: "org-original" },
    commandcode: { enabled: true },
  },
};

test.beforeEach(async ({ request }) => {
  // 每个用例都从同一份干净配置开始（配置在服务端持久，必须显式复位）
  await control(request, { stateDelay: 0, settingsDelay: 0, settingsFail: false, postCount: 0, config: BASE_CONFIG });
});

test("保存中切换编辑器：旧回调不清除新草稿、不覆盖新提示", async ({ page, request }) => {
  const dialog = await openSettings(page);
  await openSupplier(page, dialog, "OpenCode");
  const orgA = page.getByLabel("org id（可选）", { exact: true });
  await orgA.fill("draft-A");

  await control(request, { settingsDelay: 1500 });
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  // 保存期间：当前表单禁用编辑、重复保存被禁用，但仍允许返回目录
  await expect(orgA).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  const back = dialog.getByRole("button", { name: "← 返回" });
  await expect(back).toBeEnabled();
  await back.click();
  await dialog.getByRole("alertdialog").getByRole("button", { name: "放弃修改", exact: true }).click();
  await expect(dialog.locator(".qm-page-list")).toBeVisible();

  // 打开另一个编辑器输入新草稿，然后等 A 的保存落地
  await openSupplier(page, dialog, "Command Code");
  const keyB = page.getByLabel("API Key", { exact: true });
  await keyB.fill("sk-draft-B");
  await page.waitForTimeout(2000);

  // A 的成功回调不得清掉 B 的草稿、也不得把界面切回目录
  await expect(page.getByLabel("API Key", { exact: true })).toHaveValue("sk-draft-B");
  await expect(dialog.locator(".qm-page-head")).toContainText("Command Code");
  await expect(dialog.locator(".s-saved")).toHaveCount(0);
});

test("保存失败保留草稿；重新打开该供应商时以服务端为准", async ({ page, request }) => {
  const dialog = await openSettings(page);
  await openSupplier(page, dialog, "OpenCode");
  const org = page.getByLabel("org id（可选）", { exact: true });
  await org.fill("rejected-draft");

  await control(request, { settingsFail: true });
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("validation rejected");
  await expect(org).toHaveValue("rejected-draft");
  await expect(org).toBeEnabled();

  // 失败后重新打开：草稿按服务端最新值重建（不是残留的 rejected-draft）
  await dialog.getByRole("button", { name: "← 返回" }).click();
  const confirmation = dialog.getByRole("alertdialog");
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(org).toHaveValue("rejected-draft");
  await dialog.getByRole("button", { name: "← 返回" }).click();
  await dialog.getByRole("alertdialog").getByRole("button", { name: "放弃修改", exact: true }).click();
  await openSupplier(page, dialog, "OpenCode");
  await expect(page.getByLabel("org id（可选）", { exact: true })).toHaveValue("org-original");
});

test("编辑字段后旧连接测试返回，不显示为当前草稿的结果", async ({ page }) => {
  const dialog = await openSettings(page);
  await openSupplier(page, dialog, "OpenCode");
  const org = page.getByLabel("org id（可选）", { exact: true });

  await page.route(`**${API}/test`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true, result: { state: "ok", entries: [], headline: { kind: "amt", amt: "—" } } }) });
  });
  await dialog.getByRole("button", { name: "测试连接" }).click();
  // 测试在途时修改草稿：旧结果不得再显示为当前草稿的结果
  await org.fill("changed-after-test");
  await expect(org).toHaveValue("changed-after-test");
  await page.waitForTimeout(1600);
  // 旧测试既不得显示「连接正常」，其「测试中…」提示也不得停留在已改动的新草稿上
  await expect(dialog.locator(".s-test-res")).toHaveCount(0);
  // 再次测试尚未结束时离开编辑器，重开后不能继承旧 testBusy 锁。
  await dialog.getByRole("button", { name: "测试连接" }).click();
  await dialog.getByRole("button", { name: "← 返回" }).click();
  await dialog.getByRole("alertdialog").getByRole("button", { name: "放弃修改", exact: true }).click();
  await openSupplier(page, dialog, "OpenCode");
  const testAgain = dialog.getByRole("button", { name: "测试连接" });
  await expect(testAgain).toBeEnabled();
  const retried = page.waitForRequest((request) => request.url().endsWith(`${API}/test`));
  await testAgain.click();
  await retried;
  await expect(dialog.locator(".s-test-res.ok")).toBeVisible();
  await page.unroute(`**${API}/test`);
});

test("自定义阈值在详情卡与设置页预览使用同一判定", async ({ page, request }) => {
  // 供应商查询替身返回 rolling=49 / weekly=60 / monthly=80；阈值 50/70
  await request.post(`${BASE}/__suppliers`, { data: { opencode: { enabled: true, apiKey: "sk-test", warnPct: 50, critPct: 70 } } });
  await control(request, { usagePercent: 49 });
  await page.waitForTimeout(1200); // 等宿主轮询把替身响应折叠成条目

  const dialog = await openSettings(page);
  await openSupplier(page, dialog, "OpenCode");
  const tones = () => dialog.locator(".qm-quota-preview .qm-tone").evaluateAll((nodes) => nodes.map((n) => n.className));
  // 设置页预览 = 已保存配置（50/70）对应的查询结果
  await expect.poll(tones).toEqual(["qm-tone ok", "qm-tone warn", "qm-tone crit"]);
  // 状态药丸与预览同口径（最高 80 ≥ crit 70 → 临界）
  await expect(dialog.locator(".qm-page-head .qm-pill")).toHaveText("临界");

  // 概览展开行与设置页预览共用同一份阈值判定。
  await dialog.getByRole("tab", { name: "概览", exact: true }).click();
  const row = dialog.locator('.qm-row[data-supplier="opencode"]');
  await row.locator("[data-qm-row]").click();
  await expect(row.locator(".qm-row-detail")).toBeVisible();
  const detailTones = await row.locator(".qm-tone").evaluateAll((nodes) => nodes.map((n) => n.className));
  expect(detailTones).toEqual(["qm-tone ok", "qm-tone warn", "qm-tone crit"]);
  // 概览行的状态药丸与预览同口径
  await expect(row.locator(".qm-pill")).toHaveText("临界");
});

test("页签切换和背景重载保留草稿，明确放弃后才丢弃", async ({ page, request }) => {
  const panel = await openSettings(page);
  await openSupplier(page, panel, "OpenCode");
  await panel.getByLabel("org id（可选）", { exact: true }).fill("unsaved-organization");
  await panel.getByLabel("API Key", { exact: true }).fill("sk-private-draft");
  await panel.getByRole("tab", { name: "概览", exact: true }).click();
  await panel.getByRole("button", { name: "刷新", exact: true }).click();
  await panel.getByRole("tab", { name: "供应商", exact: true }).click();
  await expect(panel.getByLabel("org id（可选）", { exact: true })).toHaveValue("unsaved-organization");
  await expect(panel.getByLabel("API Key", { exact: true })).toHaveValue("sk-private-draft");
  await panel.getByRole("button", { name: "取消", exact: true }).click();
  await panel.getByRole("alertdialog").getByRole("button", { name: "放弃修改", exact: true }).click();
  await openSupplier(page, panel, "OpenCode");
  await expect(panel.getByLabel("org id（可选）", { exact: true })).toHaveValue("org-original");
  await expect(panel.getByLabel("API Key", { exact: true })).toHaveValue("");
});

test("留空密钥保存非秘密字段时保留已保存密钥", async ({ page, request }) => {
  await request.post(`${BASE}/__suppliers`, { data: { opencode: { apiKey: "sk-existing-private-key" } } });
  const panel = await openSettings(page);
  await openSupplier(page, panel, "OpenCode");
  await expect(panel.getByLabel("API Key", { exact: true })).toHaveValue("");
  await panel.getByLabel("org id（可选）", { exact: true }).fill("updated-org");
  const savedRequest = page.waitForRequest((req) => req.url().endsWith(`${API}/settings`) && req.method() === "POST");
  await panel.getByRole("button", { name: "保存", exact: true }).click();
  const body = (await savedRequest).postDataJSON();
  expect(body.suppliers.opencode).not.toHaveProperty("apiKey");
  await expect(panel.locator(".qm-page-list")).toBeVisible();
  const state = await (await request.get(`${BASE}${API}/state?session=`)).json();
  const opencode = state.suppliers.find((supplier) => supplier.id === "opencode");
  expect(opencode.keySet).toBe(true);
  expect(opencode.orgId).toBe("updated-org");
});

test("全局保存的迟到回调不得解锁供应商保存；供应商完成后可保存全局配置", async ({ page, request }) => {
  const panel = await openSettings(page);
  await openGlobal(panel);
  const interval = panel.locator('input[type="number"][min="10"]');
  await interval.fill("120");
  await control(request, { settingsDelay: 1500 });
  const globalCompleted = page.waitForResponse((response) => response.url().endsWith(`${API}/settings`) && response.request().postDataJSON()?.intervalSeconds === 120);
  await panel.getByRole("button", { name: "保存", exact: true }).click();
  await openSupplier(page, panel, "OpenCode");
  const org = panel.getByLabel("org id（可选）", { exact: true });
  await org.fill("supplier-after-global");
  await control(request, { settingsDelay: 3500 });
  const supplierCompleted = page.waitForResponse((response) => response.url().endsWith(`${API}/settings`) && response.request().postDataJSON()?.suppliers?.opencode?.orgId === "supplier-after-global");
  const save = panel.getByRole("button", { name: "保存", exact: true });
  await save.click();
  await expect(save).toBeDisabled();
  await expect(org).toBeDisabled();
  await globalCompleted;
  await expect(panel.locator(".s-saved")).toHaveCount(0);
  await expect(save).toBeDisabled();
  await expect(org).toBeDisabled();
  await save.evaluate((button) => button.click());
  expect((await control(request, {})).postCount).toBe(2);
  await supplierCompleted;
  await expect(panel.locator(".qm-page-list")).toBeVisible();
  await control(request, { settingsDelay: 0 });
  await openGlobal(panel);
  await interval.fill("121");
  const finalSave = page.waitForResponse((response) => response.url().endsWith(`${API}/settings`) && response.request().postDataJSON()?.intervalSeconds === 121);
  await panel.getByRole("button", { name: "保存", exact: true }).click();
  await finalSave;
  await expect(panel.locator(".s-saved")).toBeVisible();
  const state = await (await request.get(`${BASE}${API}/state?session=`)).json();
  expect(state.poll.intervalSeconds).toBe(121);
});

for (const rejected of [false, true]) test(`保存${rejected ? "失败" : "成功"}时原生页接管保留保存锁与草稿身份`, async ({ page, request }) => {
  await page.goto("/");
  await page.locator("[data-qm-entry]").click();
  const dialog = page.getByRole("dialog", { name: "用量监控", exact: true });
  await openSupplier(page, dialog, "OpenCode");
  await dialog.getByLabel("org id（可选）", { exact: true }).fill("native-takeover-draft");
  await control(request, { settingsDelay: 1200, settingsFail: rejected });
  const completed = page.waitForResponse((response) => response.url().endsWith(`${API}/settings`));
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await page.evaluate(() => window.__qmHost.mountSettings());
  const panel = page.locator(".qm-settings-page");
  await expect(panel).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const save = panel.getByRole("button", { name: "保存", exact: true });
  const org = panel.getByLabel("org id（可选）", { exact: true });
  await expect(save).toBeDisabled();
  await expect(org).toHaveValue("native-takeover-draft");
  await expect(org).toBeDisabled();
  await save.evaluate((button) => button.click());
  expect((await control(request, {})).postCount).toBe(1);
  await completed;
  if (rejected) {
    await expect(panel.getByRole("alert")).toContainText("validation rejected");
    await expect(org).toHaveValue("native-takeover-draft");
    await expect(org).toBeEnabled();
    await expect(save).toBeEnabled();
  } else {
    await expect(panel.locator(".qm-page-list")).toBeVisible();
    await openSupplier(page, panel, "OpenCode");
    await expect(panel.getByLabel("org id（可选）", { exact: true })).toHaveValue("native-takeover-draft");
    await expect(panel.getByRole("button", { name: "保存", exact: true })).toBeEnabled();
  }
  expect((await control(request, {})).postCount).toBe(1);
});

test("关闭在途保存后重开等候服务端实际状态，不复用旧缓存也不重放保存", async ({ page, request }) => {
  await page.goto("/");
  const opener = page.locator("[data-qm-entry]");
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "用量监控", exact: true });
  await openSupplier(page, dialog, "OpenCode");
  await dialog.getByLabel("org id（可选）", { exact: true }).fill("saved-after-close");
  await control(request, { settingsDelay: 1200 });
  const completed = page.waitForResponse((response) => response.url().endsWith(`${API}/settings`));
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await page.keyboard.press("Escape");
  await dialog.getByRole("alertdialog").getByRole("button", { name: "放弃修改", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await opener.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("org id（可选）", { exact: true })).toHaveCount(0);
  await expect(dialog.locator(".qm-overview-head")).toBeVisible();
  await completed;
  await openSupplier(page, dialog, "OpenCode");
  await expect(dialog.getByLabel("org id（可选）", { exact: true })).toHaveValue("saved-after-close");
  expect((await control(request, {})).postCount).toBe(1);
});

test("全局保存后关闭重开并原生接管时只初始化最新设置", async ({ page, request }) => {
  await page.goto("/");
  const opener = page.locator("[data-qm-entry]");
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "用量监控", exact: true });
  await dialog.getByRole("tab", { name: "供应商", exact: true }).click();
  await openGlobal(dialog);
  const interval = dialog.locator('input[type="number"][min="10"]');
  await expect(interval).toHaveValue("60");
  await interval.fill("120");
  await control(request, { settingsDelay: 1800 });
  const completed = page.waitForResponse((response) => response.url().endsWith(`${API}/settings`));
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await page.keyboard.press("Escape");
  await dialog.getByRole("alertdialog").getByRole("button", { name: "放弃修改", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await opener.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".qm-overview-head")).toBeVisible();
  await page.evaluate(() => window.__qmHost.mountSettings());
  const panel = page.locator(".qm-settings-page");
  await expect(panel).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // 等待中的再次侧栏点击不能提前解除 opening，也不能从旧缓存初始化 globalForm。
  await opener.click();
  await expect(panel.locator(".qm-overview-head")).toBeVisible();
  await expect(panel.locator('input[type="number"][min="10"]')).toHaveCount(0);
  await completed;
  await panel.getByRole("tab", { name: "供应商", exact: true }).click();
  await openGlobal(panel);
  await expect(panel.locator('input[type="number"][min="10"]')).toHaveValue("120");
  expect((await control(request, {})).postCount).toBe(1);
});

test("放弃另一个脏草稿后进入在途供应商仍等待保存完成", async ({ page, request }) => {
  const panel = await openSettings(page);
  await openSupplier(page, panel, "OpenCode");
  await panel.getByLabel("org id（可选）", { exact: true }).fill("pending-A-saved");
  await control(request, { settingsDelay: 1800 });
  const completed = page.waitForResponse((response) => response.url().endsWith(`${API}/settings`));
  await panel.getByRole("button", { name: "保存", exact: true }).click();
  await panel.getByRole("button", { name: "← 返回" }).click();
  await panel.getByRole("alertdialog").getByRole("button", { name: "放弃修改", exact: true }).click();
  await openSupplier(page, panel, "Command Code");
  await panel.getByLabel("API Key", { exact: true }).fill("private-dirty-B");
  await panel.getByRole("tab", { name: "概览", exact: true }).click();
  const opencodeRow = panel.locator('.qm-row[data-supplier="opencode"]');
  await opencodeRow.locator("[data-qm-row]").click();
  await opencodeRow.getByRole("button", { name: "配置", exact: true }).click();
  await panel.getByRole("alertdialog").getByRole("button", { name: "放弃修改", exact: true }).click();
  await expect(panel.getByLabel("org id（可选）", { exact: true })).toHaveCount(0);
  await expect(panel.getByLabel("API Key", { exact: true })).toHaveCount(0);
  expect((await control(request, {})).postCount).toBe(1);
  await completed;
  await expect(panel.getByLabel("org id（可选）", { exact: true })).toHaveValue("pending-A-saved");
  await expect(panel.getByLabel("org id（可选）", { exact: true })).toBeEnabled();
  await expect(panel.getByLabel("API Key", { exact: true })).toHaveValue("");
  expect((await control(request, {})).postCount).toBe(1);
});
