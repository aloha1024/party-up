import "../support/isolated";
import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { db } from "../../server/db";
import {
  createReservation,
  joinReservation,
  joinWaitlist,
  detail,
  hashToken,
} from "../../server/reservations";
import { ADMIN_COOKIE, createAdminSession } from "../../server/admin-auth";
const token = () => randomBytes(32).toString("hex");
const input = () => ({
  gameName: "报名管理" + token().slice(0, 6),
  hostName: "Host",
  description: "",
  maxPlayers: 2,
  scheduledAt: new Date(Date.now() + 86400000).toISOString(),
});
test.afterAll(async () => {
  await db.$disconnect();
});

test("host and roster members rename; removing a participant promotes waitlist and private reasons stay private", async ({
  page,
  context,
  browser,
}, info) => {
  test.setTimeout(90000);
  const owner = token(),
    guest = token(),
    waiter = token();
  const r = await createReservation(input(), owner);
  const guestContext = await browser.newContext();
  const guestPage = await guestContext.newPage();
  try {
    await joinReservation(r.id, { name: "Guest" }, guest);
    await joinWaitlist(r.id, { name: "Waiter" }, waiter);
    await context.addCookies([
      { name: "party_identity", value: owner, url: process.env.TEST_BASE_URL! },
    ]);
    await guestContext.addCookies([
      { name: "party_identity", value: guest, url: process.env.TEST_BASE_URL! },
    ]);
    await page.goto(`/reservation/${r.id}`);
    await page.getByRole("button", { name: "修改昵称", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "修改昵称", exact: true });
    await dialog.getByLabel("新昵称").fill("NewHost");
    await dialog.getByRole("button", { name: "保存昵称", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "变更记录", exact: true }),
    ).toContainText("发起人昵称：已修改");
    await guestPage.goto(`${process.env.TEST_BASE_URL}/reservation/${r.id}`);
    await guestPage
      .getByRole("button", { name: "修改昵称", exact: true })
      .click();
    const guestDialog = guestPage.getByRole("dialog");
    await guestDialog.getByLabel("新昵称").fill("NewGuest");
    await guestContext.setOffline(true);
    await guestDialog.getByRole("button", { name: "保存昵称" }).click();
    await expect(guestDialog.getByRole("alert")).toContainText("离线");
    await expect(guestDialog.getByLabel("新昵称")).toHaveValue("NewGuest");
    await guestContext.setOffline(false);
    await guestDialog.getByRole("button", { name: "保存昵称" }).click();
    await expect(guestDialog).toHaveCount(0);
    await expect(
      guestPage.locator("li").filter({ hasText: "NewGuest" }),
    ).toBeVisible();
    await page.reload();
    await page
      .locator("li")
      .filter({ has: page.getByText("NewGuest", { exact: true }) })
      .getByRole("button", { name: "移除", exact: true })
      .click();
    const removeDialog = page.getByRole("dialog", {
      name: "移除报名",
      exact: true,
    });
    await removeDialog.getByLabel("移除原因").fill("只向相关人员展示的原因");
    await page.screenshot({
      path: info.outputPath("remove-dialog.png"),
      fullPage: true,
    });
    page.once("dialog", (prompt) => prompt.accept());
    await removeDialog
      .getByRole("button", { name: "确认移除", exact: true })
      .click();
    await expect(removeDialog).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "报名移除记录", exact: true }),
    ).toContainText("只向相关人员展示的原因");
    await expect(
      page.getByRole("region", { name: "候补名单", exact: true }),
    ).toHaveCount(0);
    await expect(
      guestPage.getByRole("region", { name: "报名移除记录", exact: true }),
    ).toContainText("只向相关人员展示的原因", { timeout: 22000 });
    await expect(
      guestPage.getByRole("region", { name: "变更记录", exact: true }),
    ).not.toContainText("只向相关人员展示的原因");
    await guestPage.getByLabel("你的昵称").fill("GuestAgain");
    await guestPage
      .getByRole("button", { name: "加入候补", exact: true })
      .click();
    await expect(
      guestPage.getByText("你在候补第 1 位", { exact: true }),
    ).toBeVisible();
    await guestPage
      .getByRole("button", { name: "修改昵称", exact: true })
      .click();
    await guestPage
      .getByRole("dialog")
      .getByLabel("新昵称")
      .fill("QueuedGuest");
    await guestPage
      .getByRole("dialog")
      .getByRole("button", { name: "保存昵称", exact: true })
      .click();
    await expect(guestPage.getByRole("dialog")).toHaveCount(0);
    await expect(
      guestPage.getByRole("region", { name: "候补名单", exact: true }),
    ).toContainText("QueuedGuest");
    await guestContext.clearCookies();
    await guestPage.reload();
    await expect(
      guestPage.getByRole("region", { name: "报名移除记录", exact: true }),
    ).toHaveCount(0);
    await expect(
      guestPage.getByRole("button", { name: "移除", exact: true }),
    ).toHaveCount(0);
    await expect(
      guestPage.getByRole("button", { name: "修改昵称", exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath("roster-management.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await guestContext.close();
    await db.gameReservation.delete({ where: { id: r.id } });
  }
});

test("private pages catch refresh gaps and revoked admin access clears previously loaded records", async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  const owner = token(),
    viewer = token(),
    adminId = 1000002;
  const r = await createReservation(input(), owner);
  try {
    const root = await db.adminCredential.findUniqueOrThrow({
      where: { id: 1 },
    });
    await db.adminCredential.create({
      data: {
        id: adminId,
        username: "roster-e2e-admin",
        passwordHash: root.passwordHash,
        mustChangePassword: false,
      },
    });
    const add = (start: number, count: number) =>
      db.rosterRemoval.createMany({
        data: Array.from({ length: count }, (_, i) => ({
          reservationId: r.id,
          kind: "participants",
          entryId: `fixture-${start + i}`,
          targetTokenHash: hashToken(token()),
          targetName: `Member${start + i}`,
          reason: "私密分页记录",
          actorRole: "HOST",
        })),
      });
    await add(0, 25);
    await context.addCookies([
      {
        name: "party_identity",
        value: viewer,
        url: process.env.TEST_BASE_URL!,
      },
      {
        name: ADMIN_COOKIE,
        value: createAdminSession(adminId, 0),
        url: process.env.TEST_BASE_URL!,
      },
    ]);
    await page.goto(`/reservation/${r.id}`);
    const region = page.getByRole("region", {
      name: "报名移除记录",
      exact: true,
    });
    const entries = region.locator("[data-removal-id]");
    await expect(entries).toHaveCount(10);
    await context.setOffline(true);
    await region
      .getByRole("button", { name: "加载更早移除记录", exact: true })
      .click();
    await expect(region.getByRole("alert")).toBeVisible();
    await expect(entries).toHaveCount(10);
    await context.setOffline(false);
    await region
      .getByRole("button", { name: "重试加载移除记录", exact: true })
      .click();
    await expect(entries).toHaveCount(20);
    await page.getByLabel("你的昵称").fill("KeepNickname");
    await add(25, 23);
    await expect(entries).toHaveCount(43, { timeout: 22000 });
    await expect(page.getByLabel("你的昵称")).toHaveValue("KeepNickname");
    await db.adminCredential.update({
      where: { id: adminId },
      data: { isActive: false },
    });
    await region
      .getByRole("button", { name: "加载更早移除记录", exact: true })
      .click();
    await expect(region).toHaveCount(0);
    await expect(page.getByLabel("你的昵称")).toHaveValue("KeepNickname");
  } finally {
    await context.setOffline(false);
    await db.gameReservation.delete({ where: { id: r.id } });
    await db.adminCredential.deleteMany({ where: { id: adminId } });
  }
});

