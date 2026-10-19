import "../support/isolated";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../../server/db";
import {
  createReservation,
  detail,
  editReservation,
  joinReservation,
  joinWaitlist,
  leaveReservation,
} from "../../server/reservations";
import { setScheduleConfirmation } from "../../server/reservation-schedule-confirmation";

const ids: string[] = [];
const token = () => randomBytes(32).toString("hex");
const panel = (page: Page) => page.getByRole("region", { name: "改期确认" });
const confirm = (page: Page) =>
  panel(page).getByRole("button", {
    name: "确认新时间，继续参加",
    exact: true,
  });
async function identity(context: BrowserContext, who: string) {
  await context.clearCookies();
  await context.addCookies([
    { name: "party_identity", value: who, url: process.env.TEST_BASE_URL! },
  ]);
}
async function fixture(maxPlayers = 3) {
  const owner = token(),
    member = token();
  const input = {
    gameName: "改期浏览器-" + randomUUID(),
    hostName: "队长",
    maxPlayers,
    description: "",
    scheduledAt: new Date(Date.now() + 2 * 86400000).toISOString(),
  };
  const r = await createReservation(input, owner);
  ids.push(r.id);
  await joinReservation(r.id, { name: "队友", scheduleVersion: 0 }, member);
  return { id: r.id, owner, member, input };
}
async function move(
  f: Awaited<ReturnType<typeof fixture>>,
  scheduledAt = new Date(Date.now() + 3 * 86400000).toISOString(),
) {
  const r = await detail(f.id, f.owner);
  return editReservation(
    f.id,
    { ...f.input, scheduledAt, editVersion: r.editVersion },
    f.owner,
  );
}
test.afterEach(async () => {
  await db.gameReservation.deleteMany({ where: { id: { in: ids.splice(0) } } });
});
test.afterAll(async () => db.$disconnect());

