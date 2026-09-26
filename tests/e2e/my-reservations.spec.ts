import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

test("personal pagination survives reload, browser back and category changes on narrow screens", async ({
  page,
  context,
}, testInfo) => {
  const origin = process.env.TEST_BASE_URL!;
  const q = "Paging-" + randomUUID();
  await context.request.post("/api/identity", { headers: { Origin: origin } });
  for (let i = 0; i < 3; i++) {
    const response = await context.request.post("/api/reservations", {
      headers: { Origin: origin, "Idempotency-Key": randomUUID() },
      data: {
        gameName: `${q}-${i}`,
        hostName: "队长",
        scheduledAt: new Date(Date.now() + (i + 1) * 86400000).toISOString(),
        maxPlayers: 4,
      },
    });
    expect(response.ok()).toBe(true);
  }
  await page.goto(`/my-reservations?tab=joined&q=${q}&pageSize=1`);
  await page.getByRole("link", { name: "下一页", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: `${q}-1`, exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/page=2/);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: `${q}-1`, exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "我发起的", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: `${q}-0`, exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get("page")).toBeNull();
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: `${q}-1`, exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("my-reservations.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 320, height: 740 });
  await expect(
    page.getByRole("link", { name: "我的预约", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("my reservations separates browser identities and preserves category, filters and membership", async ({
  page,
  context,
  request,
}) => {
  const origin = process.env.TEST_BASE_URL!;
  const game = "Mine-" + randomUUID();
  await request.post("/api/identity", { headers: { Origin: origin } });
  const response = await request.post("/api/reservations", {
    headers: { Origin: origin, "Idempotency-Key": randomUUID() },
    data: {
      gameName: game,
      hostName: "Host",
      scheduledAt: new Date(Date.now() + 86400000).toISOString(),
      maxPlayers: 3,
    },
  });
  expect(response.ok()).toBe(true);
  const { data } = await response.json();
  await page.goto("/");
  await page.getByRole("link", { name: "我的预约", exact: true }).click();
  await expect(
    page.getByText("暂无当前浏览器的预约记录", { exact: true }),
  ).toBeVisible();
  expect(
    (await context.cookies()).some(
      (cookie) => cookie.name === "party_identity",
    ),
  ).toBe(false);
  await page.goto("/reservation/" + data.id);
  await page.getByLabel("你的昵称").fill("Guest");
  await page.getByRole("button", { name: "加入接龙", exact: true }).click();
  await expect(page.getByText("你已在接龙名单中")).toBeVisible();
  await page.getByRole("link", { name: "我的预约", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: game, exact: true }),
  ).toBeVisible();
  await page.getByLabel("搜索预约", { exact: true }).fill(game);
  await page.getByRole("button", { name: "筛选", exact: true }).click();
  await expect(page).toHaveURL(new RegExp("q=" + game));
  await page.getByRole("link", { name: "我发起的", exact: true }).click();
  await expect(page).toHaveURL(/tab=hosted/);
  await expect(
    page.getByText("没有符合条件的预约", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("搜索预约", { exact: true })).toHaveValue(game);
  await page.getByRole("link", { name: "重置", exact: true }).click();
  await expect(page).toHaveURL(/my-reservations\?tab=hosted$/);
  await page.getByRole("link", { name: "我参加的", exact: true }).click();
  await page.getByRole("heading", { name: game, exact: true }).click();
  await page.getByRole("button", { name: "退出接龙", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "加入接龙", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "我的预约", exact: true }).click();
  await expect(
    page.getByText("你还没有参加预约", { exact: true }),
  ).toBeVisible();
  // The API fixture has its own identity; switching cookies proves creation is in both categories.
  await context.clearCookies();
  await context.addCookies((await request.storageState()).cookies);
  await page.goto("/my-reservations");
  await expect(
    page.getByRole("heading", { name: game, exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "我发起的", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: game, exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
