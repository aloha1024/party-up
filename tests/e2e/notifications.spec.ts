import "../support/isolated";
import { test, expect } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../../server/db";
import {
  cancelReservation,
  createReservation,
  deleteReservation,
  editReservation,
  joinReservation,
  joinWaitlist,
  leaveReservation,
  removeRosterEntry,
} from "../../server/reservations";
import { setMeeting } from "../../server/reservation-meeting";
import {
  acceptInvitation,
  currentInvitation,
} from "../../server/reservation-invitations";
import {
  claimGuestRecords,
  previewGuestClaim,
} from "../../server/guest-claims";
import { digest, resolveViewer } from "../../server/user-identity";
import { browserCookie, registeredToken } from "../support/member";

const token = () => randomBytes(32).toString("hex");
const input = (gameName: string) => ({
  gameName,
  hostName: "提醒队长",
  maxPlayers: 2,
  scheduledAt: new Date(Date.now() + 86400000).toISOString(),
});
test.afterAll(async () => {
  await db.$disconnect();
});

test("guest notifications show committed changes, persist read state, and stay isolated from other identities", async ({
  page,
  context,
  baseURL,
}, info) => {
  const owner = token(),
    joined = token(),
    guest = token();
  const data = input("站内提醒" + randomUUID());
  const game = await createReservation(data, owner);
  try {
    await joinReservation(game.id, { name: "正式队友" }, joined);
    await joinWaitlist(game.id, { name: "候补队友" }, guest);
    await leaveReservation(game.id, joined);
    await editReservation(
      game.id,
      {
        ...data,
        scheduledAt: new Date(Date.now() + 2 * 86400000).toISOString(),
        editVersion: 0,
      },
      owner,
    );
    await setMeeting(
      game.id,
      {
        version: 0,
        roomName: "不应出现在提醒的房间号",
        roomPassword: "notification-private-password",
        voice: "https://voice.example.test/private-entry",
      },
      owner,
    );
    await cancelReservation(
      game.id,
      { reason: "不应出现在提醒的取消原因" },
      owner,
    );
    await context.addCookies([{ ...browserCookie(guest), url: baseURL! }]);
    await page.goto("/");
    await page.getByRole("link", { name: "站内提醒", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "我的提醒", exact: true }),
    ).toBeVisible();
    const cards = page.locator("[data-notification-id]");
    await expect(cards).toHaveCount(4);
    for (const label of [
      "候补已递补",
      "开玩时间已修改",
      "预约已取消",
      "集合信息已更新",
    ])
      await expect(cards.filter({ hasText: label })).toHaveCount(1);
    for (const privateValue of [
      "不应出现在提醒的房间号",
      "notification-private-password",
      "https://voice.example.test/private-entry",
      "不应出现在提醒的取消原因",
      guest,
    ])
      await expect(page.locator("main")).not.toContainText(privateValue);

    const promoted = cards.filter({ hasText: "候补已递补" });
    await promoted
      .getByRole("button", { name: "标为已读", exact: true })
      .click();
    await expect(
      promoted.getByRole("button", { name: "标为已读", exact: true }),
    ).toHaveCount(0);
    await page.reload();
    await expect(promoted).toContainText("已读");
    await expect(
      promoted.getByRole("button", { name: "标为已读", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("link", { name: "未读提醒", exact: true }).click();
    await expect(cards).toHaveCount(3);
    await expect(promoted).toHaveCount(0);
    await page
      .getByRole("button", { name: "全部标为已读", exact: true })
      .click();
    await expect(cards).toHaveCount(0);
    await page.reload();
    await expect(cards).toHaveCount(0);
    await page.getByRole("link", { name: "全部提醒", exact: true }).click();
    await expect(cards).toHaveCount(4);
    await expect(
      page.getByRole("button", { name: "标为已读", exact: true }),
    ).toHaveCount(0);
    await page.setViewportSize({ width: 320, height: 740 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath("notifications.png"),
      fullPage: true,
    });

    await context.clearCookies();
    await context.addCookies([{ ...browserCookie(token()), url: baseURL! }]);
    await page.reload();
    await expect(cards).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText(data.gameName);
    await context.clearCookies();
    await page.reload();
    await expect(cards).toHaveCount(0);
    expect(
      (await context.cookies()).some(
        (cookie) => cookie.name === "party_identity",
      ),
    ).toBe(false);
  } finally {
    await db.gameReservation.delete({ where: { id: game.id } });
  }
});

test("removed, deleted and inaccessible invitation notifications never disclose private details or stale links", async ({
  page,
  context,
  baseURL,
}) => {
  const owner = await registeredToken(),
    guest = token(),
    ids: string[] = [];
  try {
    const invited = await createReservation(
      { ...input("不可再查看的邀请游戏" + randomUUID()), visibility: "INVITE" },
      owner,
    );
    ids.push(invited.id);
    const invitation = await currentInvitation(invited.id, owner);
    await acceptInvitation(
      invited.id,
      { token: invitation.path.split("#invite=")[1] },
      guest,
    );
    await joinReservation(invited.id, { name: "被移除队友" }, guest);
    const participant = await db.participant.findFirstOrThrow({
      where: { reservationId: invited.id, tokenHash: digest(guest) },
    });
    await removeRosterEntry(
      invited.id,
      {
        kind: "participants",
        entryId: participant.id,
        expectedName: participant.name,
        reason: "不得进入提醒的移除原因",
      },
      owner,
    );
    await context.addCookies([{ ...browserCookie(guest), url: baseURL! }]);
    await page.goto("/notifications");
    const cards = page.locator("[data-notification-id]");
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText("报名已被移除");
    await expect(
      cards.first().getByRole("link", { name: invited.gameName, exact: true }),
    ).toBeVisible();
    await expect(cards.first()).not.toContainText("不得进入提醒的移除原因");
    // Model loss of the retained invitation grant after membership was removed.
    await db.reservationAccess.deleteMany({
      where: { reservationId: invited.id, tokenHash: digest(guest) },
    });

    const removed = await createReservation(
      input("已删除秘密标题" + randomUUID()),
      owner,
    );
    ids.push(removed.id);
    await joinReservation(removed.id, { name: "被通知队友" }, guest);
    await setMeeting(
      removed.id,
      {
        version: 0,
        roomName: "不能出现在提醒的房间",
        roomPassword: "cannot-render-meeting-password",
        voice: "",
      },
      owner,
    );
    await deleteReservation(removed.id, {
      id: 2,
      username: "notification-test-admin",
    });
    await page.reload();
    await expect(cards).toHaveCount(2);
    await expect(cards.getByRole("link")).toHaveCount(0);
    await expect(
      page.getByText("预约已移除或查看权限已变化", { exact: true }),
    ).toHaveCount(2);
    for (const value of [
      invited.gameName,
      removed.gameName,
      "不得进入提醒的移除原因",
      "cannot-render-meeting-password",
    ])
      await expect(page.locator("main")).not.toContainText(value);
    await page
      .getByRole("button", { name: "全部标为已读", exact: true })
      .click();
    await expect(
      cards.getByRole("button", { name: "标为已读", exact: true }),
    ).toHaveCount(0);
  } finally {
    await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
    await db.adminAuditLog.deleteMany({ where: { targetId: { in: ids } } });
  }
});

test("partial guest claims transfer only selected reservation notifications to the account across devices", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  const owner = token(),
    guest = token(),
    member = await registeredToken(),
    ids: string[] = [];
  const accountContext = await browser.newContext({ baseURL });
  try {
    for (const name of ["选中关联的提醒", "保留游客的提醒"]) {
      const game = await createReservation(input(name + randomUUID()), owner);
      ids.push(game.id);
      await joinReservation(game.id, { name: "游客队友" }, guest);
      await cancelReservation(game.id, { reason: "取消" }, owner);
    }
    await context.addCookies([{ ...browserCookie(guest), url: baseURL! }]);
    await page.goto("/notifications");
    await expect(page.locator("[data-notification-id]")).toHaveCount(2);

    const viewer = await resolveViewer(browserCookie(member).value, guest);
    const preview = await previewGuestClaim(viewer);
    const claim = {
      key: randomUUID(),
      fingerprint: preview.fingerprint,
      ids: [ids[0]],
    };
    const result = await claimGuestRecords(viewer, claim);
    expect(result.retired).toBe(false);
    expect(await claimGuestRecords(viewer, claim)).toEqual(result);
    await page.reload();
    await expect(page.locator("[data-notification-id]")).toHaveCount(1);
    await expect(page.locator("[data-notification-id]")).toContainText(
      "保留游客的提醒",
    );
    await expect(page.locator("main")).not.toContainText("选中关联的提醒");

    await accountContext.addCookies([
      { ...browserCookie(member), url: baseURL! },
    ]);
    const accountPage = await accountContext.newPage();
    await accountPage.goto("/notifications");
    await expect(accountPage.locator("[data-notification-id]")).toHaveCount(1);
    await expect(accountPage.locator("[data-notification-id]")).toContainText(
      "选中关联的提醒",
    );
    await expect(accountPage.locator("main")).not.toContainText(
      "保留游客的提醒",
    );
    await accountPage
      .getByRole("button", { name: "标为已读", exact: true })
      .click();
    await expect(
      accountPage.getByRole("button", { name: "标为已读", exact: true }),
    ).toHaveCount(0);
    await context.addCookies([{ ...browserCookie(member), url: baseURL! }]);
    await page.reload();
    await expect(page.locator("[data-notification-id]")).toHaveCount(1);
    await expect(page.locator("[data-notification-id]")).toContainText(
      "选中关联的提醒",
    );
    await expect(
      page.getByRole("button", { name: "标为已读", exact: true }),
    ).toHaveCount(0);
  } finally {
    await accountContext.close();
    await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
  }
});
