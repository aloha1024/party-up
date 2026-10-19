import "../support/isolated";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../../server/db";
import { registeredToken, browserCookie, testCookie } from "../support/member";
import { digest, resolveViewer } from "../../server/user-identity";
import { createReservation } from "../../server/reservations";
import {
  acceptInvitation,
  currentInvitation,
  rotateInvitation,
} from "../../server/reservation-invitations";
import { setFavorite } from "../../server/reservation-favorites";

const ids: string[] = [],
  users: string[] = [];
const token = () => randomBytes(32).toString("hex");
const origin = () => process.env.TEST_BASE_URL!;
async function account() {
  const member = await registeredToken();
  const viewer = await resolveViewer(testCookie(member).split("=")[1]);
  users.push(viewer.user!.id);
  return { token: member, viewer, cookie: browserCookie(member) };
}
async function game(owner = token(), extra: Record<string, unknown> = {}) {
  const r = await createReservation(
    {
      gameName: "收藏浏览器-" + randomUUID(),
      hostName: "收藏队长",
      maxPlayers: 3,
      scheduledAt: new Date(Date.now() + 2 * 86400000).toISOString(),
      platform: "PC",
      gameServer: "亚洲",
      ...extra,
    },
    owner,
  );
  ids.push(r.id);
  return r;
}
const control = (page: Page) => page.getByRole("region", { name: "预约收藏" });
const card = (page: Page, id: string) =>
  page.locator(`a[href="/reservation/${id}"]`);
async function useAccount(
  context: BrowserContext,
  current: Awaited<ReturnType<typeof account>>,
) {
  await context.addCookies([{ ...current.cookie, url: origin() }]);
}
async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
test.afterEach(async () => {
  await db.gameReservation.deleteMany({ where: { id: { in: ids.splice(0) } } });
  await db.user.deleteMany({ where: { id: { in: users.splice(0) } } });
});
test.afterAll(async () => db.$disconnect());

