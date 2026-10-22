import "../support/isolated";
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { db } from "../../server/db";
import { browserCookie, registeredToken } from "../support/member";

async function expectNoOverflow(page: Page) {
  expect(
    await page.evaluate(() => {
      const width = document.documentElement.clientWidth;
      const controls = Array.from(
        document.querySelectorAll<HTMLElement>(
          "header a, .lobby input:not([type=hidden]), .lobby select, .lobby button, .lobby a",
        ),
      );
      return {
        page: document.documentElement.scrollWidth > width,
        outside: controls
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            return (
              rect.width > 0 &&
              (rect.left < -1 ||
                rect.right > width + 1 ||
                element.scrollWidth > element.clientWidth + 1)
            );
          })
          .map(
            (element) => element.textContent || element.getAttribute("name"),
          ),
      };
    }),
  ).toEqual({ page: false, outside: [] });
}

test.afterAll(() => db.$disconnect());

test("lobby keeps navigation, long titles and filters usable from mobile to desktop", async ({
  page,
  context,
  baseURL,
}, info) => {
  const marker = "lobby_" + randomUUID().slice(0, 8);
  const games = [
    "无畏契约 · 晚间五排",
    "双人成行 · 一起通关",
    "怪物猎人：荒野",
    "英雄联盟 · 周末开黑",
    "Minecraft 生存小队",
    "LongGameNameWithoutSpaces".repeat(3),
  ];
  const ids: string[] = [];
  try {
    for (const [i, gameName] of games.entries()) {
      const reservation = await db.gameReservation.create({
        data: {
          gameName,
          hostName: marker,
          maxPlayers: i === 1 ? 2 : 5,
          status: i === 4 ? "CANCELLED" : i === 5 ? "ENDED" : "OPEN",
          scheduledAt: new Date(Date.now() + (i + 1) * 3600000),
          participants: {
            create: Array.from({ length: i === 2 ? 5 : 1 }, (_, j) => ({
              name: `队友 ${j + 1}`,
              nameKey: `${marker}_${j}`,
              tokenHash: `${marker}_${j}`,
            })),
          },
        },
      });
      ids.push(reservation.id);
    }
    const widths =
      info.project.name === "desktop" ? [768, 1024, 1440] : [320, 390];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/?q=" + marker);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        "好队友，一起约。",
      );
      await expect(
        page
          .getByRole("region", { name: "筛选结果" })
          .getByRole("heading", { level: 3 }),
      ).toHaveCount(6);
      await expectNoOverflow(page);
      await page.screenshot({
        path: info.outputPath(`lobby-${width}.png`),
        fullPage: true,
      });
    }
    const filters = page.getByRole("search", { name: "筛选预约" });
    await filters
      .getByLabel("搜索预约", { exact: true })
      .fill("absent_" + marker);
    await filters.getByRole("button", { name: "筛选", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "没有符合条件的预约" }),
    ).toBeVisible();
    await expectNoOverflow(page);
    await page.getByRole("link", { name: "清除筛选", exact: true }).click();
    await expect(page).toHaveURL(baseURL + "/");
    await expect(filters.getByLabel("搜索预约", { exact: true })).toHaveValue(
      "",
    );
    await page.goto("/?q=" + marker);
    await page.getByRole("heading", { name: games[0], exact: true }).click();
    await expect(page).toHaveURL(baseURL + "/reservation/" + ids[0]);
    await page.goto("/");
    await page.getByRole("link", { name: "发起一场预约", exact: true }).click();
    await expect(page).toHaveURL(baseURL + "/reservation/new");

    const member = await registeredToken();
    await context.addCookies([{ ...browserCookie(member), url: baseURL! }]);
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto("/?q=" + marker);
    await expect(
      page
        .getByRole("navigation", { name: "主导航" })
        .getByRole("link", { name: "站内提醒", exact: true }),
    ).toBeVisible();
    await expectNoOverflow(page);
  } finally {
    await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
  }
});
