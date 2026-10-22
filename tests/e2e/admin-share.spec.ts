import "../support/isolated";
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { db } from "../../server/db";
import { ensureAdminRecord } from "../../server/admin";
import { ADMIN_COOKIE, createAdminSession } from "../../server/admin-auth";

test.afterAll(() => db.$disconnect());

test("admin copies all currently available games across pages, with a manual fallback and no stale copy on errors", async ({
  page,
  context,
  baseURL,
  browserName,
}, info) => {
  await ensureAdminRecord();
  const key = "copy_" + randomUUID().slice(0, 8);
  const admin = await db.adminCredential.create({
    data: { username: key, passwordHash: "unused", mustChangePassword: false },
  });
  const ids: string[] = [];
  try {
    const unauthorized = await context.request.get(
      "/api/admin/reservations/share",
    );
    expect(unauthorized.status()).toBe(401);
    expect(unauthorized.headers()["cache-control"]).toBe("no-store");
    for (let i = 0; i < 13; i++) {
      const row = await db.gameReservation.create({
        data: {
          gameName: `${key}-${i}`,
          hostName: "不复制的发起人",
          description: "不复制的备注",
          maxPlayers: 2,
          scheduledAt: new Date(Date.now() + (i + 1) * 3600000),
        },
      });
      ids.push(row.id);
    }
    await context.addCookies([
      {
        name: ADMIN_COOKIE,
        value: createAdminSession(admin.id, admin.sessionVersion),
        url: baseURL!,
      },
    ]);
    await page.goto(`/admin?q=${key}-0&pageSize=1`);
    // Change capacity after the page loads: the copy must use current server data.
    await db.participant.createMany({
      data: [0, 1].map((i) => ({
        reservationId: ids[0],
        name: String(i),
        nameKey: String(i),
        tokenHash: key + i,
      })),
    });
    if (browserName === "chromium")
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    else
      await page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: async (text: string) => {
              (window as unknown as { copied: string }).copied = text;
            },
          },
        });
      });
    await page
      .getByRole("button", { name: "复制可报名接龙", exact: true })
      .click();
    const copied = () =>
      page.evaluate(async () =>
        navigator.clipboard.readText
          ? navigator.clipboard.readText()
          : (window as unknown as { copied: string }).copied,
      );
    await expect.poll(copied).toContain(`${baseURL}/reservation/${ids[12]}`);
    const text = await copied();
    expect(text).not.toContain(`${baseURL}/reservation/${ids[0]}`);
    expect(text).toContain("0/2 人");
    expect(text).toContain("北京时间");
    expect(text).not.toContain("不复制的发起人");
    expect(text).not.toContain("不复制的备注");
    expect(
      text
        .split("\n")
        .filter((line) =>
          ids.some((id) => line === `${baseURL}/reservation/${id}`),
        ),
    ).toHaveLength(12);

    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async () => {
            throw new Error("blocked");
          },
        },
      });
      document.execCommand = () => false;
    });
    await page
      .getByRole("button", { name: "复制可报名接龙", exact: true })
      .click();
    const manual = page.getByLabel("接龙汇总（点击全选后复制）");
    await expect(manual).toHaveValue(new RegExp(ids[12]));
    const manualValue = await manual.inputValue();
    await manual.click();
    expect(
      await manual.evaluate(
        (node: HTMLTextAreaElement) => node.selectionEnd - node.selectionStart,
      ),
    ).toBe(manualValue.length);
    await page.setViewportSize({
      width: info.project.name === "desktop" ? 1440 : 320,
      height: 900,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath("admin-share-manual.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(manual).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath("admin-share.png"),
      fullPage: true,
    });

    await db.gameReservation.updateMany({
      where: { id: { in: ids } },
      data: { recruitmentPaused: true },
    });
    await page.route(
      "**/api/admin/reservations/share",
      (route) => route.fulfill({ json: { data: { items: [] } } }),
      { times: 1 },
    );
    await page
      .getByRole("button", { name: "复制可报名接龙", exact: true })
      .click();
    await expect(
      page.getByText("暂无未满员且未开始的可报名接龙", { exact: true }),
    ).toBeVisible();
    await expect(manual).toHaveCount(0);
    await db.adminCredential.update({
      where: { id: admin.id },
      data: { isActive: false },
    });
    const rejected = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/admin/reservations/share") && r.status() === 401,
    );
    await page
      .getByRole("button", { name: "复制可报名接龙", exact: true })
      .click();
    await rejected;
    await expect(manual).toHaveCount(0);
  } finally {
    await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
    await db.adminCredential.delete({ where: { id: admin.id } });
  }
});

test("a delayed share response is discarded after the administrator logs out", async ({
  page,
  context,
  baseURL,
}) => {
  await ensureAdminRecord();
  const admin = await db.adminCredential.create({
    data: {
      username: "delayed_" + randomUUID().slice(0, 8),
      passwordHash: "unused",
      mustChangePassword: false,
    },
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fetched = false;
  try {
    await context.addCookies([
      {
        name: ADMIN_COOKIE,
        value: createAdminSession(admin.id, admin.sessionVersion),
        url: baseURL!,
      },
    ]);
    await page.goto("/admin");
    await page.evaluate(() => {
      (window as unknown as { copies: number }).copies = 0;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async () => {
            (window as unknown as { copies: number }).copies++;
          },
        },
      });
    });
    await page.route("**/api/admin/reservations/share", async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      fetched = true;
      await held;
      await route.fulfill({
        response,
        json: {
          data: {
            items: [
              {
                gameName: "迟到的接龙",
                participantCount: 1,
                maxPlayers: 4,
                scheduledAt: "2099-01-01T12:00:00Z",
                visibility: "PUBLIC",
                path: "/reservation/delayed",
              },
            ],
          },
        },
      });
    });
    await page
      .getByRole("button", { name: "复制可报名接龙", exact: true })
      .click();
    await expect.poll(() => fetched).toBe(true);
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "管理员登录", exact: true }),
    ).toBeVisible();
    const response = page.waitForResponse((r) =>
      r.url().endsWith("/api/admin/reservations/share"),
    );
    release();
    await (await response).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(
      await page.evaluate(
        () => (window as unknown as { copies: number }).copies,
      ),
    ).toBe(0);
    await expect(page.getByLabel("接龙汇总（点击全选后复制）")).toHaveCount(0);
  } finally {
    release();
    await db.adminCredential.delete({ where: { id: admin.id } });
  }
});
