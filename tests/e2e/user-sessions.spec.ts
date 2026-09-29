import {
  test,
  expect,
  type BrowserContext,
  type Page,
  type Route,
} from "@playwright/test";
import { randomUUID } from "node:crypto";

const password = "browser-session-password";
const username = () => "s_" + randomUUID().replaceAll("-", "").slice(0, 20);
const sessions = (page: Page) =>
  page.getByRole("region", { name: "登录会话", exact: true });

async function register(context: BrowserContext, name = username()) {
  const response = await context.request.post("/api/user/register", {
    headers: { Origin: process.env.TEST_BASE_URL! },
    data: { username: name, password, nickname: "会话测试" },
  });
  expect(response.ok()).toBeTruthy();
  return name;
}

async function login(page: Page, name: string) {
  await page.goto("/account/login");
  await page.getByLabel("用户名", { exact: true }).fill(name);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录账号", exact: true }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(
    sessions(page).getByRole("button", { name: "刷新登录列表" }),
  ).toBeEnabled();
}

async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

test("separate devices revoke one login without invalidating this device; revoking current login closes its other tab", async ({
  page,
  context,
  browser,
}) => {
  const name = await register(context);
  const other = await browser.newContext({
    baseURL: process.env.TEST_BASE_URL,
  });
  try {
    const device = await other.newPage();
    await login(device, name);
    await page.goto("/account");
    const panel = sessions(page);
    await expect(panel).toContainText("共 2 个登录");
    await expect(panel.getByText("当前登录", { exact: true })).toHaveCount(1);
    const sameDevice = await context.newPage();
    await sameDevice.goto("/account");
    await expect(sessions(sameDevice)).toContainText("共 2 个登录");
    const currentId = await panel
      .locator("li")
      .filter({ hasText: "当前登录" })
      .getAttribute("data-session-id");
    const otherId = await panel
      .locator("li")
      .filter({
        has: page.getByRole("button", { name: "退出此登录", exact: true }),
      })
      .getAttribute("data-session-id");
    expect(currentId).toBeTruthy();
    expect(otherId).toBeTruthy();
    const otherRow = panel.locator(`[data-session-id="${otherId}"]`);
    const otherDevice = await otherRow.locator("span").first().innerText();
    const otherLoginTime = await otherRow.locator("time").first().innerText();

    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain(otherDevice);
      expect(dialog.message()).toContain(
        `登录时间：${otherLoginTime}（北京时间）`,
      );
      expect(dialog.message()).not.toContain("（当前登录）");
      await dialog.dismiss();
    });
    await panel
      .getByRole("button", { name: "退出此登录", exact: true })
      .click();
    await expect(panel).toContainText("共 2 个登录");
    let held: Route | undefined;
    await page.route(`**/api/user/sessions/${otherId}`, (route) => {
      held = route;
    });
    page.once("dialog", (dialog) => dialog.accept());
    await panel
      .getByRole("button", { name: "退出此登录", exact: true })
      .click();
    await expect.poll(() => !!held).toBe(true);
    await expect(
      page.getByRole("button", { name: "保存昵称", exact: true }),
    ).toBeDisabled();
    await expect(
      panel.getByRole("button", { name: "刷新登录列表" }),
    ).toBeDisabled();
    await held!.continue();
    await expect(panel).toContainText("共 1 个登录");
    await expect(
      panel.locator(`[data-session-id="${currentId}"]`),
    ).toBeVisible();
    await expect(panel.locator(`[data-session-id="${otherId}"]`)).toHaveCount(
      0,
    );
    await expect(sessions(sameDevice)).toBeVisible();
    await expect(
      sameDevice.getByText("身份或登录状态已变化", { exact: false }),
    ).toHaveCount(0);
    expect(
      (await other.request.get("/api/user/sessions?page=1")).status(),
    ).toBe(401);
    expect(
      (await context.request.get("/api/user/sessions?page=1")).ok(),
    ).toBeTruthy();

    const currentRow = panel.locator(`[data-session-id="${currentId}"]`);
    const currentDevice = await currentRow.locator("span").first().innerText();
    const currentLoginTime = await currentRow
      .locator("time")
      .first()
      .innerText();
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain(`${currentDevice}（当前登录）`);
      expect(dialog.message()).toContain(
        `登录时间：${currentLoginTime}（北京时间）`,
      );
      await dialog.accept();
    });
    await panel
      .getByRole("button", { name: "退出当前登录", exact: true })
      .click();
    await expect(page).toHaveURL(/\/account\/login$/);
    await expect(
      sameDevice.getByRole("alert").filter({ hasText: "身份或登录状态已变化" }),
    ).toBeVisible();
    await expect(sessions(sameDevice)).toHaveCount(0);
    expect(
      (await context.request.get("/api/user/sessions?page=1")).status(),
    ).toBe(401);
    await sameDevice.close();
  } finally {
    await other.close();
  }
});

