import "../support/isolated";
import { test, expect } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../../server/db";
import { digest } from "../../server/user-identity";
import { registeredToken, browserCookie } from "../support/member";
import {
  createReservation,
  joinReservation,
  joinWaitlist,
  leaveReservation,
} from "../../server/reservations";
import { setAttendance } from "../../server/reservation-attendance";
const token = () => randomBytes(32).toString("hex");
test.afterAll(async () => {
  await db.$disconnect();
});

test("schedule merges roles across pages and restores list filters and browser history", async ({
  page,
  context,
  baseURL,
}, info) => {
  const owner = token(),
    prefix = randomUUID(),
    ids: string[] = [];
  const at = new Date(Date.now() + 3600000);
  try {
    for (let i = 0; i < 15; i++) {
      const id = prefix + String(i).padStart(2, "0");
      ids.push(id);
      await db.gameReservation.create({
        data: {
          id,
          gameName: `${prefix}-${i}`,
          hostName: "队长",
          hostTokenHash: digest(owner),
          scheduledAt: at,
          maxPlayers: 3,
          status: i === 13 ? "CANCELLED" : i === 14 ? "ENDED" : "OPEN",
          participants: {
            create: { name: "队长", nameKey: "队长", tokenHash: digest(owner) },
          },
        },
      });
    }
    await context.addCookies([
      { name: "party_identity", value: owner, url: baseURL! },
    ]);
    await page.goto(
      `/my-reservations?tab=hosted&q=${prefix}&page=2&pageSize=1`,
    );
    await expect(
      page.getByRole("heading", { name: `${prefix}-1`, exact: true }),
    ).toBeVisible();
    await page
      .getByRole("navigation", { name: "我的预约视图" })
      .getByRole("link", { name: "日程", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "我的日程." }),
    ).toBeVisible();
    await expect(page.locator("[data-schedule-id]")).toHaveCount(12);
    await expect(
      page.getByText("同期开局，请核对安排", { exact: true }),
    ).toHaveCount(12);
    await expect(page.locator("[data-schedule-id]").first()).toContainText(
      "我发起的 · 我参加的",
    );
    await page
      .getByRole("navigation", { name: "日程分页" })
      .getByRole("link", { name: "下一页" })
      .click();
    await expect(page).toHaveURL(/schedulePage=2/);
    await expect(page.locator("[data-schedule-id]")).toHaveCount(3);
    await expect(
      page.getByText("同期开局，请核对安排", { exact: true }),
    ).toHaveCount(1);
    await expect(page.getByText("到场确认已锁定", { exact: true })).toHaveCount(
      2,
    );
    await expect(
      page.getByRole("complementary", { name: "最近开局" }),
    ).toContainText(`${prefix}-0`);
    await page.reload();
    await expect(page.locator("[data-schedule-id]")).toHaveCount(3);
    await page
      .getByRole("navigation", { name: "我的预约视图" })
      .getByRole("link", { name: "列表", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: `${prefix}-1`, exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("搜索预约", { exact: true })).toHaveValue(
      prefix,
    );
    await page.goBack();
    await expect(page.locator("[data-schedule-id]")).toHaveCount(3);
    await page.getByRole("link", { name: "今天", exact: true }).click();
    await expect(page).toHaveURL(/range=today/);
    expect(new URL(page.url()).searchParams.get("schedulePage")).toBeNull();
    await page.getByRole("link", { name: "未来 7 天", exact: true }).click();
    await expect(page).toHaveURL(/range=week/);
    await expect(page.locator("[data-schedule-id]")).toHaveCount(12);
    await page.setViewportSize({ width: 320, height: 740 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath("schedule.png"),
      fullPage: true,
    });
    await page.locator("[data-schedule-id]").first().getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/reservation/${ids[0]}$`));
  } finally {
    await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
  }
});

test("schedule updates promotion and attendance on refresh and wakes when confirmation opens", async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(60000);
  await page.addInitScript(() => {
    const schedule = window.setTimeout.bind(window);
    (window as any).scheduleRefreshReady = false;
    window.setTimeout = ((
      handler: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay && delay >= 13500 && delay <= 15000)
        (window as any).scheduleRefreshReady = true;
      return schedule(handler, delay, ...args);
    }) as typeof window.setTimeout;
  });
  const host = token(),
    joined = token(),
    waiting = token();
  const game = await createReservation(
    {
      gameName: "日程递补",
      hostName: "队长",
      scheduledAt: new Date(Date.now() + 31 * 60000).toISOString(),
      maxPlayers: 2,
    },
    host,
  );
  try {
    await joinReservation(game.id, { name: "正式队友" }, joined);
    await joinWaitlist(game.id, { name: "候补队友" }, waiting);
    await context.addCookies([
      { name: "party_identity", value: waiting, url: baseURL! },
    ]);
    await page.goto("/my-reservations?layout=schedule");
    const card = page.locator(`[data-schedule-id="${game.id}"]`);
    await expect(card).toContainText("我候补的（尚未正式参加）");
    await expect(card.locator("[data-attendance]")).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => (window as any).scheduleRefreshReady))
      .toBe(true);
    await leaveReservation(game.id, joined);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(card).toContainText("我参加的");
    await expect(card).not.toContainText("尚未正式参加");
    await expect(card.locator('[data-attendance="waiting"]')).toBeVisible();
    // Start the short opening window only after slow CI setup and promotion
    // have finished. Reload reads the fixture's new boundary before waiting.
    await db.gameReservation.update({
      where: { id: game.id },
      data: { scheduledAt: new Date(Date.now() + 30 * 60000 + 8000) },
    });
    await page.reload();
    await expect(card.locator('[data-attendance="ready"]')).toBeVisible({
      timeout: 20000,
    });
    const entry = await db.participant.findFirstOrThrow({
      where: { reservationId: game.id, tokenHash: digest(waiting) },
    });
    const current = await db.gameReservation.findUniqueOrThrow({
      where: { id: game.id },
    });
    await context.setOffline(true);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    const disconnectedAt = Date.now();
    await setAttendance(
      game.id,
      {
        participantId: entry.id,
        checkedIn: true,
        attendanceVersion: entry.attendanceVersion,
        editVersion: current.editVersion,
      },
      waiting,
    );
    await expect(card).toContainText("我参加的");
    // Reconnecting within one second of the opening refresh is intentionally
    // deduplicated. Keep this recovery scenario outside that event window.
    await expect.poll(() => Date.now() - disconnectedAt).toBeGreaterThan(1000);
    await context.setOffline(false);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
    await expect(card.locator('[data-attendance="confirmed"]')).toBeVisible();
    await card.getByRole("link").click();
    await expect(
      page.getByRole("button", { name: "撤销到场确认" }),
    ).toBeVisible();
  } finally {
    await db.gameReservation.delete({ where: { id: game.id } });
  }
});

test("schedule does not create guest identity and account sessions can see invited membership", async ({
  page,
  context,
  baseURL,
  browser,
}) => {
  await page.goto("/my-reservations?layout=schedule");
  await expect(
    page.getByText("暂无当前浏览器的预约记录", { exact: true }),
  ).toBeVisible();
  expect(
    (await context.cookies()).some((c) => c.name === "party_identity"),
  ).toBe(false);
  const member = await registeredToken();
  const game = await createReservation(
    {
      gameName: "账号邀请日程",
      hostName: "账号队长",
      scheduledAt: new Date(Date.now() + 3600000).toISOString(),
      maxPlayers: 3,
      visibility: "INVITE",
    },
    member,
  );
  const secondContext = await browser.newContext();
  try {
    await context.addCookies([{ ...browserCookie(member), url: baseURL! }]);
    await page.reload();
    await expect(page.locator(`[data-schedule-id="${game.id}"]`)).toBeVisible();
    await secondContext.addCookies([
      { ...browserCookie(member), url: baseURL! },
    ]);
    const second = await secondContext.newPage();
    await second.goto(baseURL + "/my-reservations?layout=schedule");
    await expect(
      second.locator(`[data-schedule-id="${game.id}"]`),
    ).toBeVisible();
    await context.clearCookies();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.locator(`[data-schedule-id="${game.id}"]`)).toHaveCount(
      0,
    );
  } finally {
    await secondContext.close();
    await db.gameReservation.delete({ where: { id: game.id } });
  }
});
