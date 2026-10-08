import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

async function register(context: BrowserContext) {
  const response = await context.request.post("/api/user/register", {
    headers: { Origin: process.env.TEST_BASE_URL! },
    data: {
      username: "saved_" + randomUUID().replaceAll("-", "").slice(0, 20),
      password: "saved-template-browser-password",
      nickname: "模板队长",
    },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()).data.identity as {
    scope: string;
    storageKey: string;
  };
}
function configuration() {
  return {
    name: "常用模板 " + randomUUID().slice(0, 8),
    visibility: "PUBLIC" as "PUBLIC" | "INVITE",
    gameName: "Saved-" + randomUUID(),
    hostName: "模板队长",
    maxPlayers: 4,
    description: "周末一起组队",
    platform: "PC",
    gameServer: "亚洲区",
  };
}
async function savedTemplate(context: BrowserContext, scope: string) {
  const response = await context.request.post("/api/user/templates", {
    headers: {
      Origin: process.env.TEST_BASE_URL!,
      "X-Identity-Scope": scope,
    },
    data: configuration(),
  });
  expect(response.ok()).toBe(true);
  return (await response.json()).data;
}
async function chooseTime(page: Page, days = 2) {
  await page
    .getByLabel("预约日期", { exact: true })
    .fill(new Date(Date.now() + days * 86400000).toISOString().slice(0, 10));
  await page.getByLabel("开玩时间 · 北京时间", { exact: true }).fill("20:00");
}
async function storage(page: Page, base: string, storageKey: string) {
  return page.evaluate(
    (key) => sessionStorage.getItem(key),
    `${base}:identity:${storageKey}`,
  );
}

test("saved template CRUD persists configuration and using it creates a fresh reservation", async ({
  page,
  context,
}) => {
  await register(context);
  const data = { ...configuration(), visibility: "INVITE" };
  await page.goto("/account/templates");
  await expect(
    page.getByRole("heading", { name: "常用组局模板" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "新建模板", exact: true }).click();
  const form = page.getByRole("form", { name: "模板配置" });
  await form.getByLabel("模板名称", { exact: true }).fill(data.name);
  await form.getByLabel("游戏名称", { exact: true }).fill(data.gameName);
  await form.getByLabel("发起人昵称", { exact: true }).fill(data.hostName);
  await form
    .getByLabel("最大参与人数", { exact: true })
    .fill(String(data.maxPlayers));
  await form
    .getByRole("combobox", { name: "预约可见性", exact: true })
    .selectOption(data.visibility);
  await form.getByLabel("平台（选填）", { exact: true }).fill(data.platform);
  await form.getByLabel("区服（选填）", { exact: true }).fill(data.gameServer);
  await form.getByLabel("备注（选填）", { exact: true }).fill(data.description);
  await expect(form.getByLabel("预约日期", { exact: true })).toHaveCount(0);
  await expect(form.getByLabel("房间密码", { exact: true })).toHaveCount(0);
  await form.getByRole("button", { name: "保存模板", exact: true }).click();
  const rows = page.locator("[data-template-id]");
  await expect(rows).toHaveCount(1);
  const id = await rows.first().getAttribute("data-template-id");
  expect(id).toBeTruthy();
  await page.reload();
  const row = page.locator(`[data-template-id="${id}"]`);
  await expect(row).toContainText(data.name);
  await row.getByRole("button", { name: "编辑模板", exact: true }).click();
  await form.getByLabel("模板名称", { exact: true }).fill("改名后的组局模板");
  await form.getByLabel("最大参与人数", { exact: true }).fill("6");
  await form.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(row).toContainText("改名后的组局模板");
  await row.getByRole("link", { name: "使用模板", exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(`/reservation/new\\?template=${id}$`),
  );
  await expect(page.getByRole("heading", { name: "使用模板" })).toBeVisible();
  await expect(page.getByLabel("游戏名称", { exact: true })).toHaveValue(
    data.gameName,
  );
  await expect(page.getByLabel("发起人昵称", { exact: true })).toHaveValue(
    data.hostName,
  );
  await expect(
    page.getByLabel("最大参与人数 · 含发起人", { exact: true }),
  ).toHaveValue("6");
  await expect(page.getByRole("combobox", { name: /^预约可见性/ })).toHaveValue(
    "INVITE",
  );
  await expect(
    page.getByLabel("游戏平台（选填）", { exact: true }),
  ).toHaveValue(data.platform);
  await expect(page.getByLabel("区服（选填）", { exact: true })).toHaveValue(
    data.gameServer,
  );
  await expect(
    page.getByRole("textbox", { name: "备注（选填）", exact: true }),
  ).toHaveValue(data.description);
  for (const label of [
    "预约日期",
    "开玩时间 · 北京时间",
    "报名截止时间 · 北京时间（选填）",
  ])
    await expect(page.getByLabel(label, { exact: true })).toHaveValue("");
  await chooseTime(page);
  const posted = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/reservations",
  );
  await page
    .getByRole("button", { name: "创建预约，召集队友", exact: true })
    .click();
  const request = await posted;
  for (const key of [
    "template",
    "templateId",
    "id",
    "name",
    "version",
    "createdAt",
    "updatedAt",
    "participants",
    "roomPassword",
  ])
    expect(request.postDataJSON()).not.toHaveProperty(key);
  expect(request.headers()["idempotency-key"]).toMatch(/^[a-f0-9]{64}$/);
  await expect(page).toHaveURL(/\/reservation\/(?!new)[a-z0-9-]+$/);
  const reservationId = new URL(page.url()).pathname.split("/").pop();
  const reservation = (
    await (
      await context.request.get(`/api/reservations/${reservationId}`)
    ).json()
  ).data;
  expect(reservation.participants).toHaveLength(1);
  expect(reservation.isHost).toBe(true);
  expect(reservation.visibility).toBe("INVITE");
  expect(reservation.maxPlayers).toBe(6);
  await page.goto("/account/templates");
  page.once("dialog", (dialog) => dialog.accept());
  await row.getByRole("button", { name: "删除模板", exact: true }).click();
  await expect(rows).toHaveCount(0);
  expect(
    (await context.request.get(`/api/user/templates/${id}`)).status(),
  ).toBe(404);
  expect(
    (await context.request.get(`/api/reservations/${reservationId}`)).ok(),
  ).toBe(true);
});

test("choosing a saved template preserves a draft until explicit recovery or discard", async ({
  page,
  context,
}) => {
  const identity = await register(context);
  const first = await savedTemplate(context, identity.scope);
  const second = await savedTemplate(context, identity.scope);
  await page.goto("/reservation/new");
  await page.getByLabel("游戏名称", { exact: true }).fill("仍要保留的旧草稿");
  await chooseTime(page);
  const draft = await storage(
    page,
    "party-reservation-draft:new",
    identity.storageKey,
  );
  expect(draft).not.toBeNull();
  await page.goto(`/reservation/new?template=${first.id}`);
  await expect(page.getByLabel("游戏名称", { exact: true })).toBeDisabled();
  expect(
    await storage(page, "party-reservation-draft:new", identity.storageKey),
  ).toBe(draft);
  await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
  await expect(page.getByLabel("游戏名称", { exact: true })).toHaveValue(
    "仍要保留的旧草稿",
  );
  await expect(
    page.getByLabel("开玩时间 · 北京时间", { exact: true }),
  ).toHaveValue("20:00");
  await page.goto(`/reservation/new?template=${second.id}`);
  await page
    .getByRole("button", { name: "丢弃草稿并使用本次配置", exact: true })
    .click();
  await expect(page.getByLabel("游戏名称", { exact: true })).toHaveValue(
    second.gameName,
  );
  await expect(page.getByLabel("预约日期", { exact: true })).toHaveValue("");
  expect(await storage(page, "party-creation", identity.storageKey)).toBeNull();
  await page.getByRole("link", { name: "创建预约", exact: true }).click();
  await expect(page.getByLabel("游戏名称", { exact: true })).toHaveValue("");
});

test("unconfirmed creation survives switching templates and accounts without replacement or duplication", async ({
  page,
  context,
}) => {
  const identity = await register(context);
  const first = await savedTemplate(context, identity.scope);
  const second = await savedTemplate(context, identity.scope);
  await page.goto(`/reservation/new?template=${first.id}`);
  await chooseTime(page);
  let posts = 0;
  await page.route("**/api/reservations", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts++;
    await route.fetch();
    await route.abort("connectionfailed");
  });
  await page
    .getByRole("button", { name: "创建预约，召集队友", exact: true })
    .click();
  await expect(page.locator('form [role="alert"]')).toContainText(
    "操作可能已生效",
  );
  const submission = await storage(page, "party-creation", identity.storageKey);
  const originalDraft = await storage(
    page,
    "party-reservation-draft:new",
    identity.storageKey,
  );
  expect(submission).not.toBeNull();
  expect(posts).toBe(1);
  await page.goto(`/reservation/new?template=${second.id}`);
  await expect(
    page.getByRole("region", { name: "上次创建结果" }),
  ).toBeVisible();
  await expect(page.getByLabel("游戏名称", { exact: true })).toBeDisabled();
  expect(await storage(page, "party-creation", identity.storageKey)).toBe(
    submission,
  );
  expect(
    await storage(page, "party-reservation-draft:new", identity.storageKey),
  ).toBe(originalDraft);
  await page
    .getByRole("button", { name: "丢弃草稿并使用本次配置", exact: true })
    .click();
  await chooseTime(page, 4);
  await page
    .getByRole("button", { name: "创建预约，召集队友", exact: true })
    .click();
  await expect(page.locator('form [role="alert"]')).toContainText(
    "上次创建结果尚未确认",
  );
  expect(await storage(page, "party-creation", identity.storageKey)).toBe(
    submission,
  );
  expect(posts).toBe(1);

  const cookies = await context.cookies();
  await context.clearCookies();
  const other = await register(context);
  expect(other.storageKey).not.toBe(identity.storageKey);
  await page.goto("/account/templates");
  await expect(page.locator("[data-template-id]")).toHaveCount(0);
  expect(
    (await context.request.get(`/api/user/templates/${first.id}`)).status(),
  ).toBe(404);
  await page.goto("/reservation/new");
  await expect(page.getByLabel("游戏名称", { exact: true })).toBeEnabled();
  await expect(page.getByRole("region", { name: "上次创建结果" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("region", { name: "恢复预约草稿" })).toHaveCount(
    0,
  );
  await expect(page.getByLabel("游戏名称", { exact: true })).toHaveValue("");
  expect(await storage(page, "party-creation", identity.storageKey)).toBe(
    submission,
  );
  expect(await storage(page, "party-creation", other.storageKey)).toBeNull();

  await context.clearCookies();
  await context.addCookies(cookies);
  await page.goto(`/reservation/new?template=${second.id}`);
  await page
    .getByRole("button", { name: "查看上次创建结果", exact: true })
    .click();
  await expect(page).toHaveURL(/\/reservation\/(?!new)[a-z0-9-]+$/);
  await expect(
    page.getByRole("heading", { name: first.gameName, exact: true }),
  ).toBeVisible();
  expect(posts).toBe(1);
  const listing = await context.request.get(
    `/api/reservations?q=${encodeURIComponent(first.gameName)}`,
  );
  expect((await listing.json()).data.total).toBe(1);
  expect(await storage(page, "party-creation", identity.storageKey)).toBeNull();
  const retainedDraft = await storage(
    page,
    "party-reservation-draft:new",
    identity.storageKey,
  );
  expect(JSON.parse(retainedDraft!).fields.gameName).toBe(second.gameName);
});
