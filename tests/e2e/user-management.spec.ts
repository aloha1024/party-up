import "../support/isolated";
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { db } from "../../server/db";
import { createAdminSession } from "../../server/admin-auth";

test.afterAll(() => db.$disconnect());
test("a regular administrator can reset an ordinary user, requiring a new password before profile editing", async ({
  browser,
  context,
  page,
}) => {
  const name = "managed_" + randomUUID().slice(0, 8),
    password = "original-browser-password";
  const registered = await context.request.post("/api/user/register", {
    headers: { Origin: process.env.TEST_BASE_URL! },
    data: { username: name, nickname: "旧昵称", password },
  });
  expect(registered.ok()).toBeTruthy();
  const admin = await db.adminCredential.create({
    data: {
      username: "manager_" + randomUUID().slice(0, 8),
      passwordHash: "unused",
      mustChangePassword: false,
    },
  });
  const adminContext = await browser.newContext({
    baseURL: process.env.TEST_BASE_URL,
  });
  try {
    await adminContext.addCookies([
      {
        name: "party_admin",
        value: createAdminSession(admin.id, admin.sessionVersion),
        url: process.env.TEST_BASE_URL!,
      },
    ]);
    const manager = await adminContext.newPage();
    await manager.goto("/admin/users?q=" + name);
    await expect(manager.getByText("共 1 个普通账号")).toBeVisible();
    await manager
      .getByRole("button", { name: "重置密码", exact: true })
      .click();
    await manager.getByLabel("临时密码").fill("temporary-browser-password");
    manager.once("dialog", (d) => d.accept());
    await manager.getByRole("button", { name: "确认重置" }).click();
    await expect(
      manager.getByText("启用 · 需修改密码", { exact: true }),
    ).toBeVisible();
    await page.goto("/account/login");
    await page.getByLabel("用户名", { exact: true }).fill(name);
    await page
      .getByLabel("密码", { exact: true })
      .fill("temporary-browser-password");
    await page.getByRole("button", { name: "登录账号", exact: true }).click();
    await expect(page.locator("p[role=alert]")).toContainText("先设置正式密码");
    await page
      .getByLabel("当前密码", { exact: true })
      .fill("temporary-browser-password");
    await page.getByLabel("新密码", { exact: true }).fill(password + "new");
    await page.getByLabel("确认新密码", { exact: true }).fill(password + "new");
    await page.getByRole("button", { name: "修改密码并重新登录" }).click();
    await expect(page).toHaveURL(/account\/login$/);
    await page.getByLabel("用户名", { exact: true }).fill(name);
    await page.getByLabel("密码", { exact: true }).fill(password + "new");
    await page.getByRole("button", { name: "登录账号", exact: true }).click();
    await expect(page.getByRole("button", { name: "保存昵称" })).toBeVisible();
    await page.getByRole("textbox", { name: "默认昵称" }).fill("新昵称");
    await page.getByRole("button", { name: "保存昵称" }).click();
    await expect(
      page.getByText("默认昵称：新昵称", { exact: true }),
    ).toBeVisible();
  } finally {
    await adminContext.close();
    await db.adminAuditLog.deleteMany({ where: { actorId: admin.id } });
    await db.adminCredential.delete({ where: { id: admin.id } });
    await db.user.deleteMany({ where: { username: name } });
  }
});
