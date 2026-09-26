import "../support/isolated";
import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { db } from "../../server/db";
import {
  createReservation,
  editReservation,
  joinReservation,
  leaveReservation,
} from "../../server/reservations";
import {
  currentInvitation,
  rotateInvitation,
} from "../../server/reservation-invitations";
const token = () => randomBytes(32).toString("hex");
test.afterAll(async () => {
  await db.$disconnect();
});
test("invitation fragment redemption, rotation clears private detail and history, members retain nickname and access", async ({
  page,
  context,
}, info) => {
  test.setTimeout(90000);
  const owner = token();
  const input = {
    gameName: "私密局" + token().slice(0, 8),
    hostName: "队长",
    maxPlayers: 3,
    description: "只对邀请者可见的备注",
    scheduledAt: new Date(Date.now() + 86400000).toISOString(),
  };
  const r = await createReservation({ ...input, visibility: "INVITE" }, owner);
  try {
    await editReservation(
      r.id,
      { ...input, maxPlayers: 4, editVersion: 0 },
      owner,
    );
    let invitation = await currentInvitation(r.id, owner);
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.goto(invitation.path);
    await expect(page).toHaveURL(new RegExp(`/reservation/${r.id}$`));
    await expect(page.getByText(input.description)).toHaveCount(0);
    await context.setOffline(true);
    await page.getByRole("button", { name: "接受邀请并查看" }).click();
    await expect(page.locator("p[role=alert]")).toContainText("离线");
    await context.setOffline(false);
    await page.getByRole("button", { name: "接受邀请并查看" }).click();
    await expect(
      page.getByRole("heading", { name: input.gameName, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "分享邀请", exact: true }),
    ).toHaveCount(0);
    await page.getByLabel("你的昵称").fill("保留昵称");
    await rotateInvitation(
      r.id,
      { expectedVersion: invitation.version },
      owner,
    );
    await expect(
      page.getByRole("heading", { name: input.gameName, exact: true }),
    ).toHaveCount(0, { timeout: 22000 });
    await expect(page.getByText(input.description)).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "变更记录", exact: true }),
    ).toHaveCount(0);
    invitation = await currentInvitation(r.id, owner);
    await page.goto(invitation.path);
    await page.getByRole("button", { name: "接受邀请并查看" }).click();
    await page.getByLabel("你的昵称").fill("正式队友");
    await page.getByRole("button", { name: "加入接龙", exact: true }).click();
    await expect(
      page.getByText("你已在接龙名单中", { exact: true }),
    ).toBeVisible();
    await rotateInvitation(
      r.id,
      { expectedVersion: invitation.version },
      owner,
    );
    await page.reload();
    await expect(
      page.getByRole("heading", { name: input.gameName, exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "退出接龙", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "加入接龙", exact: true }),
    ).toBeVisible();
    await page.getByLabel("你的昵称").fill("再次报名");
    await page.getByRole("button", { name: "加入接龙", exact: true }).click();
    await expect(page.locator("p[role=alert]")).toContainText("当前有效邀请");
    await page.screenshot({
      path: info.outputPath("invitation-member.png"),
      fullPage: true,
    });
    expect(
      requests.every(
        (url) =>
          !url.includes("#invite=") &&
          !url.includes(invitation.path.split("#invite=")[1]),
      ),
    ).toBe(true);
  } finally {
    await db.gameReservation.delete({ where: { id: r.id } });
  }
});
test("create private reservation, share only credential hint and rotate without exposing rosters", async ({
  page,
}, info) => {
  await page.goto("/reservation/new");
  await page
    .getByLabel("游戏名称", { exact: true })
    .fill("邀请创建" + token().slice(0, 6));
  await page.getByLabel("预约可见性").selectOption("INVITE");
  await page
    .getByLabel("预约日期", { exact: true })
    .fill(new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10));
  await page.getByLabel("开玩时间 · 北京时间", { exact: true }).fill("20:00");
  await page.getByLabel("发起人昵称", { exact: true }).fill("邀请发起人");
  await page.getByRole("button", { name: "创建预约，召集队友" }).click();
  await expect(page).toHaveURL(/\/reservation\/[a-f0-9-]{36}$/);
  const id = page.url().split("/").at(-1)!;
  try {
    await page.getByRole("button", { name: "分享邀请", exact: true }).click();
    const link = page.getByLabel("当前邀请链接");
    await expect(link).toHaveValue(/#invite=[a-f0-9]{64}$/);
    const first = await link.inputValue();
    let rotations = 0;
    await page.route(`**/api/reservations/${id}/invitation`, async (route) => {
      if (route.request().method() === "POST") {
        rotations++;
        if (rotations === 1) {
          await route.fetch();
          await route.abort("failed");
          return;
        }
      }
      await route.continue();
    });
    page.once("dialog", (dialog) => dialog.accept());
    await page
      .getByRole("button", { name: "更换邀请链接", exact: true })
      .click();
    await expect(page.locator("p[role=alert]")).toBeVisible();
    expect(rotations).toBe(1);
    await expect(
      page.getByRole("button", { name: "更换邀请链接", exact: true }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "分享邀请", exact: true }).click();
    await expect(link).not.toHaveValue(first);
    expect(rotations).toBe(1);
    expect(
      (await db.gameReservation.findUniqueOrThrow({ where: { id } }))
        .inviteVersion,
    ).toBe(2);
    await page.screenshot({
      path: info.outputPath("invitation-manager.png"),
      fullPage: true,
    });
    await page.getByRole("link", { name: "再开一局", exact: true }).click();
    await expect(page.getByLabel("预约可见性")).toHaveValue("INVITE");
    await expect(page.getByLabel("预约日期", { exact: true })).toHaveValue("");
  } finally {
    await db.gameReservation.delete({ where: { id } });
  }
});