test("host and participant reconfirm the edited time independently while schedule badges update and seats remain", async ({
  page,
  context,
}, info) => {
  const f = await fixture();
  await identity(context, f.owner);
  await page.goto(`/reservation/${f.id}/edit`);
  await expect(page.getByText(/修改开玩时间.*正式/)).toBeVisible();
  await page
    .getByLabel("预约日期", { exact: true })
    .fill(new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10));
  await page.getByLabel("开玩时间 · 北京时间", { exact: true }).fill("23:59");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/reservation/${f.id}$`));
  await expect(panel(page)).toContainText("已认可新时间 0／正式报名 2 人");
  await expect(panel(page)).toContainText("你尚未确认改期");
  await confirm(page).click();
  await expect(panel(page)).toContainText("你已确认新时间");
  await expect(panel(page)).toContainText("已认可新时间 1／正式报名 2 人");
  await identity(context, f.member);
  await page.reload();
  await expect(panel(page)).toContainText("你尚未确认改期");
  await confirm(page).click();
  await expect(panel(page)).toContainText("已认可新时间 2／正式报名 2 人");
  await expect(confirm(page)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "退出接龙", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("schedule-confirmation.png"),
    fullPage: true,
  });
  await page.goto("/my-reservations?layout=schedule&range=week");
  await expect(
    page
      .locator(`[data-schedule-id="${f.id}"]`)
      .getByRole("link", { name: f.input.gameName, exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('[data-schedule-confirmation="confirmed"]'),
  ).toContainText("已确认新时间");
  expect((await detail(f.id)).participants).toHaveLength(2);
});

test("offline confirmation retains the choice and a lost response is never replayed before an explicit state check", async ({
  page,
  context,
}) => {
  const f = await fixture();
  await move(f);
  await identity(context, f.member);
  await page.goto(`/reservation/${f.id}`);
  await expect(confirm(page)).toBeEnabled();
  let calls = 0,
    completedCalls = 0;
  await page.route(
    `**/api/reservations/${f.id}/schedule-confirmation`,
    async (route) => {
      calls++;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort("failed");
      completedCalls++;
    },
  );
  await context.setOffline(true);
  await confirm(page).click();
  await expect(panel(page).getByRole("alert")).toContainText("离线");
  expect(calls).toBe(0);
  await context.setOffline(false);
  await confirm(page).click();
  await expect.poll(() => completedCalls).toBe(1);
  await expect(panel(page).getByRole("alert")).toContainText("网络连接中断");
  await expect(panel(page).getByRole("alert")).toContainText("不会自动重发");
  expect(calls).toBe(1);
  await panel(page).getByRole("button", { name: "刷新核对改期状态" }).click();
  await expect(panel(page)).toContainText("你已确认新时间");
  await expect(confirm(page)).toHaveCount(0);
  await expect(panel(page).getByRole("alert")).toHaveCount(0);
  expect(calls).toBe(1);
  expect(
    (await detail(f.id, f.member)).participants.find((p) => p.isMe)!
      .scheduleConfirmed,
  ).toBe(true);
});

test("automatic refresh shows a later reschedule and confirmation without clearing an observer nickname", async ({
  page,
  context,
}) => {
  test.setTimeout(65000);
  const f = await fixture();
  await identity(context, token());
  await page.goto(`/reservation/${f.id}`);
  await page.getByLabel("你的昵称", { exact: true }).fill("保留输入昵称");
  await expect(panel(page)).toHaveCount(0);
  await move(f);
  await expect(panel(page)).toContainText("已认可新时间 0／正式报名 2 人", {
    timeout: 22000,
  });
  await expect(confirm(page)).toHaveCount(0);
  await expect(page.getByLabel("你的昵称", { exact: true })).toHaveValue(
    "保留输入昵称",
  );
  const r = await detail(f.id, f.member);
  await setScheduleConfirmation(
    f.id,
    {
      participantId: r.participants.find((p) => p.isMe)!.id,
      scheduleVersion: r.scheduleVersion!,
    },
    f.member,
  );
  await expect(panel(page)).toContainText("已认可新时间 1／正式报名 2 人", {
    timeout: 22000,
  });
  await expect(page.getByLabel("你的昵称", { exact: true })).toHaveValue(
    "保留输入昵称",
  );
});

test("a waiter queued before the change receives a confirmation choice only after promotion and the start locks pending records", async ({
  page,
  context,
}) => {
  test.setTimeout(45000);
  const f = await fixture(2),
    waiter = token();
  await joinWaitlist(f.id, { name: "候补队友", scheduleVersion: 0 }, waiter);
  await move(f);
  await identity(context, waiter);
  await page.goto(`/reservation/${f.id}`);
  await expect(panel(page)).toBeVisible();
  await expect(confirm(page)).toHaveCount(0);
  await leaveReservation(f.id, f.member);
  await expect(confirm(page)).toBeVisible({ timeout: 22000 });
  await expect(panel(page)).toContainText("你尚未确认改期");
  await db.gameReservation.update({
    where: { id: f.id },
    data: { scheduledAt: new Date(Date.now() + 5000) },
  });
  await page.reload();
  await expect(confirm(page)).toBeVisible();
  await expect(panel(page)).toContainText(
    "预约已开始，改期确认已锁定，未确认记录保留。",
    { timeout: 12000 },
  );
  await expect(confirm(page)).toHaveCount(0);
  expect(
    (await detail(f.id, waiter)).participants.find((p) => p.isMe)!
      .scheduleConfirmed,
  ).toBe(false);
});

test("a successful confirmation followed by another reschedule before its response cannot acknowledge the obsolete generation", async ({
  page,
  context,
}) => {
  const f = await fixture();
  await move(f);
  await identity(context, f.member);
  await page.goto(`/reservation/${f.id}`);
  let calls = 0;
  await page.route(
    `**/api/reservations/${f.id}/schedule-confirmation`,
    async (route) => {
      calls++;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await move(f, new Date(Date.now() + 4 * 86400000).toISOString());
      const fresh = await detail(f.id, f.member);
      await route.fulfill({ response, json: { data: fresh } });
    },
  );
  await confirm(page).click();
  await expect(panel(page).getByRole("alert")).toContainText("不会自动重发");
  await expect(panel(page)).not.toContainText("你已确认新时间");
  expect(calls).toBe(1);
  await panel(page).getByRole("button", { name: "刷新核对改期状态" }).click();
  await expect(panel(page)).toContainText("你尚未确认改期");
  await expect(confirm(page)).toBeEnabled();
  expect(calls).toBe(1);
  const r = await detail(f.id, f.member);
  expect(r.scheduleVersion).toBe(2);
  expect(r.participants.find((p) => p.isMe)!.scheduleConfirmed).toBe(false);
});
