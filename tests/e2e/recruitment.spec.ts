import "../support/isolated";
import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { db } from "../../server/db";
import {
  createReservation,
  joinReservation,
  joinWaitlist,
  leaveReservation,
} from "../../server/reservations";
const token = () => randomBytes(32).toString("hex");
test.afterAll(async () => {
  await db.$disconnect();
});
test("lost pause response is not replayed and a fresh read confirms the committed version", async ({
  page,
  context,
  baseURL,
}) => {
  const owner = token();
  const r = await createReservation(
    {
      gameName: "招募响应丢失",
      hostName: "队长",
      maxPlayers: 3,
      scheduledAt: new Date(Date.now() + 86400000).toISOString(),
    },
    owner,
  );
  try {
    await context.addCookies([
      { name: "party_identity", value: owner, url: baseURL! },
    ]);
    page.on("dialog", (d) => d.accept());
    let calls = 0;
    await page.route(
      `**/api/reservations/${r.id}/recruitment`,
      async (route) => {
        calls++;
        await route.fetch();
        await route.abort("failed");
      },
    );
    await page.goto(`/reservation/${r.id}`);
    await page.getByRole("button", { name: "暂停招募", exact: true }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "不会自动重发" }),
    ).toBeVisible();
    expect(calls).toBe(1);
    await page.reload();
    await expect(
      page.getByRole("button", { name: "恢复招募", exact: true }),
    ).toBeVisible();
    expect(calls).toBe(1);
    expect(
      await db.reservationChange.count({
        where: { reservationId: r.id, action: "PAUSE" },
      }),
    ).toBe(1);
  } finally {
    await db.gameReservation.delete({ where: { id: r.id } });
  }
});
test("create restores a cutoff draft, persists Beijing time, and edit can explicitly clear it", async ({
  page,
}) => {
  const day = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const game = "截止草稿-" + token().slice(0, 8);
  await page.goto("/reservation/new");
  await page.getByLabel("游戏名称", { exact: true }).fill(game);
  await page.getByLabel("预约日期", { exact: true }).fill(day);
  await page.getByLabel("开玩时间 · 北京时间", { exact: true }).fill("20:00");
  await page.getByLabel("发起人昵称", { exact: true }).fill("队长");
  const cutoff = page.getByLabel("报名截止时间 · 北京时间（选填）");
  await cutoff.fill(day + "T19:00");
  await page.reload();
  await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
  await expect(cutoff).toHaveValue(day + "T19:00");
  await page.getByRole("button", { name: "创建预约，召集队友" }).click();
  await expect(page).toHaveURL(/\/reservation\/(?!new$)[a-z0-9-]+$/);
  const id = page.url().split("/").pop()!;
  try {
    expect(
      (
        await db.gameReservation.findUniqueOrThrow({ where: { id } })
      ).registrationDeadline?.toISOString(),
    ).toBe(day + "T11:00:00.000Z");
    await page.getByRole("link", { name: "编辑预约", exact: true }).click();
    await cutoff.fill("");
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/reservation/${id}$`));
    expect(
      (await db.gameReservation.findUniqueOrThrow({ where: { id } }))
        .registrationDeadline,
    ).toBe(null);
  } finally {
    await db.gameReservation.delete({ where: { id } });
  }
});
test("host pauses, leaves vacancies untouched and resumes FIFO with offline protection", async ({
  page,
  context,
  baseURL,
}) => {
  const owner = token(),
    member = token();
  const r = await createReservation(
    {
      gameName: "招募浏览器",
      hostName: "队长",
      maxPlayers: 2,
      scheduledAt: new Date(Date.now() + 86400000).toISOString(),
    },
    owner,
  );
  try {
    await joinReservation(r.id, { name: "队友" }, member);
    await joinWaitlist(r.id, { name: "候补队友" }, token());
    await context.addCookies([
      { name: "party_identity", value: owner, url: baseURL! },
    ]);
    page.on("dialog", (dialog) => dialog.accept());
    await page.goto(`/reservation/${r.id}`);
    await page.getByRole("button", { name: "暂停招募", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "恢复招募", exact: true }),
    ).toBeVisible();
    await leaveReservation(r.id, member);
    await page.reload();
    await expect(page.getByText("递补已暂停", { exact: true })).toBeVisible();
    await context.setOffline(true);
    await page.getByRole("button", { name: "恢复招募", exact: true }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "离线" }),
    ).toContainText("离线");
    await context.setOffline(false);
    await page.getByRole("button", { name: "恢复招募", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "暂停招募", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => db.waitlistEntry.count({ where: { reservationId: r.id } }))
      .toBe(0);
  } finally {
    await db.gameReservation.delete({ where: { id: r.id } });
  }
});
test("deadline wakes detail without clearing nickname and edit form retains Beijing cutoff", async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(45000);
  const owner = token(),
    deadline = new Date(Date.now() + 15000).toISOString();
  const r = await createReservation(
    {
      gameName: "截止浏览器",
      hostName: "队长",
      maxPlayers: 3,
      scheduledAt: new Date(Date.now() + 86400000).toISOString(),
      registrationDeadline: deadline,
    },
    owner,
  );
  try {
    await context.addCookies([
      { name: "party_identity", value: token(), url: baseURL! },
    ]);
    await page.goto(`/reservation/${r.id}`);
    const name = page.getByPlaceholder("输入昵称，加入这一局");
    await name.fill("保留昵称");
    await expect(
      page.getByRole("button", { name: "报名已截止", exact: true }),
    ).toBeDisabled({ timeout: 22000 });
    await expect(name).toHaveValue("保留昵称");
    await context.addCookies([
      { name: "party_identity", value: owner, url: baseURL! },
    ]);
    await page.goto(`/reservation/${r.id}/edit`);
    await expect(
      page.getByLabel("报名截止时间 · 北京时间（选填）"),
    ).toHaveValue(
      new Date(new Date(deadline).getTime() + 8 * 3600000)
        .toISOString()
        .slice(0, 19),
    );
  } finally {
    await db.gameReservation.delete({ where: { id: r.id } });
  }
});
