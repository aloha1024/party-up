import "../support/isolated";
import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { db } from "../../server/db";
import {
  createReservation,
  joinReservation,
  detail,
  editReservation,
} from "../../server/reservations";
import {
  setAttendance,
  setCompletion,
} from "../../server/reservation-attendance";
const token = () => randomBytes(32).toString("hex");
test.afterAll(async () => {
  await db.$disconnect();
});
test("attendance opening wakes refresh, offline state is retained and lost response never automatically replays", async ({
  page,
  context,
  baseURL,
}, info) => {
  test.setTimeout(60000);
  const owner = token(),
    guest = token();
  const input = {
    gameName: "到场测试" + token().slice(0, 6),
    hostName: "队长",
    maxPlayers: 3,
    scheduledAt: new Date(Date.now() + 30 * 60000 + 8000).toISOString(),
  };
  const r = await createReservation(input, owner);
  await joinReservation(r.id, { name: "队友" }, guest);
  try {
    await context.addCookies([
      { name: "party_identity", value: guest, url: baseURL! },
    ]);
    await page.goto(`/reservation/${r.id}`);
    const section = page.getByRole("region", { name: "到场确认与结束状态" });
    await expect(section.getByText(/开放确认/)).toBeVisible();
    await expect(
      section.getByRole("button", { name: "确认到场", exact: true }),
    ).toHaveCount(0);
    await expect(
      section.getByRole("button", { name: "确认到场", exact: true }),
    ).toBeVisible({ timeout: 12000 });
    await context.setOffline(true);
    await section
      .getByRole("button", { name: "确认到场", exact: true })
      .click();
    await expect(section.getByRole("alert")).toContainText("离线");
    await context.setOffline(false);
    let calls = 0;
    await page.route(
      `**/api/reservations/${r.id}/attendance`,
      async (route) => {
        calls++;
        if (calls === 1) {
          await route.fetch();
          await route.abort("failed");
        } else await route.continue();
      },
    );
    await section
      .getByRole("button", { name: "确认到场", exact: true })
      .click();
    await expect.poll(() => calls).toBe(1);
    await expect(section.getByRole("alert")).toContainText("不会自动重发");
    expect(calls).toBe(1);
    await section.getByRole("button", { name: "刷新核对状态" }).click();
    await expect(
      section.getByRole("button", { name: "撤销到场确认", exact: true }),
    ).toBeVisible();
    expect(calls).toBe(1);
    await expect(section.getByRole("alert")).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath("attendance.png"),
      fullPage: true,
    });
    await section
      .getByRole("button", { name: "撤销到场确认", exact: true })
      .click();
    await expect(
      section.getByText("已到场 0／正式报名 2 人", { exact: true }),
    ).toBeVisible();
    expect(calls).toBe(2);
  } finally {
    await db.gameReservation.deleteMany({ where: { id: r.id } });
  }
});
test("host ends and reopens, history and filters update, rescheduling warns and resets attendance", async ({
  page,
  context,
  baseURL,
}) => {
  const owner = token(),
    input = {
      gameName: "结束测试" + token().slice(0, 6),
      hostName: "队长",
      maxPlayers: 3,
      description: "",
      scheduledAt: new Date(Date.now() + 600000).toISOString(),
    };
  const r = await createReservation(input, owner);
  try {
    await context.addCookies([
      { name: "party_identity", value: owner, url: baseURL! },
    ]);
    await page.goto(`/reservation/${r.id}`);
    await page.getByRole("button", { name: "确认到场", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "撤销到场确认", exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "编辑预约", exact: true }).click();
    await expect(
      page.getByText(/修改开玩时间将清空已有到场确认/),
    ).toBeVisible();
    await page
      .getByLabel("预约日期", { exact: true })
      .fill(new Date(Date.now() + 86400000).toISOString().slice(0, 10));
    await page.getByLabel("开玩时间 · 北京时间", { exact: true }).fill("23:59");
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/reservation/${r.id}$`));
    await expect(
      page.getByText("已到场 0／正式报名 1 人", { exact: true }),
    ).toBeVisible();
    await db.gameReservation.update({
      where: { id: r.id },
      data: { scheduledAt: new Date(Date.now() - 1000) },
    });
    await page.reload();
    await page.getByRole("button", { name: "确认到场", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "撤销到场确认", exact: true }),
    ).toBeVisible();
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "结束预约", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "撤销结束", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "撤销到场确认", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText("预约已结束", { exact: true })).toBeVisible();
    await page.goto(`/my-reservations?view=ended`);
    await expect(
      page.getByRole("heading", { name: input.gameName, exact: true }),
    ).toBeVisible();
    await page
      .getByRole("heading", { name: input.gameName, exact: true })
      .click();
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "撤销结束", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "撤销到场确认", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("已撤销结束", { exact: true })).toBeVisible();
    await page.goto(`/?view=started&q=${encodeURIComponent(input.gameName)}`);
    await expect(
      page.getByRole("heading", { name: input.gameName, exact: true }),
    ).toBeVisible();
  } finally {
    await db.gameReservation.deleteMany({ where: { id: r.id } });
  }
});
test("observer auto refresh preserves nickname while attendance and completion change", async ({
  page,
}) => {
  test.setTimeout(60000);
  const owner = token();
  const r = await createReservation(
    {
      gameName: "到场刷新" + token().slice(0, 6),
      hostName: "队长",
      maxPlayers: 3,
      scheduledAt: new Date(Date.now() + 600000).toISOString(),
    },
    owner,
  );
  try {
    await page.goto(`/reservation/${r.id}`);
    await page.getByLabel("你的昵称").fill("保留昵称");
    const p = r.participants[0];
    await setAttendance(
      r.id,
      {
        participantId: p.id,
        attendanceVersion: 0,
        editVersion: 0,
        checkedIn: true,
      },
      owner,
    );
    await expect(
      page.getByText("已到场 1／正式报名 1 人", { exact: true }),
    ).toBeVisible({ timeout: 22000 });
    await expect(page.getByLabel("你的昵称")).toHaveValue("保留昵称");
    await db.gameReservation.update({
      where: { id: r.id },
      data: { scheduledAt: new Date(0) },
    });
    await setCompletion(r.id, { editVersion: 0 }, owner, true);
    await expect(
      page.getByText("预约已结束，到场确认已锁定。", { exact: true }),
    ).toBeVisible({ timeout: 22000 });
    await expect(page.getByLabel("你的昵称")).toHaveValue("保留昵称");
  } finally {
    await db.gameReservation.deleteMany({ where: { id: r.id } });
  }
});
