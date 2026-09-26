import "../support/isolated";
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { db } from "../../server/db";
import { createAdminSession, ADMIN_COOKIE } from "../../server/admin-auth";

test.afterAll(async () => {
  await db.$disconnect();
});

for (const path of ["/", "/my-reservations", "/admin"]) {
  test(`available filter on ${path} preserves URLs and refreshes after a seat fills or opens`, async ({
    page,
    context,
    request,
  }, info) => {
    const origin = process.env.TEST_BASE_URL!;
    let adminId: number | undefined;
    const ids: string[] = [];
    try {
      if (path === "/admin") {
        const admin = await db.adminCredential.create({
          data: {
            id: 1000000,
            username: "available-" + randomUUID(),
            passwordHash: "unused",
            mustChangePassword: false,
          },
        });
        adminId = admin.id;
        await context.addCookies([
          {
            name: ADMIN_COOKIE,
            value: createAdminSession(admin.id, admin.sessionVersion),
            url: origin,
          },
        ]);
      }
      await context.request.post("/api/identity", {
        headers: { Origin: origin },
      });
      await request.post("/api/identity", { headers: { Origin: origin } });
      const q = "Seats-" + randomUUID();
      for (let i = 0; i < 3; i++) {
        const response = await context.request.post("/api/reservations", {
          headers: { Origin: origin, "Idempotency-Key": randomUUID() },
          data: {
            gameName: `${q}-${i}`,
            hostName: "队长",
            maxPlayers: 2,
            scheduledAt: new Date(
              Date.now() + (i + 1) * 86400000,
            ).toISOString(),
          },
        });
        expect(response.ok()).toBe(true);
        ids.push((await response.json()).data.id);
      }
      const join = async (id: string) => {
        const response = await request.post(
          `/api/reservations/${id}/participants`,
          { headers: { Origin: origin }, data: { name: "队友" } },
        );
        expect(response.ok()).toBe(true);
      };
      await join(ids[1]);
      await page.goto(`${path}?q=${q}&pageSize=1`);
      await page
        .getByRole("combobox", { name: "预约状态", exact: true })
        .selectOption("available");
      await page.getByRole("button", { name: "筛选", exact: true }).click();
      await expect(page).toHaveURL(/view=available/);
      const card = (i: number) =>
        page.getByRole("link").filter({ hasText: `${q}-${i}` });
      await expect(card(0)).toBeVisible();
      await expect(
        page.getByText("还可报名 1 人", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("空位以提交时为准", { exact: true }),
      ).toBeVisible();
      await page.getByRole("link", { name: "下一页", exact: true }).click();
      await expect(card(2)).toBeVisible();
      await expect(page).toHaveURL(/view=available.*page=2/);
      if (path === "/my-reservations") {
        await page.getByRole("link", { name: "我发起的", exact: true }).click();
        await expect(page).toHaveURL(/tab=hosted.*view=available/);
        await expect(card(0)).toBeVisible();
        await page.getByRole("link", { name: "下一页", exact: true }).click();
        await expect(card(2)).toBeVisible();
      }
      await page.screenshot({
        path: info.outputPath("available.png"),
        fullPage: true,
      });
      const clockNow = new Date();
      await page.clock.install({ time: clockNow });
      await page.reload();
      await expect(card(2)).toBeVisible();
      await page.clock.pauseAt(new Date(clockNow.getTime() + 2000));
      await join(ids[2]);
      await page.clock.runFor(15000);
      await expect(card(2)).toHaveCount(0);
      await expect(card(0)).toBeVisible();
      await expect(
        page.getByRole("navigation", { name: "预约分页" }),
      ).toContainText("1 / 1");
      const left = await request.delete(
        `/api/reservations/${ids[2]}/participants`,
        { headers: { Origin: origin } },
      );
      expect(left.ok()).toBe(true);
      await page.clock.runFor(15000);
      await expect(card(2)).toBeVisible();
      await page.clock.resume();
    } finally {
      await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
      if (adminId) await db.adminCredential.delete({ where: { id: adminId } });
    }
  });
}