test("offline and lost responses retain the list and never replay a revoke automatically", async ({
  page,
  context,
  browser,
}) => {
  const name = await register(context);
  const other = await browser.newContext({
    baseURL: process.env.TEST_BASE_URL,
  });
  try {
    const device = await other.newPage();
    await login(device, name);
    await page.goto("/account");
    const panel = sessions(page);
    await expect(panel).toContainText("共 2 个登录");
    let deletes = 0;
    await page.route("**/api/user/sessions/*", async (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      deletes++;
      await route.fetch();
      await route.abort("failed");
    });
    await context.setOffline(true);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    await panel
      .getByRole("button", { name: "退出此登录", exact: true })
      .click();
    await expect(panel.getByRole("alert")).toContainText("离线");
    await expect(panel).toContainText("共 2 个登录");
    expect(deletes).toBe(0);
    await context.setOffline(false);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
    await settle(page);
    expect(deletes).toBe(0);
    page.once("dialog", (dialog) => dialog.accept());
    await panel
      .getByRole("button", { name: "退出此登录", exact: true })
      .click();
    await expect(panel.getByRole("alert")).toContainText("无法确认结果");
    await expect(panel).toContainText("共 2 个登录");
    expect(deletes).toBe(1);
    await page.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle(page);
    expect(deletes).toBe(1);
    await expect(panel.getByRole("alert")).toContainText("无法确认结果");
    await panel.getByRole("button", { name: "刷新登录列表" }).click();
    await expect(panel).toContainText("共 1 个登录");
    await expect(panel.getByRole("alert")).toHaveCount(0);
    expect(deletes).toBe(1);
  } finally {
    await context.setOffline(false);
    await other.close();
  }
});

test("manual pagination shows Beijing times and unknown legacy login metadata; a failed page retains the current list", async ({
  page,
  context,
}) => {
  await register(context);
  const items = Array.from({ length: 21 }, (_, i) => ({
    id: randomUUID(),
    browser: i === 20 ? null : "Chrome",
    os: i === 20 ? null : "Windows",
    createdAt: i === 20 ? null : "2026-09-28T18:02:03.000Z",
    expiresAt: "2026-10-28T18:02:03.000Z",
    current: i === 0,
  }));
  let reads = 0;
  let failNextPage = true;
  await page.route("**/api/user/sessions?*", async (route) => {
    reads++;
    const pageNumber = Number(
      new URL(route.request().url()).searchParams.get("page"),
    );
    if (pageNumber === 2 && failNextPage) {
      failNextPage = false;
      return route.abort("failed");
    }
    await route.fulfill({
      json: {
        data: {
          items: items.slice((pageNumber - 1) * 20, pageNumber * 20),
          total: 21,
          page: pageNumber,
          pageCount: 2,
          pageSize: 20,
        },
      },
    });
  });
  await page.goto("/account");
  const panel = sessions(page);
  await expect(panel.locator("li")).toHaveCount(20);
  await expect(panel).toContainText("第 1 / 2 页");
  await expect(panel.locator("li").first()).toContainText(
    "2026/09/29 02:02:03",
  );
  await expect(panel).toContainText("北京时间");
  await panel.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(panel.getByRole("alert")).toBeVisible();
  await expect(panel.locator("li")).toHaveCount(20);
  await expect(panel).toContainText("第 1 / 2 页");
  await panel.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(panel.locator("li")).toHaveCount(1);
  await expect(panel).toContainText("第 2 / 2 页");
  await expect(panel).toContainText("未知浏览器 · 未知系统");
  await expect(panel).toContainText("升级前登录，时间未知");
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("未知浏览器 · 未知系统");
    expect(dialog.message()).toContain("升级前登录，时间未知");
    expect(dialog.message()).not.toContain("（当前登录）");
    await dialog.dismiss();
  });
  await panel.getByRole("button", { name: "退出此登录", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "下一页", exact: true }),
  ).toBeDisabled();
  const before = reads;
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await settle(page);
  expect(reads).toBe(before);
  await panel.getByRole("button", { name: "刷新登录列表" }).click();
  await expect.poll(() => reads).toBe(before + 1);
  await panel.getByRole("button", { name: "上一页", exact: true }).click();
  await expect(panel).toContainText("第 1 / 2 页");
});

test("old identity list and revoke responses cannot repopulate a closed account page or navigate it", async ({
  page,
  context,
}) => {
  await register(context);
  await page.goto("/account");
  const panel = sessions(page);
  await expect(panel).toContainText("共 1 个登录");
  let held: Route | undefined;
  await page.route("**/api/user/sessions?*", (route) => {
    held = route;
  });
  await panel.getByRole("button", { name: "刷新登录列表" }).click();
  await expect.poll(() => !!held).toBe(true);
  const oldListing = await context.request.get("/api/user/sessions?page=1");
  await page.evaluate(() =>
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "party-identity-event",
        newValue: "different-account",
      }),
    ),
  );
  await expect(panel).toHaveCount(0);
  await held!.fulfill({ response: oldListing });
  await settle(page);
  await expect(panel).toHaveCount(0);
  await expect(
    page.getByRole("alert").filter({ hasText: "身份或登录状态已变化" }),
  ).toBeVisible();
  await page.unroute("**/api/user/sessions?*");

  await context.clearCookies();
  await register(context);
  await page.goto("/account");
  await expect(panel).toContainText("共 1 个登录");
  held = undefined;
  await page.route("**/api/user/sessions/*", (route) => {
    held = route;
  });
  page.once("dialog", (dialog) => dialog.accept());
  await panel
    .getByRole("button", { name: "退出当前登录", exact: true })
    .click();
  await expect.poll(() => !!held).toBe(true);
  await page.evaluate(() =>
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "party-identity-event",
        newValue: "another-account",
      }),
    ),
  );
  await expect(panel).toHaveCount(0);
  await held!.fulfill({ json: { data: { revoked: true, current: true } } });
  await settle(page);
  await expect(page).toHaveURL(/\/account$/);
  await expect(
    page.getByRole("alert").filter({ hasText: "身份或登录状态已变化" }),
  ).toBeVisible();
});
