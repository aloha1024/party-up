import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { randomUUID } from "node:crypto";

async function source(context: BrowserContext) {
  const origin = process.env.TEST_BASE_URL!;
  await context.request.post("/api/identity", { headers: { Origin: origin } });
  const response = await context.request.post("/api/reservations", {
    headers: { Origin: origin, "Idempotency-Key": randomUUID() },
    data: {
      gameName: "Again-" + randomUUID(),
      hostName: "队长",
      scheduledAt: new Date(Date.now() + 86400000).toISOString(),
      maxPlayers: 4,
      description: "一起组队",
    },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()).data;
}
async function time(page: Page) {
  await page
    .getByLabel("预约日期", { exact: true })
    .fill(new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10));
  await page.getByLabel("开玩时间 · 北京时间", { exact: true }).fill("20:00");
}

test("host copies configuration into a new party and lost response lookup never duplicates it", async ({
  page,
  context,
}) => {
  const original = await source(context);
  await page.goto("/reservation/" + original.id);
  await page.getByRole("link", { name: "再开一局", exact: true }).click();
  await expect(page.getByRole("heading", { name: "再开一局" })).toBeVisible();
  await expect(page.getByLabel("游戏名称", { exact: true })).toHaveValue(
    original.gameName,
  );
  await expect(page.getByLabel("发起人昵称", { exact: true })).toHaveValue(
    "队长",
  );
  await expect(
    page.getByLabel("最大参与人数 · 含发起人", { exact: true }),
  ).toHaveValue("4");
  await expect(
    page.getByRole("textbox", { name: "备注（选填）", exact: true }),
  ).toHaveValue("一起组队");
  await expect(page.getByLabel("预约日期", { exact: true })).toHaveValue("");
  await expect(
    page.getByLabel("开玩时间 · 北京时间", { exact: true }),
  ).toHaveValue("");
  expect(
    await page.evaluate(() => sessionStorage.getItem("party-creation")),
  ).toBeNull();
  await time(page);
  const name = "Copied-" + randomUUID();
  await page.getByLabel("游戏名称", { exact: true }).fill(name);
  await page.route(
    "**/api/reservations",
    async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      expect(route.request().postDataJSON()).not.toHaveProperty("from");
      await route.fetch();
      await route.abort("connectionfailed");
    },
    { times: 1 },
  );
  await page.getByRole("button", { name: "创建预约，召集队友" }).click();
  await expect(page.locator('form [role="alert"]')).toContainText(
    "操作可能已生效",
  );
  const submission = await page.evaluate(() =>
    sessionStorage.getItem("party-creation"),
  );
  await page.getByLabel("游戏名称", { exact: true }).fill(name + "-changed");
  await page.getByRole("button", { name: "创建预约，召集队友" }).click();
  await expect(page.locator('form [role="alert"]')).toContainText(
    "上次创建结果尚未确认",
  );
  expect(
    await page.evaluate(() => sessionStorage.getItem("party-creation")),
  ).toBe(submission);
  await page
    .getByRole("button", { name: "查看上次创建结果", exact: true })
    .click();
  await expect(page).toHaveURL(/\/reservation\/(?!new)[a-z0-9-]+$/);
  expect(page.url()).not.toContain(original.id);
  const created = (
    await (
      await context.request.get(
        new URL(page.url()).pathname.replace(
          "/reservation/",
          "/api/reservations/",
        ),
      )
    ).json()
  ).data;
  expect(created.participants).toHaveLength(1);
  expect(created.isHost).toBe(true);
  expect(
    (
      await (
        await context.request.get("/api/reservations/" + original.id)
      ).json()
    ).data,
  ).toEqual(original);
  expect(
    (await (await context.request.get("/api/reservations?q=" + name)).json())
      .data.total,
  ).toBe(1);
  for (const tab of ["joined", "hosted"]) {
    await page.goto(`/my-reservations?tab=${tab}&q=${name}`);
    await expect(
      page.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
  }
});

test("copy preserves old drafts, resets between sources and ordinary creation, and supports explicit discard", async ({
  page,
  context,
}) => {
  const first = await source(context);
  const second = await source(context);
  await page.goto("/reservation/new");
  await page.getByLabel("游戏名称", { exact: true }).fill("未完成草稿");
  await time(page);
  const draft = await page.evaluate(() =>
    sessionStorage.getItem("party-reservation-draft:new"),
  );
  await page.goto("/reservation/" + first.id);
  await page.getByRole("link", { name: "再开一局", exact: true }).click();
  await expect(page.getByLabel("游戏名称", { exact: true })).toBeDisabled();
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("party-reservation-draft:new"),
    ),
  ).toBe(draft);
  await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
  await expect(page.getByLabel("游戏名称", { exact: true })).toHaveValue(
    "未完成草稿",
  );
  await expect(
    page.getByLabel("开玩时间 · 北京时间", { exact: true }),
  ).toHaveValue("20:00");
  await expect(
    page.getByText("已恢复旧草稿，当前内容以草稿为准，请核对日期和时间。"),
  ).toBeVisible();
  await page.goto("/reservation/new?from=" + second.id);
  await page
    .getByRole("button", { name: "丢弃草稿并使用本次配置", exact: true })
    .click();
  await expect(page.getByLabel("游戏名称", { exact: true })).toHaveValue(
    second.gameName,
  );
  await expect(page.getByLabel("预约日期", { exact: true })).toHaveValue("");
  await page.getByRole("link", { name: "创建预约", exact: true }).click();
  await expect(page.getByLabel("游戏名称", { exact: true })).toHaveValue("");
  await expect(
    page.getByLabel("最大参与人数 · 含发起人", { exact: true }),
  ).toHaveValue("5");
});

test("copy remains usable with unavailable storage and offline submission does not lose inputs", async ({
  page,
  context,
}) => {
  const original = await source(context);
  await page.addInitScript(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (this === sessionStorage)
        throw new DOMException("Blocked", "SecurityError");
      return set.call(this, key, value);
    };
  });
  await page.goto("/reservation/new?from=" + original.id);
  await time(page);
  await expect(
    page.getByText("浏览器未能保存草稿，刷新或离开前请复制需要保留的内容。"),
  ).toBeVisible();
  await context.setOffline(true);
  await page.getByRole("button", { name: "创建预约，召集队友" }).click();
  await expect(page.locator('form [role="alert"]')).toBeVisible();
  await expect(page.getByLabel("游戏名称", { exact: true })).toHaveValue(
    original.gameName,
  );
  await context.setOffline(false);
  await page.getByRole("button", { name: "创建预约，召集队友" }).click();
  await expect(page).toHaveURL(/\/reservation\/(?!new)[a-z0-9-]+$/);
  expect(page.url()).not.toContain(original.id);
});
