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
test("guest claim conflicts and stale previews require repreview before a partial selection", async ({
  page,
  context,
}) => {
  const origin = { Origin: process.env.TEST_BASE_URL! };
  await context.request.post("/api/identity", { headers: origin });
  const selected = await create(context, "选中关联" + username());
  const retained = await create(context, "保留游客" + username());
  const conflict = await create(context, "同场冲突" + username());
  const { identity } = await account(context, username());
  const headers = { ...origin, "X-Identity-Scope": identity.scope };
  expect(
    (
      await context.request.post(
        `/api/reservations/${conflict.id}/participants`,
        { headers, data: { name: "账号参加者" } },
      )
    ).ok(),
  ).toBeTruthy();
  await page.goto("/account");
  const claims = page.getByRole("region", { name: "关联游客记录" });
  const checkbox = (gameName: string) =>
    claims.locator("label").filter({ hasText: gameName }).getByRole("checkbox");
  await claims.getByRole("button", { name: "预览游客记录" }).click();
  await expect(checkbox(selected.gameName)).toBeChecked();
  await expect(checkbox(retained.gameName)).toBeChecked();
  await expect(checkbox(conflict.gameName)).not.toBeChecked();
  await expect(checkbox(conflict.gameName)).toBeDisabled();
  await expect(claims).toContainText("同场存在两份正式或候补名额");
  await checkbox(retained.gameName).uncheck();

  // Resolving a conflict changes the full preview snapshot, even when that
  // reservation was not selected for the pending partial claim.
  expect(
    (
      await context.request.delete(
        `/api/reservations/${conflict.id}/participants`,
        { headers },
      )
    ).ok(),
  ).toBeTruthy();
  page.on("dialog", (dialog) => dialog.accept());
  await claims.getByRole("button", { name: "确认关联所选记录" }).click();
  await expect(claims.getByRole("alert")).toContainText("重新预览");
  await expect(checkbox(selected.gameName)).toBeDisabled();
  await expect(checkbox(retained.gameName)).toBeDisabled();
  await claims.getByRole("button", { name: "预览游客记录" }).click();
  await expect(claims.getByRole("alert")).toHaveCount(0);
  await expect(checkbox(conflict.gameName)).toBeEnabled();
  for (const r of [selected, retained, conflict])
    await expect(checkbox(r.gameName)).toBeChecked();
  await checkbox(retained.gameName).uncheck();
  await checkbox(conflict.gameName).uncheck();
  const request = page.waitForRequest(
    (request) =>
      request.url().endsWith("/api/user/guest-claims") &&
      request.method() === "POST",
  );
  await claims.getByRole("button", { name: "确认关联所选记录" }).click();
  expect((await request).postDataJSON().ids).toEqual([selected.id]);
  await expect(page).toHaveURL(/my-reservations/);
  await expect(
    page.getByRole("heading", { name: selected.gameName }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: retained.gameName }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: conflict.gameName }),
  ).toHaveCount(0);
  await page.goto("/account");
  await page.getByRole("button", { name: "退出账号，使用游客模式" }).click();
  await expect(page).toHaveURL(new URL("/", process.env.TEST_BASE_URL!).href);
  for (const [r, isHost] of [
    [selected, false],
    [retained, true],
    [conflict, true],
  ] as const) {
    const response = await context.request.get(`/api/reservations/${r.id}`);
    expect(response.ok()).toBeTruthy();
    expect((await response.json()).data.isHost).toBe(isHost);
  }
});

