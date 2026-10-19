import "../support/isolated";
import { test, expect, type Page } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../../server/db";
import { createReservation, joinReservation } from "../../server/reservations";
import { browserCookie } from "../support/member";

const day = () =>
  new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
const submit = (page: Page) =>
  page.getByRole("button", { name: "创建预约，召集队友", exact: true });
const summary = (page: Page) => page.locator('form [role="alert"]');
async function fill(page: Page) {
  await page
    .getByLabel("游戏名称", { exact: true })
    .fill("字段提示-" + randomUUID());
  await page.getByLabel("预约日期", { exact: true }).fill(day());
  await page.getByLabel("开玩时间 · 北京时间", { exact: true }).fill("20:00");
  await page.getByLabel("发起人昵称", { exact: true }).fill("队长");
}
test.afterAll(async () => {
  await db.$disconnect();
});

test("all field errors appear together, focus and links locate fields without initializing identity or losing drafts", async ({
  page,
  context,
}, info) => {
  let writes = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/(identity|reservations)(\/|$)/.test(
        new URL(request.url()).pathname,
      )
    )
      writes++;
  });
  await page.goto("/reservation/new");
  await page.getByLabel("最大参与人数 · 含发起人", { exact: true }).fill("");
  await page
    .getByLabel("备注（选填）", { exact: true })
    .fill("校验失败后保留的草稿");
  await submit(page).click();
  await expect(summary(page)).toContainText("请检查以下内容后再提交");
  await expect(summary(page).getByRole("button")).toHaveCount(5);
  const game = page.getByLabel("游戏名称", { exact: true });
  await expect(game).toBeFocused();
  for (const label of [
    "游戏名称",
    "预约日期",
    "开玩时间 · 北京时间",
    "发起人昵称",
    "最大参与人数 · 含发起人",
  ]) {
    const input = page.getByLabel(label, { exact: true });
    await expect(input).toHaveAttribute("aria-invalid", "true");
    const describedBy = await input.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    await expect(page.locator(`[id="${describedBy}"]`)).toBeVisible();
  }
  expect(writes).toBe(0);
  expect(
    (await context.cookies()).some(
      (cookie) => cookie.name === "party_identity",
    ),
  ).toBe(false);
  const bounds = await game.boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(
    page.viewportSize()!.height,
  );
  await summary(page)
    .getByRole("button", { name: /^预约日期：/ })
    .click();
  await expect(page.getByLabel("预约日期", { exact: true })).toBeFocused();
  await page.setViewportSize({ width: 320, height: 740 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("reservation-form-errors.png"),
    fullPage: true,
  });
  await game.fill("修正后-" + randomUUID());
  await expect(game).not.toHaveAttribute("aria-invalid");
  await expect(game).toBeFocused();
  await page.getByLabel("预约日期", { exact: true }).fill(day());
  await page.getByLabel("开玩时间 · 北京时间", { exact: true }).fill("20:00");
  await page.getByLabel("发起人昵称", { exact: true }).fill("队长");
  await page.getByLabel("最大参与人数 · 含发起人", { exact: true }).fill("3");
  await expect(summary(page)).toHaveCount(0);
  await expect(page.getByLabel("备注（选填）", { exact: true })).toHaveValue(
    "校验失败后保留的草稿",
  );
  expect(writes).toBe(0);
  await submit(page).click();
  await expect(page).toHaveURL(/\/reservation\/(?!new$)[a-z0-9-]+$/);
  await db.gameReservation.delete({
    where: { id: page.url().split("/").pop()! },
  });
});

test("past times, cutoff and numeric errors are associated with controls and revalidated without moving focus while typing", async ({
  page,
}) => {
  await page.goto("/reservation/new");
  await fill(page);
  const date = page.getByLabel("预约日期", { exact: true });
  const time = page.getByLabel("开玩时间 · 北京时间", { exact: true });
  const deadline = page.getByLabel("报名截止时间 · 北京时间（选填）", {
    exact: true,
  });
  const capacity = page.getByLabel("最大参与人数 · 含发起人", { exact: true });
  await date.fill("2020-01-01");
  await deadline.fill(day() + "T21:00");
  await capacity.fill("2.5");
  await submit(page).click();
  await expect(date).toBeFocused();
  await expect(time).toHaveAttribute("aria-invalid", "true");
  await expect(summary(page)).toContainText("预约时间必须是未来时间");
  await expect(summary(page)).toContainText("报名截止时间不能晚于开玩时间");
  await expect(summary(page)).toContainText("请输入有效的整数人数");
  await date.fill(day());
  await expect(date).not.toHaveAttribute("aria-invalid");
  await expect(time).not.toHaveAttribute("aria-invalid");
  await expect(date).toBeFocused();
  await submit(page).click();
  await expect(deadline).toBeFocused();
  await deadline.fill(day() + "T19:00");
  await capacity.fill("101");
  await submit(page).click();
  await expect(capacity).toBeFocused();
  await expect(summary(page)).toContainText("人数最多为 100");
  await page
    .getByLabel("备注（选填）", { exact: true })
    .fill("继续编辑不抢焦点");
  await expect(page.getByLabel("备注（选填）", { exact: true })).toBeFocused();
});

