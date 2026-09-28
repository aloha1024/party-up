import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
const password = "browser-user-password";
const username = () => "b_" + randomUUID().replaceAll("-", "").slice(0, 20);
async function account(context: BrowserContext, name: string) {
  const response = await context.request.post("/api/user/register", {
    headers: { Origin: process.env.TEST_BASE_URL! },
    data: { username: name, password, nickname: "账号昵称" },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).data;
}
async function create(
  context: BrowserContext,
  gameName: string,
  visibility = "PUBLIC",
) {
  const identity = (await (await context.request.get("/api/identity")).json())
    .data;
  const response = await context.request.post("/api/reservations", {
    headers: {
      Origin: process.env.TEST_BASE_URL!,
      "Idempotency-Key": randomUUID(),
      "X-Identity-Scope": identity.scope,
    },
    data: {
      gameName,
      hostName: "发起人",
      scheduledAt: new Date(Date.now() + 86400000).toISOString(),
      maxPlayers: 3,
      visibility,
    },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).data;
}
test("guest hosting upgrades through explicit registration and claim; account works on another device", async ({
  page,
  context,
  browser,
}) => {
  const name = username(),
    game = "游客关联" + name;
  await page.goto("/reservation/new");
  await expect(
    page.getByRole("option", { name: "邀请制预约（需登录）" }),
  ).toHaveJSProperty("disabled", true);
  await page.getByLabel("游戏名称", { exact: true }).fill(game);
  await page
    .getByLabel("预约日期", { exact: true })
    .fill(new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10));
  await page.getByLabel("开玩时间 · 北京时间", { exact: true }).fill("20:00");
  await page.getByLabel("发起人昵称", { exact: true }).fill("游客发起人");
  await page.getByRole("button", { name: "创建预约，召集队友" }).click();
  await expect(page).toHaveURL(/\/reservation\/(?!new)[a-z0-9-]+$/);
  const reservationUrl = page.url();
  await expect(
    page.getByRole("link", { name: "再开一局需注册并登录" }),
  ).toBeVisible();
  await page.goto("/account/register");
  await page.getByLabel("用户名", { exact: true }).fill(name);
  await page.getByLabel("默认昵称", { exact: true }).fill("账号昵称");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByLabel("确认密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "注册账号", exact: true }).click();
  await expect(page.getByLabel("恢复码", { exact: true })).toHaveText(
    /^[a-f0-9]{64}$/,
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByLabel("恢复码", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "我已保存，进入账号" }).click();
  await page.getByRole("button", { name: "预览游客记录" }).click();
  await expect(
    page.getByRole("region", { name: "关联游客记录" }),
  ).toContainText(game);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "确认关联所选记录" }).click();
  await expect(page).toHaveURL(/my-reservations/);
  await expect(page.getByText(game, { exact: true })).toBeVisible();
  const other = await browser.newContext({
    baseURL: process.env.TEST_BASE_URL,
  });
  try {
    const device = await other.newPage();
    await device.goto("/account/login");
    await device.getByLabel("用户名", { exact: true }).fill(name);
    await device.getByLabel("密码", { exact: true }).fill(password);
    await device.getByRole("button", { name: "登录账号", exact: true }).click();
    await expect(device).toHaveURL(/\/account$/);
    await device.goto(reservationUrl);
    await expect(
      device.getByRole("link", { name: "再开一局", exact: true }),
    ).toBeVisible();
    await expect(device.getByText("你已在接龙名单中")).toBeVisible();
  } finally {
    await other.close();
  }
});

test("claim response loss keeps the same manual retry and blocks pending guest creations", async ({
  page,
  context,
}) => {
  await context.request.post("/api/identity", {
    headers: { Origin: process.env.TEST_BASE_URL! },
  });
  const guestInfo = (await (await context.request.get("/api/identity")).json())
    .data;
  const r = await create(context, "关联重试" + username());
  await account(context, username());
  await page.goto("/account");
  await page.getByRole("button", { name: "预览游客记录" }).click();
  const pendingKey = `party-creation:identity:${guestInfo.storageKey}`;
  await page.evaluate(
    (key) => sessionStorage.setItem(key, "unconfirmed-test"),
    pendingKey,
  );
  await page.getByRole("button", { name: "确认关联所选记录" }).click();
  await expect(page.locator("p[role=alert]")).toContainText("未确认创建");
  await page.evaluate((key) => sessionStorage.removeItem(key), pendingKey);
  const keys: string[] = [];
  await page.route("**/api/user/guest-claims", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    keys.push(route.request().postDataJSON().key);
    if (keys.length === 1) {
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "确认关联所选记录" }).click();
  await expect(page.locator("p[role=alert]")).toContainText("可手动重试");
  expect(keys).toHaveLength(1);
  await page.getByRole("button", { name: "确认关联所选记录" }).click();
  await expect(page).toHaveURL(/my-reservations/);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  await expect(page.getByRole("heading", { name: r.gameName })).toHaveCount(1);
});
test("logout clears private content in another tab and account drafts do not become guest drafts", async ({
  page,
  context,
}) => {
  const name = username();
  await account(context, name);
  const r = await create(context, "私密账号" + name, "INVITE");
  const privateTab = await context.newPage();
  await privateTab.goto(`/reservation/${r.id}`);
  await expect(
    privateTab.getByRole("heading", { name: r.gameName }),
  ).toBeVisible();
  await page.goto("/reservation/new");
  await page.getByLabel("游戏名称", { exact: true }).fill("仅账号可见的草稿");
  await page.goto("/account");
  await page.getByRole("button", { name: "退出账号，使用游客模式" }).click();
  await expect(
    privateTab.getByRole("alert").filter({ hasText: "身份或登录状态已变化" }),
  ).toBeVisible();
  await expect(
    privateTab.getByRole("heading", { name: r.gameName }),
  ).toHaveCount(0);
  // The cross-tab notification can arrive before logout finishes navigating.
  await expect(page).toHaveURL(new URL("/", process.env.TEST_BASE_URL!).href);
  await page.goto("/reservation/new");
  await expect(page.getByLabel("游戏名称", { exact: true })).toHaveValue("");
  await privateTab.close();
});
test("recovery code changes password once; offline account form preserves input", async ({
  page,
  context,
}) => {
  const name = username(),
    { recoveryCode } = await account(context, name);
  await page.goto("/account/recover");
  await page.getByLabel("用户名", { exact: true }).fill(name);
  await page.getByLabel("恢复码", { exact: true }).fill(recoveryCode);
  await page.getByLabel("新密码", { exact: true }).fill(password + "new");
  await page.getByLabel("确认密码", { exact: true }).fill(password + "new");
  await context.setOffline(true);
  await page.getByRole("button", { name: "找回密码", exact: true }).click();
  await expect(page.locator("p[role=alert]")).toContainText("离线");
  await expect(page.getByLabel("新密码", { exact: true })).toHaveValue(
    password + "new",
  );
  await context.setOffline(false);
  await page.getByRole("button", { name: "找回密码", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("密码已重置");
  const reused = await context.request.post("/api/user/recovery/reset", {
    headers: { Origin: process.env.TEST_BASE_URL! },
    data: { username: name, recoveryCode, password },
  });
  expect(reused.status()).toBe(400);
  await page.goto("/account/login");
  await page.getByLabel("用户名", { exact: true }).fill(name);
  await page.getByLabel("密码", { exact: true }).fill(password + "new");
  await page.getByRole("button", { name: "登录账号", exact: true }).click();
  await expect(page).toHaveURL(/\/account$/);
});
