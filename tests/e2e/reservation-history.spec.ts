import "../support/isolated";
import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { db } from "../../server/db";
import {
  createReservation,
  editReservation,
  cancelReservation,
} from "../../server/reservations";

test.afterAll(async () => {
  await db.$disconnect();
});
test("public history loads older pages, catches refresh gaps, retries offline and preserves nickname", async ({
  page,
  context,
}, info) => {
  test.setTimeout(90000);
  const owner = randomBytes(32).toString("hex");
  const input = {
    gameName: "变更记录测试",
    hostName: "队长",
    description: "私密旧备注",
    maxPlayers: 3,
    scheduledAt: new Date(Date.now() + 86400000).toISOString(),
  };
  const r = await createReservation(input, owner);
  try {
    await page.goto(`/reservation/${r.id}`);
    const region = page.getByRole("region", { name: "变更记录", exact: true });
    await expect(
      region.getByText("暂无变更记录，仅记录功能启用后的修改", { exact: true }),
    ).toBeVisible();
    for (let i = 0; i < 25; i++)
      await editReservation(
        r.id,
        { ...input, description: `私密备注${i}`, editVersion: i },
        owner,
      );
    await page.reload();
    const entries = region.locator("[data-change-id]");
    await expect(entries).toHaveCount(10);
    await page.getByLabel("你的昵称").fill("保留输入昵称");
    await context.setOffline(true);
    await region
      .getByRole("button", { name: "加载更早记录", exact: true })
      .click();
    await expect(region.getByRole("alert")).toBeVisible();
    await expect(entries).toHaveCount(10);
    await context.setOffline(false);
    const retryButton = region.getByRole("button", {
      name: "重试加载记录",
      exact: true,
    });
    await retryButton.click();
    await expect(entries).toHaveCount(20);
    for (let i = 25; i < 48; i++)
      await editReservation(
        r.id,
        { ...input, description: `私密备注${i}`, editVersion: i },
        owner,
      );
    await expect(entries).toHaveCount(43, { timeout: 22000 });
    await expect(page.getByLabel("你的昵称")).toHaveValue("保留输入昵称");
    await region
      .getByRole("button", { name: "加载更早记录", exact: true })
      .click();
    await expect(entries).toHaveCount(48);
    const observed = await entries.evaluateAll((nodes) =>
      nodes.map((node) => Number(node.getAttribute("data-change-id"))),
    );
    expect(new Set(observed).size).toBe(48);
    expect(observed).toEqual([...observed].sort((a, b) => b - a));
    await expect(region).not.toContainText("私密备注");
    await cancelReservation(r.id, { reason: "仅当前详情原因" }, owner, {
      id: 2,
      username: "不公开管理员",
    });
    await expect(entries).toHaveCount(49, { timeout: 22000 });
    await expect(entries.first()).toContainText("管理员");
    await expect(entries.first()).toContainText("预约已取消");
    await expect(region).not.toContainText("不公开管理员");
    await expect(region).not.toContainText("仅当前详情原因");
    await page.screenshot({
      path: info.outputPath("history.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await context.setOffline(false);
    await db.gameReservation.delete({ where: { id: r.id } });
    await db.adminAuditLog.deleteMany({ where: { targetId: r.id } });
  }
});

test("history displays Beijing time and capacity changes, and changing reservation resets loaded history", async ({
  page,
}, info) => {
  const owner = randomBytes(32).toString("hex");
  const input = {
    gameName: "历史展示",
    hostName: "原发起人",
    description: "旧备注不可留存",
    maxPlayers: 3,
    scheduledAt: "2090-01-01T16:00:00.000Z",
  };
  const first = await createReservation(input, owner);
  const second = await createReservation(input, owner);
  try {
    await editReservation(
      first.id,
      {
        ...input,
        gameName: "修改后的游戏",
        hostName: "修改后的昵称",
        description: "修改后的备注",
        scheduledAt: "2090-01-02T16:00:00.000Z",
        maxPlayers: 5,
        editVersion: 0,
      },
      owner,
    );
    await page.goto(`/reservation/${first.id}`);
    const history = page.getByRole("region", { name: "变更记录", exact: true });
    await expect(history).toContainText("人数上限：3 人 → 5 人");
    await expect(history).toContainText(
      "开玩时间：2090/01/02 00:00:00 → 2090/01/03 00:00:00",
    );
    for (const text of [
      "游戏名称：已修改",
      "发起人昵称：已修改",
      "备注：已修改",
    ])
      await expect(history).toContainText(text);
    await expect(history).not.toContainText("旧备注不可留存");
    await page.screenshot({
      path: info.outputPath("history-display.png"),
      fullPage: true,
    });
    await page.goto(`/reservation/${second.id}`);
    await expect(page).toHaveURL(new RegExp(second.id));
    await expect(history.locator("[data-change-id]")).toHaveCount(0);
    await expect(history).toContainText("暂无变更记录，仅记录功能启用后的修改");
  } finally {
    await db.gameReservation.deleteMany({
      where: { id: { in: [first.id, second.id] } },
    });
  }
});