test("lost invitation acceptance is manually retryable and waitlist promotion preserves access", async ({
  page,
}) => {
  test.setTimeout(90000);
  const owner = token(),
    other = token(),
    input = {
      gameName: "邀请候补" + token().slice(0, 8),
      hostName: "队长",
      maxPlayers: 2,
      description: "",
      scheduledAt: new Date(Date.now() + 86400000).toISOString(),
    };
  const r = await createReservation({ ...input, visibility: "INVITE" }, owner);
  try {
    const invitation = await currentInvitation(r.id, owner);
    const { acceptInvitation } =
      await import("../../server/reservation-invitations");
    await acceptInvitation(
      r.id,
      { token: invitation.path.split("#invite=")[1] },
      other,
    );
    await joinReservation(r.id, { name: "正式队友" }, other);
    let calls = 0;
    await page.route(
      `**/api/reservations/${r.id}/invitation/accept`,
      async (route) => {
        calls++;
        if (calls === 1) {
          await route.fetch();
          await route.abort("failed");
        } else await route.continue();
      },
    );
    await page.goto(invitation.path);
    await page.getByRole("button", { name: "接受邀请并查看" }).click();
    await expect(page.locator("p[role=alert]")).toBeVisible();
    expect(calls).toBe(1);
    await page.getByRole("button", { name: "接受邀请并查看" }).click();
    await expect(
      page.getByRole("heading", { name: input.gameName, exact: true }),
    ).toBeVisible();
    expect(calls).toBe(2);
    await page.getByLabel("你的昵称").fill("候补昵称");
    await editReservation(
      r.id,
      { ...input, description: "刷新测试", editVersion: 0 },
      owner,
    );
    await expect(page.getByText("刷新测试", { exact: true })).toBeVisible({
      timeout: 22000,
    });
    await expect(page.getByLabel("你的昵称")).toHaveValue("候补昵称");
    await page.getByRole("button", { name: "加入候补", exact: true }).click();
    await expect(
      page.getByText("你在候补第 1 位", { exact: true }),
    ).toBeVisible();
    await rotateInvitation(r.id, { expectedVersion: 1 }, owner);
    await leaveReservation(r.id, other);
    await expect(
      page.getByText("你已在接龙名单中", { exact: true }),
    ).toBeVisible({ timeout: 22000 });
    const cookies = await page.context().cookies();
    const identity = cookies.find((c) => c.name === "party_identity")!.value;
    const calendar = await page.request.get(
      `/api/reservations/${r.id}/calendar`,
    );
    expect(calendar.status()).toBe(200);
    expect(await calendar.text()).not.toContain("invite=");
    expect(await calendar.text()).not.toContain(identity);
  } finally {
    await db.gameReservation.deleteMany({ where: { id: r.id } });
  }
});