test("account favorites synchronize across sessions and preserve platform filters through pagination and return navigation", async ({
  page,
  context,
  browser,
}, info) => {
  const current = await account(),
    q = "Favorite-pages-" + randomUUID();
  const first = await game(undefined, {
    gameName: `${q}-first`,
    scheduledAt: new Date(Date.now() + 2 * 86400000).toISOString(),
  });
  const second = await game(undefined, {
    gameName: `${q}-second`,
    scheduledAt: new Date(Date.now() + 3 * 86400000).toISOString(),
  });
  const other = await game(undefined, {
    gameName: `${q}-other`,
    platform: "PS5",
  });
  await useAccount(context, current);
  await page.goto(`/reservation/${first.id}`);
  await control(page)
    .getByRole("button", { name: "收藏预约", exact: true })
    .click();
  await expect(
    control(page).getByRole("button", { name: "取消收藏", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(
    await db.participant.count({ where: { reservationId: first.id } }),
  ).toBe(1);
  await setFavorite(current.viewer, second.id, true);
  await setFavorite(current.viewer, other.id, true);
  await page.goto(
    `/my-reservations?tab=hosted&q=${q}&platform=PC&gameServer=${encodeURIComponent("亚洲")}&view=available&pageSize=1&page=2`,
  );
  await page
    .getByRole("navigation", { name: "我的预约分类" })
    .getByRole("link", { name: "我的收藏", exact: true })
    .click();
  await expect(page).toHaveURL(/\/my-reservations\/favorites\?/);
  await expect(page.getByRole("heading", { name: "我的收藏." })).toBeVisible();
  const expected = {
    q,
    platform: "PC",
    gameServer: "亚洲",
    view: "available",
    pageSize: "1",
    tab: null,
    page: null,
  };
  const query = () =>
    Object.fromEntries(
      Object.keys(expected).map((key) => [
        key,
        new URL(page.url()).searchParams.get(key),
      ]),
    );
  expect(query()).toEqual(expected);
  await expect(card(page, first.id)).toBeVisible();
  await expect(page.locator("[data-reservation-platform]")).toHaveText(
    "平台：PC",
  );
  await expect(page.locator("[data-reservation-server]")).toHaveText(
    "区服：亚洲",
  );
  const pagination = page.getByRole("navigation", { name: "预约分页" });
  await expect(pagination).toContainText("共 2 场");
  await pagination.getByRole("link", { name: "下一页", exact: true }).click();
  await expect(card(page, second.id)).toBeVisible();
  expect(query()).toEqual({ ...expected, page: "2" });
  await page.reload();
  await expect(card(page, second.id)).toBeVisible();
  await page.screenshot({
    path: info.outputPath("favorites-list.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 320, height: 740 });
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("favorites-list-320.png"),
    fullPage: true,
  });

  const device = await browser.newContext({ baseURL: origin() });
  try {
    const session = token();
    await db.userSession.create({
      data: {
        id: digest(session),
        userId: current.viewer.user!.id,
        version: current.viewer.version,
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    await device.addCookies([
      { name: "party_user", value: session, url: origin() },
    ]);
    const remote = await device.newPage();
    await remote.goto(`/reservation/${first.id}`);
    await control(remote)
      .getByRole("button", { name: "取消收藏", exact: true })
      .click();
    await expect(
      control(remote).getByRole("button", { name: "收藏预约", exact: true }),
    ).toHaveAttribute("aria-pressed", "false");
    await page.reload();
    await expect(pagination).toContainText("共 1 场");
    await expect(pagination).toContainText("1 / 1");
    await expect(card(page, second.id)).toBeVisible();
    await page.getByRole("link", { name: "返回我的预约", exact: true }).click();
    await expect(page).toHaveURL(/\/my-reservations\?/);
    expect(query()).toEqual({ ...expected, tab: "joined" });
  } finally {
    await device.close();
  }
});

test("invitation favorites disappear after rotation and return after accepting a new invitation without becoming membership", async ({
  page,
  context,
}) => {
  const owner = await account(),
    visitor = await account();
  const r = await game(owner.token, { visibility: "INVITE" });
  let invitation = await currentInvitation(r.id, owner.token);
  await acceptInvitation(
    r.id,
    { token: invitation.path.split("#invite=")[1] },
    visitor.token,
  );
  await useAccount(context, visitor);
  await page.goto(`/reservation/${r.id}`);
  await control(page)
    .getByRole("button", { name: "收藏预约", exact: true })
    .click();
  await expect(
    control(page).getByRole("button", { name: "取消收藏", exact: true }),
  ).toBeEnabled();
  await page.goto("/my-reservations/favorites");
  await expect(card(page, r.id)).toBeVisible();
  await rotateInvitation(
    r.id,
    { expectedVersion: invitation.version },
    owner.token,
  );
  await page.reload();
  await expect(card(page, r.id)).toHaveCount(0);
  await expect(
    page.getByText("你还没有收藏预约", { exact: true }),
  ).toBeVisible();
  expect(
    await db.userReservationFavorite.count({
      where: { reservationId: r.id, userId: visitor.viewer.user!.id },
    }),
  ).toBe(1);
  await page.goto(`/reservation/${r.id}`);
  await expect(
    page.getByRole("heading", { name: r.gameName, exact: true }),
  ).toHaveCount(0);
  invitation = await currentInvitation(r.id, owner.token);
  await page.goto(invitation.path);
  await page
    .getByRole("button", { name: "接受邀请并查看", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: r.gameName, exact: true }),
  ).toBeVisible();
  await expect(
    control(page).getByRole("button", { name: "取消收藏", exact: true }),
  ).toBeEnabled();
  expect(
    await db.participant.count({
      where: { reservationId: r.id, tokenHash: digest(visitor.token) },
    }),
  ).toBe(0);
  await page.goto("/my-reservations/favorites");
  await expect(card(page, r.id)).toBeVisible();
});

test("guests are asked to sign in and signing out closes a private favorites page in another tab", async ({
  page,
  context,
}) => {
  const r = await game();
  await page.goto(`/reservation/${r.id}`);
  await expect(
    page.getByRole("link", { name: "收藏预约需注册并登录", exact: true }),
  ).toBeVisible();
  await expect(control(page)).toHaveCount(0);
  await page.goto("/my-reservations");
  await expect(
    page.getByRole("link", { name: "我的收藏", exact: true }),
  ).toHaveCount(0);
  await page.goto("/my-reservations/favorites");
  await expect(
    page.getByRole("link", { name: "登录账号", exact: true }),
  ).toBeVisible();
  const current = await account();
  await useAccount(context, current);
  await setFavorite(current.viewer, r.id, true);
  await page.goto("/my-reservations/favorites");
  await expect(card(page, r.id)).toBeVisible();
  const accountPage = await context.newPage();
  try {
    await accountPage.goto("/account");
    await accountPage
      .getByRole("button", { name: "退出账号，使用游客模式", exact: true })
      .click();
    await expect(
      page.getByRole("alert").filter({ hasText: "身份或登录状态已变化" }),
    ).toBeVisible();
    await expect(card(page, r.id)).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByRole("link", { name: "登录账号", exact: true }),
    ).toBeVisible();
    expect(
      await db.userReservationFavorite.count({
        where: { userId: current.viewer.user!.id },
      }),
    ).toBe(1);
  } finally {
    await accountPage.close();
  }
});

test("offline and lost favorite responses preserve controls and never replay writes automatically", async ({
  page,
  context,
}) => {
  const current = await account(),
    r = await game();
  await useAccount(context, current);
  await page.goto(`/reservation/${r.id}`);
  const section = control(page);
  let writes = 0,
    completedWrites = 0;
  await page.route(`**/api/reservations/${r.id}/favorite`, async (route) => {
    writes++;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    expect((await response.json()).data.saved).toBe(
      route.request().method() === "POST",
    );
    await route.abort("connectionfailed");
    completedWrites++;
  });
  await context.setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  await section.getByRole("button", { name: "收藏预约", exact: true }).click();
  await expect(section.getByRole("alert")).toContainText("离线");
  expect(writes).toBe(0);
  await context.setOffline(false);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
  await settle(page);
  expect(writes).toBe(0);
  await section.getByRole("button", { name: "收藏预约", exact: true }).click();
  // The offline warning has the same retry suffix. Wait for this specific
  // committed-and-dropped response before inspecting the warning or database.
  await expect.poll(() => completedWrites).toBe(1);
  await expect(section.getByRole("alert")).toContainText("网络连接中断");
  await expect(section.getByRole("alert")).toContainText("不会自动重发");
  expect(writes).toBe(1);
  expect(
    await db.userReservationFavorite.count({
      where: { userId: current.viewer.user!.id, reservationId: r.id },
    }),
  ).toBe(1);
  await expect(
    section.getByRole("button", { name: "收藏预约", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  // Wait beyond the refresh driver's one-second event deduplication window,
  // including any read still completing after the earlier reconnect.
  let lastReadAt = Date.now();
  page.on("response", (response) => {
    const request = response.request();
    if (
      request.headers().rsc === "1" &&
      !request.headers()["next-router-prefetch"] &&
      new URL(response.url()).pathname === `/reservation/${r.id}`
    )
      lastReadAt = Date.now();
  });
  await expect.poll(() => Date.now() - lastReadAt).toBeGreaterThan(1100);
  const backgroundRead = page.waitForResponse((response) => {
    const request = response.request();
    return (
      request.headers().rsc === "1" &&
      !request.headers()["next-router-prefetch"] &&
      new URL(response.url()).pathname === `/reservation/${r.id}`
    );
  });
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
  });
  expect((await backgroundRead).ok()).toBe(true);
  await expect(
    section.getByRole("button", { name: "取消收藏", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(section.getByRole("alert")).toContainText("不会自动重发");
  expect(writes).toBe(1);
  await section
    .getByRole("button", { name: "刷新核对收藏状态", exact: true })
    .click();
  await expect(
    section.getByRole("button", { name: "取消收藏", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(section.getByRole("alert")).toHaveCount(0);
  expect(writes).toBe(1);
  await section.getByRole("button", { name: "取消收藏", exact: true }).click();
  await expect.poll(() => completedWrites).toBe(2);
  await expect(section.getByRole("alert")).toContainText("网络连接中断");
  await expect(section.getByRole("alert")).toContainText("不会自动重发");
  expect(writes).toBe(2);
  expect(
    await db.userReservationFavorite.count({
      where: { userId: current.viewer.user!.id, reservationId: r.id },
    }),
  ).toBe(0);
  await expect(
    section.getByRole("button", { name: "取消收藏", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await section
    .getByRole("button", { name: "刷新核对收藏状态", exact: true })
    .click();
  await expect(
    section.getByRole("button", { name: "收藏预约", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  expect(writes).toBe(2);
});