test("restored malformed date, time, cutoff and capacity stay blocked instead of being silently normalized", async ({
  page,
}) => {
  let writes = 0;
  page.on("request", (request) => {
    if (request.method() === "POST") writes++;
  });
  await page.goto("/reservation/new");
  await fill(page);
  await page.getByLabel("备注（选填）", { exact: true }).fill("恢复后保留");
  await page.evaluate(() => {
    const key = Object.keys(sessionStorage).find((key) =>
      key.startsWith("party-reservation-draft:new"),
    )!;
    const draft = JSON.parse(sessionStorage.getItem(key)!);
    Object.assign(draft.fields, {
      date: "2099-02-31",
      time: "24:00",
      deadline: "2099-02-31T19:00",
      maxPlayers: "0x5",
    });
    sessionStorage.setItem(key, JSON.stringify(draft));
  });
  await page.reload();
  await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
  await submit(page).click();
  await expect(summary(page).getByRole("button")).toHaveCount(4);
  await expect(summary(page)).toContainText("请选择有效的预约日期");
  await expect(summary(page)).toContainText("请选择有效的开玩时间");
  await expect(summary(page)).toContainText("请选择有效的报名截止时间");
  await expect(summary(page)).toContainText("请输入有效的整数人数");
  await expect(page.getByLabel("预约日期", { exact: true })).toBeFocused();
  expect(writes).toBe(0);
  await page.getByLabel("预约日期", { exact: true }).fill(day());
  await page.getByLabel("开玩时间 · 北京时间", { exact: true }).fill("20:00");
  await page
    .getByLabel("报名截止时间 · 北京时间（选填）", { exact: true })
    .fill("");
  await page.getByLabel("最大参与人数 · 含发起人", { exact: true }).fill("5");
  await expect(summary(page)).toHaveCount(0);
  await expect(page.getByLabel("备注（选填）", { exact: true })).toHaveValue(
    "恢复后保留",
  );
  expect(writes).toBe(0);
});

test("edit capacity and server field errors focus after pending, while general failures preserve input and focus their summary", async ({
  page,
  context,
  baseURL,
}) => {
  const owner = randomBytes(32).toString("hex");
  const reservation = await createReservation(
    {
      gameName: "错误定位",
      hostName: "队长",
      maxPlayers: 3,
      scheduledAt: day() + "T12:00:00.000Z",
    },
    owner,
  );
  await joinReservation(
    reservation.id,
    { name: "队友一" },
    randomBytes(32).toString("hex"),
  );
  await joinReservation(
    reservation.id,
    { name: "队友二" },
    randomBytes(32).toString("hex"),
  );
  try {
    await context.addCookies([{ ...browserCookie(owner), url: baseURL! }]);
    await page.goto(`/reservation/${reservation.id}/edit`);
    const save = page.getByRole("button", { name: "保存修改", exact: true });
    const capacity = page.getByLabel("最大参与人数 · 含发起人", {
      exact: true,
    });
    const nickname = page.getByLabel("发起人昵称", { exact: true });
    const notes = page.getByLabel("备注（选填）", { exact: true });
    let requests = 0;
    let response = { code: "CAPACITY", error: "人数上限不能小于当前报名人数" };
    await page.route(`**/api/reservations/${reservation.id}`, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      requests++;
      await route.fulfill({ status: 409, json: response });
    });
    await capacity.fill("2");
    await save.click();
    await expect(capacity).toBeFocused();
    await expect(summary(page)).toContainText(response.error);
    expect(requests).toBe(0);
    await capacity.fill("3");
    await notes.fill("服务端拒绝后保留");
    await save.click();
    await expect.poll(() => requests).toBe(1);
    await expect(capacity).toBeEnabled();
    await expect(capacity).toHaveAttribute("aria-invalid", "true");
    await expect(capacity).toBeFocused();
    await notes.fill("服务端容量冲突仍保留");
    await expect(capacity).toHaveAttribute("aria-invalid", "true");
    await expect(notes).toBeFocused();
    response = {
      code: "DUPLICATE",
      error: "该昵称已被使用，或你已报名或加入候补",
    };
    await save.click();
    await expect(summary(page)).toContainText(response.error);
    await expect(nickname).toBeFocused();
    expect(requests).toBe(2);
    await notes.fill("服务端拒绝后保留");
    await expect(nickname).toHaveAttribute("aria-invalid", "true");
    await expect(notes).toBeFocused();
    await nickname.fill("另一昵称");
    await expect(nickname).not.toHaveAttribute("aria-invalid");
    response = { code: "VALIDATION", error: "请选择有效时间（服务端复核）" };
    await save.click();
    await expect(summary(page)).toContainText(response.error);
    await expect(summary(page)).toBeFocused();
    expect(requests).toBe(3);
    await expect(notes).toHaveValue("服务端拒绝后保留");
    await notes.fill("继续保留草稿");
    await expect(notes).toBeFocused();
    expect(requests).toBe(3);
    response = {
      code: "EDIT_CONFLICT",
      error: "预约已被其他人修改。当前输入已保留",
    };
    await save.click();
    await expect(summary(page)).toContainText(response.error);
    await expect(summary(page)).toBeFocused();
    await expect(save).toBeDisabled();
    expect(requests).toBe(4);
  } finally {
    await db.gameReservation.delete({ where: { id: reservation.id } });
  }
});