test("a lost removal response keeps the reason and retry cannot remove a rejoined participant", async ({
  page,
  context,
}) => {
  const owner = token(),
    guest = token();
  const r = await createReservation(input(), owner);
  try {
    await joinReservation(r.id, { name: "Guest" }, guest);
    await context.addCookies([
      { name: "party_identity", value: owner, url: process.env.TEST_BASE_URL! },
    ]);
    await page.goto(`/reservation/${r.id}`);
    await page.getByRole("button", { name: "移除", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("移除原因").fill("响应丢失测试");
    await page.route(
      "**/roster-removals",
      async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        await route.fetch();
        await route.abort("connectionfailed");
      },
      { times: 1 },
    );
    page.once("dialog", (prompt) => prompt.accept());
    await dialog.getByRole("button", { name: "确认移除" }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(dialog.getByLabel("移除原因")).toHaveValue("响应丢失测试");
    await joinReservation(r.id, { name: "GuestAgain" }, guest);
    page.once("dialog", (prompt) => prompt.accept());
    await dialog.getByRole("button", { name: "确认移除" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("GuestAgain", { exact: true })).toBeVisible();
    expect((await detail(r.id, guest)).participants.some((p) => p.isMe)).toBe(
      true,
    );
    expect(
      await db.rosterRemoval.count({ where: { reservationId: r.id } }),
    ).toBe(1);
  } finally {
    await db.gameReservation.delete({ where: { id: r.id } });
  }
});
