import "../support/isolated";
import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { db } from "../../server/db";
import {
  createReservation,
  joinReservation,
  joinWaitlist,
  leaveWaitlist,
  leaveReservation,
  editReservation,
  cancelReservation,
} from "../../server/reservations";
const token = () => randomBytes(32).toString("hex");
test.afterAll(async () => {
  await db.$disconnect();
});

test("waitlist position refreshes, personal membership moves after automatic promotion, offline exit can be confirmed", async ({
  page,
  context,
}, info) => {
  test.setTimeout(90000);
  const host = token(),
    guest = token(),
    earlier = token();
  const input = {
    gameName: "候补浏览器" + token().slice(0, 8),
    hostName: "队长",
    maxPlayers: 2,
    scheduledAt: new Date(Date.now() + 86400000).toISOString(),
    description: "",
  };
  const r = await createReservation(input, host);
  try {
    await joinReservation(r.id, { name: "正式队友" }, guest);
    await joinWaitlist(r.id, { name: "先到队友" }, earlier);
    await page.goto(`/reservation/${r.id}`);
    await page.getByLabel("你的昵称").fill("候补队友");
    await expect(
      page.getByText(
        "有空位时将按顺序自动转为正式报名。候补不是正式报名，不发送外部通知。",
      ),
    ).toBeVisible();
    await page.getByRole("button", { name: "加入候补", exact: true }).click();
    await expect(
      page.getByText("你在候补第 2 位", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: info.outputPath("waitlist.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("link", { name: "我的预约", exact: true }).click();
    await page.getByRole("link", { name: "我候补的", exact: true }).click();
    await expect(page).toHaveURL(/tab=waiting/);
    await page
      .getByRole("heading", { name: input.gameName, exact: true })
      .click();
    await leaveWaitlist(r.id, earlier);
    // Observe automatic detail refresh, not a manual reload.
    await expect(
      page.getByText("你在候补第 1 位", { exact: true }),
    ).toBeVisible({ timeout: 22000 });
    await leaveReservation(r.id, guest);
    await expect(
      page.getByText("你已在接龙名单中", { exact: true }),
    ).toBeVisible({ timeout: 22000 });
    await page.goto("/my-reservations?tab=waiting");
    await expect(
      page.getByText("你还没有候补预约", { exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "我参加的", exact: true }).click();
    await page
      .getByRole("heading", { name: input.gameName, exact: true })
      .click();
    await page.getByRole("button", { name: "退出接龙", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "加入接龙", exact: true }),
    ).toBeVisible();
    await joinReservation(r.id, { name: "正式队友" }, guest);
    await page.reload();
    await page.getByLabel("你的昵称").fill("候补队友");
    await page.getByRole("button", { name: "加入候补", exact: true }).click();
    await expect(
      page.getByText("你在候补第 1 位", { exact: true }),
    ).toBeVisible();
    await context.setOffline(true);
    await page.getByRole("button", { name: "退出候补", exact: true }).click();
    await expect(page.locator('aside [role="alert"]')).toBeVisible();
    await context.setOffline(false);
    await page.reload();
    await expect(
      page.getByText("你在候补第 1 位", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "退出候补", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "加入候补", exact: true }),
    ).toBeVisible();
  } finally {
    await context.setOffline(false);
    await db.gameReservation.delete({ where: { id: r.id } });
  }
});

test("expansion promotes queue and cancelled or started waiters can leave", async ({
  page,
  context,
}) => {
  const host = token(),
    guest = token(),
    waiter = token();
  const input = {
    gameName: "扩容候补" + token().slice(0, 8),
    hostName: "队长",
    maxPlayers: 2,
    scheduledAt: new Date(Date.now() + 86400000).toISOString(),
    description: "",
  };
  const r = await createReservation(input, host);
  try {
    await joinReservation(r.id, { name: "正式队友" }, guest);
    await joinWaitlist(r.id, { name: "候补队友" }, waiter);
    await context.addCookies([
      {
        name: "party_identity",
        value: waiter,
        url: process.env.TEST_BASE_URL!,
      },
    ]);
    await page.goto(`/reservation/${r.id}`);
    await editReservation(
      r.id,
      { ...input, maxPlayers: 3, editVersion: 0 },
      host,
    );
    await page.reload();
    await expect(
      page.getByText("你已在接龙名单中", { exact: true }),
    ).toBeVisible();
    await leaveReservation(r.id, waiter);
    await editReservation(r.id, { ...input, editVersion: 1 }, host);
    await joinWaitlist(r.id, { name: "候补队友" }, waiter);
    await db.gameReservation.update({
      where: { id: r.id },
      data: { scheduledAt: new Date(0) },
    });
    await page.reload();
    await expect(
      page.getByRole("status").filter({ hasText: "未递补" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "退出候补", exact: true }).click();
    await expect(page.getByRole("region", { name: "候补名单" })).toHaveCount(0);
    await db.gameReservation.update({
      where: { id: r.id },
      data: { scheduledAt: new Date(input.scheduledAt) },
    });
    await joinWaitlist(r.id, { name: "候补队友" }, waiter);
    await cancelReservation(r.id, { reason: "下次再约" }, host);
    await page.reload();
    await expect(
      page.getByRole("button", { name: "退出候补", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "退出候补", exact: true }).click();
    await expect(page.getByRole("region", { name: "候补名单" })).toHaveCount(0);
  } finally {
    await db.gameReservation.delete({ where: { id: r.id } });
  }
});
