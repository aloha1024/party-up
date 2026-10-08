import "../support/isolated";
import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { db } from "../../server/db";
import { createReservation } from "../../server/reservations";
const token = () => randomBytes(32).toString("hex");
test.afterAll(async () => {
  await db.$disconnect();
});
test("same-start warning preserves nickname on cancel and allows exactly one explicitly confirmed join", async ({
  page,
  context,
  baseURL,
}) => {
  const member = token(),
    host = token(),
    ids: string[] = [];
  const scheduledAt = new Date(Date.now() + 86400000).toISOString();
  try {
    const own = await createReservation(
      {
        gameName: "已参加同期开局",
        hostName: "本人",
        maxPlayers: 3,
        scheduledAt,
      },
      member,
    );
    ids.push(own.id);
    const target = await createReservation(
      {
        gameName: "仍可选择参加",
        hostName: "另一发起人",
        maxPlayers: 3,
        scheduledAt,
      },
      host,
    );
    ids.push(target.id);
    await context.addCookies([
      { name: "party_identity", value: member, url: baseURL! },
    ]);
    await page.goto(`/reservation/${target.id}`);
    await page.getByPlaceholder("输入昵称，加入这一局").fill("保留昵称");
    let joins = 0;
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().endsWith("/participants")) joins++;
    });
    page.once("dialog", async (d) => {
      expect(d.message()).toContain("已参加同期开局");
      await d.dismiss();
    });
    await page.getByRole("button", { name: "加入接龙", exact: true }).click();
    await expect(page.getByPlaceholder("输入昵称，加入这一局")).toHaveValue(
      "保留昵称",
    );
    await expect(
      page.getByRole("button", { name: "加入接龙", exact: true }),
    ).toBeEnabled();
    expect(joins).toBe(0);
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "加入接龙", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "退出接龙", exact: true }),
    ).toBeVisible();
    expect(joins).toBe(1);
  } finally {
    await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
  }
});
