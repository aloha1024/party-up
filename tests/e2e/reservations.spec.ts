import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
const tomorrow = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
async function fill(page: Page, game: string, capacity = 3) {
  await page.getByLabel("游戏名称", { exact: true }).fill(game);
  await page.getByLabel("预约日期", { exact: true }).fill(tomorrow);
  await page.getByLabel("开玩时间 · 北京时间", { exact: true }).fill("20:00");
  await page.getByLabel("发起人昵称", { exact: true }).fill("Host");
  await page
    .getByLabel("最大参与人数 · 含发起人", { exact: true })
    .fill(String(capacity));
  await page
    .getByLabel("备注（选填）", { exact: true })
    .fill("Browser test notes");
}
test("create, copy share text, guest joins, capacity closes registration, and stale edits retain drafts", async ({
  page,
  browser,
  context,
}) => {
  const game = "Browser-" + randomUUID();
  await page.goto("/reservation/new");
  await fill(page, game, 2);
  await page.getByRole("button", { name: "创建预约，召集队友" }).click();
  await expect(page).toHaveURL(/\/reservation\/(?!new$)[a-z0-9-]+$/);
  const url = page.url();
  await expect(page.getByText("你已在接龙名单中")).toBeVisible();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "分享接龙" }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain(game);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    url,
  );
  const guestContext = await browser.newContext({
    baseURL: process.env.TEST_BASE_URL,
  });
  try {
    const guest = await guestContext.newPage();
    await guest.goto(url);
    await guest.getByLabel("你的昵称").fill("Guest");
    await guest.getByRole("button", { name: "加入接龙", exact: true }).click();
    await expect(guest.getByText("你已在接龙名单中")).toBeVisible();
    const stranger = await browser.newContext();
    try {
      const view = await stranger.newPage();
      await view.goto(url);
      await expect(view.getByLabel("你的昵称")).toBeDisabled();
    } finally {
      await stranger.close();
    }
    const editor = await context.newPage();
    await editor.goto(url + "/edit");
    await page.goto(url + "/edit");
    await page.getByLabel("备注（选填）").fill("New host notes");
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(page).toHaveURL(url);
    await editor.getByLabel("最大参与人数 · 含发起人").fill("4");
    await editor.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(editor.locator('form [role="alert"]')).toContainText(
      "预约已被其他人修改",
    );
    await expect(editor.getByLabel("最大参与人数 · 含发起人")).toHaveValue("4");
    await expect(editor.getByLabel("备注（选填）")).toHaveValue(
      "Browser test notes",
    );
    await expect(
      editor.getByRole("button", { name: "保存修改", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByText("New host notes", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  } finally {
    await guestContext.close();
  }
});
test("lost creation response can be retried after reload without duplicate reservations", async ({
  page,
}) => {
  const game = "Retry-" + randomUUID();
  await page.goto("/reservation/new");
  await fill(page, game);
  await page.route(
    "**/api/reservations",
    async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.fetch(); // Commit succeeds, but simulate losing its response.
      await route.abort("connectionfailed");
    },
    { times: 1 },
  );
  await page.getByRole("button", { name: "创建预约，召集队友" }).click();
  await expect(page.locator('form [role="alert"]')).toContainText(
    "操作可能已生效",
  );
  await expect(page.getByLabel("游戏名称", { exact: true })).toHaveValue(game);
  await page.reload();
  await fill(page, game);
  await page.getByRole("button", { name: "创建预约，召集队友" }).click();
  await expect(page).toHaveURL(/\/reservation\/(?!new$)[a-z0-9-]+$/);
  await expect(page.getByText("你已在接龙名单中")).toBeVisible();
  const response = await page.request.get(
    "/api/reservations?q=" + encodeURIComponent(game),
  );
  expect((await response.json()).data.total).toBe(1);
});
test("offline submission preserves the draft and recovers after reconnect", async ({
  page,
  context,
}) => {
  await page.goto("/reservation/new");
  const game = "Offline-" + randomUUID();
  await fill(page, game);
  await context.setOffline(true);
  await page.getByRole("button", { name: "创建预约，召集队友" }).click();
  await expect(page.locator('form [role="alert"]')).toBeVisible();
  await expect(page.getByLabel("游戏名称", { exact: true })).toHaveValue(game);
  await context.setOffline(false);
  await page.getByRole("button", { name: "创建预约，召集队友" }).click();
  await expect(page).toHaveURL(/\/reservation\/(?!new$)[a-z0-9-]+$/);
});
test("administrator first login requires password change and opens management", async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== "desktop",
    "The isolated root account is initialized once.",
  );
  await page.goto("/admin");
  await page.getByLabel("账号", { exact: true }).fill("admin");
  await page
    .getByLabel("密码", { exact: true })
    .fill(process.env.TEST_ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "设置管理员密码" }),
  ).toBeVisible();
  const password = "e2e-" + randomUUID();
  await page.getByLabel(/^新密码/).fill(password);
  await page.getByLabel("确认新密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "设置密码并登录" }).click();
  await expect(page.getByRole("button", { name: "退出登录" })).toBeVisible();
  await page.getByRole("link", { name: "操作记录", exact: true }).click();
  await expect(
    page.locator("ol").getByText("修改本人密码", { exact: true }),
  ).toBeVisible();
});