test("claim migrates scoped and legacy drafts without overwriting account drafts", async ({
  page,
  context,
}) => {
  await context.request.post("/api/identity", {
    headers: { Origin: process.env.TEST_BASE_URL! },
  });
  const guest = (await (await context.request.get("/api/identity")).json())
    .data;
  const existing = await create(context, "保留账号草稿" + username());
  const migrated = await create(context, "迁移游客草稿" + username());
  const { identity } = await account(context, username());
  await page.goto("/account");
  const draft = (gameName: string) =>
    JSON.stringify({
      version: 1,
      fields: {
        gameName,
        date: "",
        time: "",
        hostName: "游客发起人",
        maxPlayers: "3",
        description: "尚未提交的内容",
      },
    });
  const base = (id?: string) =>
    `party-reservation-draft:${id ? "edit:" + id : "new"}`;
  const from = (id?: string) => `${base(id)}:identity:${guest.storageKey}`;
  const to = (id?: string) => `${base(id)}:identity:${identity.storageKey}`;
  const stored = {
    [from(existing.id)]: draft("保留的游客草稿"),
    [to(existing.id)]: draft("已有账号草稿"),
    [from(migrated.id)]: draft("迁移编辑草稿"),
    [base()]: draft("旧格式创建草稿"),
  };
  await page.evaluate((values) => {
    for (const [key, value] of Object.entries(values))
      sessionStorage.setItem(key, value);
  }, stored);
  await page.getByRole("button", { name: "预览游客记录" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "确认关联所选记录" }).click();
  await expect(page).toHaveURL(/my-reservations/);
  expect(
    await page.evaluate(
      (keys) => keys.map((key) => sessionStorage.getItem(key)),
      [
        from(existing.id),
        to(existing.id),
        from(migrated.id),
        to(migrated.id),
        base(),
        to(),
        "party-legacy-guest",
      ],
    ),
  ).toEqual([
    stored[from(existing.id)],
    stored[to(existing.id)],
    null,
    stored[from(migrated.id)],
    null,
    stored[base()],
    guest.storageKey,
  ]);
  await page.goto("/reservation/new");
  await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
  await expect(page.getByLabel("游戏名称", { exact: true })).toHaveValue(
    "旧格式创建草稿",
  );
});

test("claim refuses unavailable submission storage and survives a draft migration write failure", async ({
  page,
  context,
}) => {
  await context.request.post("/api/identity", {
    headers: { Origin: process.env.TEST_BASE_URL! },
  });
  const guest = (await (await context.request.get("/api/identity")).json())
    .data;
  const r = await create(context, "存储受限关联" + username());
  const { identity } = await account(context, username());
  await page.goto("/account");
  await page.getByRole("button", { name: "预览游客记录" }).click();
  const from = `party-reservation-draft:edit:${r.id}:identity:${guest.storageKey}`;
  const to = `party-reservation-draft:edit:${r.id}:identity:${identity.storageKey}`;
  let posts = 0;
  page.on("request", (request) => {
    if (
      request.url().endsWith("/api/user/guest-claims") &&
      request.method() === "POST"
    )
      posts++;
  });
  await page.evaluate(
    ({ from, to }) => {
      sessionStorage.setItem(from, "draft-to-preserve");
      const get = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key) {
        if (this === sessionStorage && key.startsWith("party-creation"))
          throw new DOMException("Storage blocked", "SecurityError");
        return get.call(this, key);
      };
      Object.defineProperty(window, "restoreClaimStorage", {
        configurable: true,
        value: () => {
          Storage.prototype.getItem = get;
          const set = Storage.prototype.setItem;
          Storage.prototype.setItem = function (key, value) {
            if (this === sessionStorage && key === to)
              throw new DOMException("Storage full", "QuotaExceededError");
            return set.call(this, key, value);
          };
        },
      });
    },
    { from, to },
  );
  await page.getByRole("button", { name: "确认关联所选记录" }).click();
  await expect(page.locator("p[role=alert]")).toContainText(
    "无法读取本机提交记录",
  );
  expect(posts).toBe(0);
  await page.evaluate(() => {
    (
      window as typeof window & { restoreClaimStorage: () => void }
    ).restoreClaimStorage();
  });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "确认关联所选记录" }).click();
  await expect(page).toHaveURL(/my-reservations/);
  expect(posts).toBe(1);
  await expect(page.getByRole("heading", { name: r.gameName })).toBeVisible();
  expect(
    await page.evaluate(
      (keys) => keys.map((key) => sessionStorage.getItem(key)),
      [from, to],
    ),
  ).toEqual(["draft-to-preserve", null]);
  const response = await context.request.get(`/api/reservations/${r.id}`);
  expect(response.ok()).toBeTruthy();
  expect((await response.json()).data.isHost).toBe(true);
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
