import "../support/isolated";
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { db } from "../../server/db";
import { ensureAdminRecord } from "../../server/admin";
import { ADMIN_COOKIE, createAdminSession } from "../../server/admin-auth";

async function expectContained(page: Page) {
  const overflow = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    return {
      page: document.documentElement.scrollWidth > width,
      controls: Array.from(
        document.querySelectorAll<HTMLElement>(
          ".admin-shell input:not([type=hidden]), .admin-shell select, .admin-shell button, .admin-shell a",
        ),
      )
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return (
            rect.width > 0 &&
            (rect.left < -1 ||
              rect.right > width + 1 ||
              element.scrollWidth > element.clientWidth + 1)
          );
        })
        .map((element) => element.textContent || element.getAttribute("name")),
    };
  });
  expect(overflow).toEqual({ page: false, controls: [] });
}

test.afterAll(() => db.$disconnect());

test("admin navigation, filters, long rows and account forms stay within the viewport", async ({
  page,
  context,
  baseURL,
}, info) => {
  const owner = await ensureAdminRecord();
  await db.adminCredential.update({
    where: { id: owner.id },
    data: { mustChangePassword: false },
  });
  const key = "layout_" + randomUUID().slice(0, 8);
  const username = key.padEnd(32, "x");
  const manager = await db.adminCredential.create({
    data: { username, passwordHash: "unused" },
  });
  const user = await db.user.create({
    data: {
      username,
      nickname: "LongNicknameWithoutGap",
      passwordHash: "unused",
    },
  });
  const rows = await Promise.all(
    [false, true].map((deleted) =>
      db.gameReservation.create({
        data: {
          gameName: key + "LongGameNameWithoutSpaces".repeat(2),
          hostName: "LongHostWithoutSpace",
          scheduledAt: new Date(Date.now() + 86400000),
          maxPlayers: 6,
          deletedAt: deleted ? new Date() : null,
        },
      }),
    ),
  );
  const audit = await db.adminAuditLog.create({
    data: {
      actorId: owner.id,
      actorName: username,
      action: "RESERVATION_TRASH",
      targetType: "reservation",
      targetId: rows[0].id,
      targetLabel: rows[0].gameName,
    },
  });
  try {
    await context.addCookies([
      {
        name: ADMIN_COOKIE,
        value: createAdminSession(owner.id, owner.sessionVersion),
        url: baseURL!,
      },
    ]);
    const widths =
      info.project.name === "desktop" ? [768, 1024, 1440] : [320, 390];
    const routes = [
      ["/admin?q=" + key, "预约管理"],
      ["/admin/trash?q=" + key, "回收站"],
      ["/admin/audit?q=" + key, "操作记录"],
      ["/admin/users?q=" + key, "普通账号"],
      ["/admin/accounts", "管理员账号"],
      ["/admin/password", "修改密码"],
      ["/admin/statistics", "活动概览"],
    ];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      for (const [url, label] of routes) {
        await page.goto(url);
        const nav = page.getByRole("navigation", { name: "管理员导航" });
        await expect(nav.getByRole("link")).toHaveCount(7);
        await expect(nav.locator('[aria-current="page"]')).toHaveText(label);
        if (label === "普通账号") {
          await page
            .getByRole("button", { name: "重置密码", exact: true })
            .click();
          await expect(
            page.getByRole("button", { name: "确认重置" }),
          ).toBeVisible();
        }
        if (label === "管理员账号") {
          await page
            .getByRole("button", { name: "重置密码", exact: true })
            .click();
          await expect(
            page.getByRole("button", { name: "确认重置" }),
          ).toBeVisible();
        }
        await expectContained(page);
        await page.screenshot({
          path: info.outputPath(`${label}-${width}.png`),
          fullPage: true,
        });
      }
    }
  } finally {
    await db.adminAuditLog.delete({ where: { id: audit.id } });
    await db.gameReservation.deleteMany({
      where: { id: { in: rows.map((r) => r.id) } },
    });
    await db.user.delete({ where: { id: user.id } });
    await db.adminCredential.delete({ where: { id: manager.id } });
    await db.adminCredential.update({
      where: { id: owner.id },
      data: { mustChangePassword: owner.mustChangePassword },
    });
  }
});

