import "../support/isolated";
import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { db } from "../../server/db";
import {
  createReservation,
  detail,
  joinReservation,
  joinWaitlist,
  leaveReservation,
} from "../../server/reservations";

const token = () => randomBytes(32).toString("hex");
test.afterAll(async () => {
  await db.$disconnect();
});

test("host manages private meeting fields, formal members can read them and outsiders or waiters cannot", async ({
  page,
  context,
  browser,
  baseURL,
}, info) => {
  const owner = token(),
    member = token(),
    waiter = token();
  const r = await createReservation(
    {
      gameName: "集合信息-" + token().slice(0, 8),
      hostName: "队长",
      maxPlayers: 2,
      platform: "PC",
      gameServer: "亚洲区",
      scheduledAt: new Date(Date.now() + 86400000).toISOString(),
    },
    owner,
  );
  await joinReservation(r.id, { name: "正式队友" }, member);
  await joinWaitlist(r.id, { name: "候补队友" }, waiter);
  const other = await browser.newContext({ baseURL });
  const visitor = await other.newPage();
  const values = {
    roomName: "房间-" + token().slice(0, 8),
    roomPassword: "密码-" + token().slice(0, 8),
    voice: "语音-" + token().slice(0, 8),
  };
  try {
    await context.addCookies([
      { name: "party_identity", value: owner, url: baseURL! },
    ]);
    await page.goto(`/reservation/${r.id}`);
    const section = page.getByRole("region", { name: "开局集合信息" });
    await expect(section).toContainText("平台：PC · 区服：亚洲区");
    await section
      .getByRole("button", { name: "编辑集合信息", exact: true })
      .click();
    await section.getByLabel("房间号", { exact: true }).fill(values.roomName);
    await section
      .getByLabel("房间密码", { exact: true })
      .fill(values.roomPassword);
    await section.getByLabel("语音入口", { exact: true }).fill(values.voice);
    await section
      .getByRole("button", { name: "保存集合信息", exact: true })
      .click();
    await expect(
      section.getByText("房间号：" + values.roomName, { exact: true }),
    ).toBeVisible();
    const storage = await page.evaluate(() =>
      JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
      }),
    );
    for (const secret of Object.values(values))
      expect(storage).not.toContain(secret);
    await page.screenshot({
      path: info.outputPath("meeting-host.png"),
      fullPage: true,
    });

    const response = await visitor.goto(`/reservation/${r.id}`);
    const html = await response!.text();
    const privateRegion = visitor.getByRole("region", { name: "开局集合信息" });
    await expect(privateRegion).toContainText("仅当前正式参与者");
    await expect(
      privateRegion.getByRole("button", { name: "编辑集合信息" }),
    ).toHaveCount(0);
    for (const secret of Object.values(values))
      expect(html).not.toContain(secret);
    expect(
      (
        await (
          await other.request.get(`/api/reservations/${r.id}/meeting`)
        ).json()
      ).data,
    ).toBeNull();

    await other.addCookies([
      { name: "party_identity", value: waiter, url: baseURL! },
    ]);
    await visitor.reload();
    await expect(privateRegion).toContainText("仅当前正式参与者");
    expect(
      (
        await (
          await other.request.get(`/api/reservations/${r.id}/meeting`)
        ).json()
      ).data,
    ).toBeNull();

    await other.addCookies([
      { name: "party_identity", value: member, url: baseURL! },
    ]);
    await visitor.reload();
    await expect(
      privateRegion.getByText("房间密码：" + values.roomPassword, {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      privateRegion.getByRole("button", { name: "编辑集合信息" }),
    ).toHaveCount(0);
    await leaveReservation(r.id, member);
    await visitor.reload();
    await expect(privateRegion).toContainText("仅当前正式参与者");
    expect(
      (
        await (
          await other.request.get(`/api/reservations/${r.id}/meeting`)
        ).json()
      ).data,
    ).toBeNull();
    await other.addCookies([
      { name: "party_identity", value: waiter, url: baseURL! },
    ]);
    await visitor.reload();
    await expect(
      privateRegion.getByText("语音入口：" + values.voice, { exact: true }),
    ).toBeVisible();
  } finally {
    await other.close();
    await db.gameReservation.deleteMany({ where: { id: r.id } });
  }
});

test("offline and lost meeting responses retain inputs without replaying a write; explicit stale retries cannot overwrite", async ({
  page,
  context,
  baseURL,
}) => {
  const owner = token();
  const r = await createReservation(
    {
      gameName: "集合重试-" + token().slice(0, 8),
      hostName: "队长",
      maxPlayers: 2,
      scheduledAt: new Date(Date.now() + 86400000).toISOString(),
    },
    owner,
  );
  try {
    await context.addCookies([
      { name: "party_identity", value: owner, url: baseURL! },
    ]);
    await page.goto(`/reservation/${r.id}`);
    const section = page.getByRole("region", { name: "开局集合信息" });
    await section
      .getByRole("button", { name: "编辑集合信息", exact: true })
      .click();
    await section.getByLabel("房间号", { exact: true }).fill("保留输入的房间");
    await context.setOffline(true);
    await section
      .getByRole("button", { name: "保存集合信息", exact: true })
      .click();
    await expect(section.getByRole("alert")).toContainText("离线");
    await expect(section.getByLabel("房间号", { exact: true })).toHaveValue(
      "保留输入的房间",
    );
    await context.setOffline(false);
    let writes = 0;
    await page.route(`**/api/reservations/${r.id}/meeting`, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      writes++;
      if (writes === 1) {
        await route.fetch();
        await route.abort("connectionfailed");
      } else await route.continue();
    });
    await section
      .getByRole("button", { name: "保存集合信息", exact: true })
      .click();
    await expect(section.getByRole("alert")).toContainText("不会自动重发");
    expect(writes).toBe(1);
    expect((await detail(r.id, owner)).meeting).toEqual({
      roomName: "保留输入的房间",
      roomPassword: "",
      voice: "",
      version: 1,
    });
    await section.getByLabel("房间号", { exact: true }).fill("旧版本再次提交");
    await section
      .getByRole("button", { name: "保存集合信息", exact: true })
      .click();
    await expect(section.getByRole("alert")).toContainText("集合信息已变化");
    expect(writes).toBe(2);
    expect((await detail(r.id, owner)).meeting?.roomName).toBe(
      "保留输入的房间",
    );
    await page.reload();
    await expect(
      section.getByText("房间号：保留输入的房间", { exact: true }),
    ).toBeVisible();
    expect(writes).toBe(2);
  } finally {
    await context.setOffline(false);
    await db.gameReservation.deleteMany({ where: { id: r.id } });
  }
});
