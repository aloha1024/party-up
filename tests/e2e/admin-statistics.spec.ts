import "../support/isolated";
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { db } from "../../server/db";
import { ensureAdminRecord } from "../../server/admin";
import { ADMIN_COOKIE, createAdminSession } from "../../server/admin-auth";
import { adminStatistics } from "../../server/admin-statistics";

test.afterAll(() => db.$disconnect());

test("regular administrators open the activity overview, change calendar ranges and see clearly scoped current metrics", async ({
  page,
  context,
  baseURL,
}, info) => {
  await ensureAdminRecord();
  const admin = await db.adminCredential.create({
    data: {
      username: "stats_" + randomUUID().slice(0, 8),
      passwordHash: "unused",
      mustChangePassword: false,
    },
  });
  try {
    await context.addCookies([
      {
        name: ADMIN_COOKIE,
        value: createAdminSession(admin.id, admin.sessionVersion),
        url: baseURL!,
      },
    ]);
    await page.goto("/admin");
    await page
      .getByRole("navigation", { name: "管理员导航" })
      .getByRole("link", { name: "活动概览", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "活动概览", exact: true }),
    ).toBeVisible();
    const ranges = page.getByRole("navigation", { name: "统计时间范围" });
    await expect(
      ranges.getByRole("link", { name: "近 30 天", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    const expected = await adminStatistics();
    await expect(
      page.getByRole("group", { name: "预约总数", exact: true }).locator("dd"),
    ).toHaveText(String(expected.reservations.total));
    const accounts = page.getByRole("region", { name: "全站当前账号概览" });
    await expect(accounts).toContainText("不受上方日期范围限制");
    await expect(
      accounts
        .getByRole("group", { name: "账号总数", exact: true })
        .locator("dd"),
    ).toHaveText(String(expected.accounts.total));
    await expect(
      page.getByRole("region", { name: "当前名单概览" }),
    ).toContainText("不是历史累计报名数");
    await expect(
      page.getByRole("region", { name: "当前名单概览" }),
    ).toContainText("不代表实际出勤率");
    await ranges.getByRole("link", { name: "今天", exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/statistics\?range=today$/);
    await expect(
      ranges.getByRole("link", { name: "今天", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      accounts
        .getByRole("group", { name: "账号总数", exact: true })
        .locator("dd"),
    ).toHaveText(String(expected.accounts.total));
    await ranges.getByRole("link", { name: "近 7 天", exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/statistics\?range=week$/);
    await page.getByRole("button", { name: "刷新数据", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "预约状态概览" }),
    ).toBeVisible();
    await page.screenshot({
      path: info.outputPath("admin-statistics.png"),
      fullPage: true,
    });
    await page.goto("/admin/statistics?range=today&range=week");
    await expect(
      page.getByRole("alert").filter({ hasText: "统计范围无效" }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "预约状态概览" }),
    ).toHaveCount(0);
    await page.getByRole("link", { name: "清除筛选", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "预约状态概览" }),
    ).toBeVisible();
    await db.adminCredential.update({
      where: { id: admin.id },
      data: { sessionVersion: { increment: 1 } },
    });
    await page.reload();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(
      page.getByRole("heading", { name: "管理员登录", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "预约状态概览" }),
    ).toHaveCount(0);
  } finally {
    await db.adminCredential.delete({ where: { id: admin.id } });
  }
});

test("unauthenticated browsers cannot open activity metrics", async ({
  page,
}) => {
  await page.goto("/admin/statistics");
  await expect(page).toHaveURL(/\/admin$/);
  await expect(
    page.getByRole("heading", { name: "管理员登录", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "预约状态概览" })).toHaveCount(
    0,
  );
});