test("admin filters, pagination, edit, trash and restore keep working on narrow screens", async ({
  page,
  context,
  baseURL,
}) => {
  await ensureAdminRecord();
  const key = "flow_" + randomUUID().slice(0, 8);
  const admin = await db.adminCredential.create({
    data: { username: key, passwordHash: "unused", mustChangePassword: false },
  });
  const scheduledAt = new Date(Date.now() + 2 * 86400000);
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(scheduledAt);
  const rows = await Promise.all(
    Array.from({ length: 13 }, (_, i) =>
      db.gameReservation.create({
        data: {
          gameName: `${key}-${i}`,
          hostName: "布局测试发起人",
          scheduledAt,
          maxPlayers: 6,
        },
      }),
    ),
  );
  try {
    await context.addCookies([
      {
        name: ADMIN_COOKIE,
        value: createAdminSession(admin.id, admin.sessionVersion),
        url: baseURL!,
      },
    ]);
    await page.goto("/admin");
    await expect(
      page
        .getByRole("navigation", { name: "管理员导航" })
        .getByRole("link", { name: "管理员账号" }),
    ).toHaveCount(0);
    const filters = page.getByRole("search", { name: "筛选预约" });
    await filters.getByLabel("搜索预约").fill(key);
    await filters.getByLabel("预约状态").selectOption("upcoming");
    await filters.getByLabel("开玩日期（北京时间）").fill(date);
    await filters.getByRole("button", { name: "筛选", exact: true }).click();
    const pagination = page.getByRole("navigation", { name: "预约分页" });
    await expect(pagination).toContainText("共 13 场");
    await expectContained(page);
    await pagination.getByRole("link", { name: "下一页" }).click();
    await expect(pagination).toContainText("显示 13–13 场");
    expect(new URL(page.url()).searchParams.get("date")).toBe(date);
    expect(new URL(page.url()).searchParams.get("view")).toBe("upcoming");
    const edit = page.getByRole("link", { name: "编辑预约", exact: true });
    const editUrl = (await edit.getAttribute("href"))!;
    const id = editUrl.split("/")[2];
    const listingUrl = page.url();
    await edit.click();
    await expect(page.getByLabel("游戏名称", { exact: true })).toHaveValue(
      rows.find((r) => r.id === id)!.gameName,
    );
    await page.goto(listingUrl);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "移入回收站", exact: true }).click();
    await expect(pagination).toContainText("共 12 场");
    await page
      .getByRole("navigation", { name: "管理员导航" })
      .getByRole("link", { name: "回收站", exact: true })
      .click();
    const trash = page.getByRole("search", { name: "筛选回收站" });
    await trash.getByLabel("搜索已删除预约").fill(key);
    await trash.getByRole("button", { name: "筛选", exact: true }).click();
    await expect(
      page.getByRole("navigation", { name: "回收站分页" }),
    ).toContainText("共 1 场");
    await expectContained(page);
    await page.getByRole("button", { name: "恢复预约" }).click();
    await expect(
      page.getByRole("navigation", { name: "回收站分页" }),
    ).toContainText("共 0 场");
    await expect
      .poll(() =>
        db.gameReservation.findUnique({
          where: { id },
          select: { deletedAt: true },
        }),
      )
      .toEqual({ deletedAt: null });
    await page.goto("/admin?q=" + key);
    await page
      .getByRole("search", { name: "筛选预约" })
      .getByRole("link", { name: "重置" })
      .click();
    await expect(page).toHaveURL(baseURL + "/admin");
    await expect(page.getByRole("search").getByLabel("搜索预约")).toHaveValue(
      "",
    );
  } finally {
    await db.adminAuditLog.deleteMany({ where: { actorId: admin.id } });
    await db.gameReservation.deleteMany({
      where: { id: { in: rows.map((r) => r.id) } },
    });
    await db.adminCredential.delete({ where: { id: admin.id } });
  }
});
