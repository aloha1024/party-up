import "../support/isolated";
import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { db } from "../../server/db";
import {
  createReservation,
  joinReservation,
  joinWaitlist,
  leaveReservation,
  editReservation,
  cancelReservation,
} from "../../server/reservations";
const token = () => randomBytes(32).toString("hex");
test.afterAll(async () => {
  await db.$disconnect();
});

test("formal participant downloads latest calendar data without roster or credentials, and offline errors keep the page", async ({
  page,
  context,
}, info) => {
  const owner = token();
  const input = {
    gameName: "日历测试" + token().slice(0, 6),
    hostName: "队长",
    maxPlayers: 3,
    scheduledAt: new Date(Date.now() + 86400000).toISOString(),
    description: "日历备注",
  };
  const r = await createReservation(input, owner);
  try {
    await context.addCookies([
      { name: "party_identity", value: owner, url: process.env.TEST_BASE_URL! },
    ]);
    await page.goto(`/reservation/${r.id}`);
    await expect(
      page.getByRole("button", { name: "添加到日历", exact: true }),
    ).toBeVisible();
    await context.setOffline(true);
    await page.getByRole("button", { name: "添加到日历", exact: true }).click();
    await expect(page.locator('aside [role="alert"]')).toBeVisible();
    await expect(
      page.getByRole("link", { name: "下载日历文件", exact: true }),
    ).toHaveCount(0);
    await context.setOffline(false);
    await page.reload();
    await editReservation(
      r.id,
      { ...input, description: "最新日历备注", editVersion: 0 },
      owner,
    );
    await page.getByRole("button", { name: "添加到日历", exact: true }).click();
    const link = page.getByRole("link", { name: "下载日历文件", exact: true });
    await expect(link).toBeVisible();
    const downloading = page.waitForEvent("download");
    await link.click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe(`party-up-${r.id}.ics`);
    const stream = await download.createReadStream();
    expect(stream).not.toBeNull();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    const file = Buffer.concat(chunks).toString("utf8").replace(/\r\n /g, "");
    expect(file).toContain("BEGIN:VCALENDAR");
    expect(file).toContain("最新日历备注");
    expect(file).toContain("TRIGGER:-PT15M");
    expect(file).toContain(`/reservation/${r.id}`);
    expect(file).not.toContain(owner);
    expect(file).not.toContain("候补名单");
    await page.screenshot({
      path: info.outputPath("calendar.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "退出接龙", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "添加到日历", exact: true }),
    ).toHaveCount(0);
  } finally {
    await context.setOffline(false);
    await db.gameReservation.delete({ where: { id: r.id } });
  }
});

test("waiter gains calendar access only after promotion; cancellation removes it", async ({
  page,
  context,
}) => {
  const owner = token(),
    guest = token(),
    waiter = token();
  const r = await createReservation(
    {
      gameName: "候补日历",
      hostName: "Host",
      maxPlayers: 2,
      scheduledAt: new Date(Date.now() + 86400000).toISOString(),
    },
    owner,
  );
  try {
    await joinReservation(r.id, { name: "Guest" }, guest);
    await joinWaitlist(r.id, { name: "Waiter" }, waiter);
    await context.addCookies([
      {
        name: "party_identity",
        value: waiter,
        url: process.env.TEST_BASE_URL!,
      },
    ]);
    await page.goto(`/reservation/${r.id}`);
    await expect(page.getByText("你在候补第 1 位")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "添加到日历", exact: true }),
    ).toHaveCount(0);
    await leaveReservation(r.id, guest);
    await page.reload();
    await expect(
      page.getByRole("button", { name: "添加到日历", exact: true }),
    ).toBeVisible();
    await cancelReservation(r.id, { reason: "取消" }, owner);
    await page.reload();
    await expect(
      page.getByRole("button", { name: "添加到日历", exact: true }),
    ).toHaveCount(0);
  } finally {
    await db.gameReservation.delete({ where: { id: r.id } });
  }
});
