import "./support/isolated";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../server/db";
import { registerUser, revokeUserSessions } from "../server/user-accounts";
import { resolveViewer, digest } from "../server/user-identity";
import {
  calendarFeed,
  calendarSettings,
  rotateCalendar,
  revokeCalendar,
} from "../server/calendar-subscription";
import { subscriptionCalendar } from "../lib/reservation-calendar";
import {
  createReservation,
  joinReservation,
  joinWaitlist,
  leaveReservation,
} from "../server/reservations";
const users: string[] = [],
  ids: string[] = [];
const password = "subscription-test-password-2026";
async function account() {
  const auth = await registerUser({
    username: "cal_" + randomUUID().replaceAll("-", "").slice(0, 15),
    nickname: "订阅者",
    password,
  });
  const viewer = await resolveViewer(auth.token);
  users.push(viewer.user!.id);
  return { auth, viewer };
}
async function fixture(token: string, visibility = "PUBLIC") {
  const r = await createReservation(
    {
      gameName: "日历-" + randomUUID(),
      hostName: "发起人",
      maxPlayers: 2,
      visibility,
      description: "private-note-not-exported",
      scheduledAt: new Date(Date.now() + 86400000).toISOString(),
    },
    token,
  );
  ids.push(r.id);
  return r;
}
after(async () => {
  await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

test("subscription grants default to public formal membership, rotation revokes links and exposes no stored plaintext", async () => {
  const { viewer } = await account(),
    other = await account();
  const publicR = await fixture(viewer.token!),
    privateR = await fixture(viewer.token!, "INVITE");
  const otherR = await fixture(other.viewer.token!);
  await joinReservation(
    otherR.id,
    { name: "正式队友" },
    randomBytes(32).toString("hex"),
  );
  await joinWaitlist(otherR.id, { name: "候补账号" }, viewer.token!);
  const initial = await calendarSettings(viewer);
  assert.deepEqual(initial, {
    active: false,
    version: 0,
    includeInvites: false,
  });
  const first = await rotateCalendar(viewer, {
    version: 0,
    includeInvites: false,
  });
  const row = await db.calendarSubscription.findUniqueOrThrow({
    where: { userId: viewer.user!.id },
  });
  assert.equal(row.tokenHash, digest(first.token));
  assert.ok(!JSON.stringify(row).includes(first.token));
  assert.deepEqual(
    (await calendarFeed(first.token)).map((r) => r.id),
    [publicR.id],
  );
  const second = await rotateCalendar(viewer, {
    version: 1,
    includeInvites: true,
  });
  await assert.rejects(calendarFeed(first.token), { code: "NOT_FOUND" });
  assert.deepEqual(
    new Set((await calendarFeed(second.token)).map((r) => r.id)),
    new Set([publicR.id, privateR.id]),
  );
  assert.ok(
    !(await calendarFeed(second.token)).some((r) => r.id === otherR.id),
  );
  await assert.rejects(
    rotateCalendar(viewer, { version: 1, includeInvites: false }),
    { code: "CALENDAR_CONFLICT" },
  );
  await leaveReservation(publicR.id, viewer.token!);
  assert.deepEqual(
    (await calendarFeed(second.token)).map((r) => r.id),
    [privateR.id],
  );
  await db.gameReservation.update({
    where: { id: privateR.id },
    data: { deletedAt: new Date() },
  });
  assert.deepEqual(await calendarFeed(second.token), []);
  const disabled = await revokeCalendar(viewer, { version: 2 });
  assert.equal(disabled.version, 3);
  await assert.rejects(calendarFeed(second.token), { code: "NOT_FOUND" });
  assert.deepEqual(await revokeCalendar(viewer, { version: 3 }), disabled);
  await assert.rejects(
    rotateCalendar(
      await resolveViewer(undefined, randomBytes(32).toString("hex")),
      { version: 0, includeInvites: false },
    ),
    { code: "USER_SESSION" },
  );
});

test("subscriptions reject stale account sessions and feed credentials after account revocation", async () => {
  const { viewer } = await account();
  const subscription = await rotateCalendar(viewer, {
    version: 0,
    includeInvites: false,
  });
  await revokeUserSessions(viewer);
  await assert.rejects(calendarFeed(subscription.token), { code: "NOT_FOUND" });
  await assert.rejects(
    rotateCalendar(viewer, { version: 1, includeInvites: true }),
    { code: "USER_SESSION" },
  );
  const a = await account();
  const current = await rotateCalendar(a.viewer, {
    version: 0,
    includeInvites: false,
  });
  await db.user.update({
    where: { id: a.viewer.user!.id },
    data: { isActive: false },
  });
  await assert.rejects(calendarFeed(current.token), { code: "NOT_FOUND" });
});

test("calendar ranges, cancellation and ended updates are bounded and encode safe RFC fields without private data", async () => {
  const { viewer } = await account();
  const now = new Date();
  const r = await fixture(viewer.token!);
  const subscription = await rotateCalendar(viewer, {
    version: 0,
    includeInvites: false,
  });
  await db.gameReservation.update({
    where: { id: r.id },
    data: {
      status: "CANCELLED",
      revision: 27,
      gameName: "测试\r\nATTENDEE:bad;中文,\\",
      meetingCipher: "not-read-secret",
      scheduledAt: new Date(now.getTime() - 30 * 86400000),
    },
  });
  const rows = await calendarFeed(subscription.token, now);
  assert.equal(rows.length, 1);
  const content = subscriptionCalendar(rows, "https://party.example");
  assert.ok(content.includes("SEQUENCE:27\r\n"));
  assert.ok(content.includes("STATUS:CANCELLED"));
  assert.ok(!content.includes("\r\nATTENDEE:"));
  assert.ok(!content.includes("private-note-not-exported"));
  assert.ok(!content.includes("not-read-secret"));
  assert.ok(!content.includes(subscription.token));
  assert.ok(!content.includes("VALARM"));
  for (const line of content.split("\r\n"))
    assert.ok(Buffer.byteLength(line) <= 75);
  await db.gameReservation.update({
    where: { id: r.id },
    data: { scheduledAt: new Date(now.getTime() + 365 * 86400000) },
  });
  assert.equal((await calendarFeed(subscription.token, now)).length, 0);
  await db.gameReservation.update({
    where: { id: r.id },
    data: { scheduledAt: new Date(now.getTime() - 30 * 86400000 - 1) },
  });
  assert.equal((await calendarFeed(subscription.token, now)).length, 0);
});

test("concurrent link rotation has one winner and does not revive a lost response token", async () => {
  const { viewer } = await account();
  const results = await Promise.allSettled([
    rotateCalendar(viewer, { version: 0, includeInvites: false }),
    rotateCalendar(viewer, { version: 0, includeInvites: true }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await calendarSettings(viewer)).version, 1);
  await assert.rejects(
    rotateCalendar(viewer, { version: 0, includeInvites: false }),
    { code: "CALENDAR_CONFLICT" },
  );
});

test(
  "calendar HTTP credentials require no cookies and user management requires scope and same origin",
  { skip: !process.env.TEST_BASE_URL },
  async () => {
    const base = process.env.TEST_BASE_URL!,
      { viewer, auth } = await account();
    const r = await fixture(viewer.token!);
    const headers = {
      Cookie: `party_user=${auth.token}`,
      Origin: base,
      "Content-Type": "application/json",
      "X-Identity-Scope": viewer.scope,
    };
    const post = (extra = {}) =>
      fetch(base + "/api/user/calendar", {
        method: "POST",
        headers: { ...headers, ...extra },
        body: JSON.stringify({ version: 0, includeInvites: false }),
      });
    assert.equal((await post({ Origin: "https://other.example" })).status, 403);
    assert.equal((await post({ "X-Identity-Scope": "old" })).status, 409);
    const response = await post();
    assert.equal(response.status, 200);
    const { data } = await response.json();
    const url = `${base}/api/calendar?token=${data.token}`;
    const feed = await fetch(url);
    assert.equal(feed.status, 200);
    assert.equal(feed.headers.get("set-cookie"), null);
    assert.match(feed.headers.get("content-type")!, /text\/calendar/);
    assert.match(feed.headers.get("cache-control")!, /no-store/);
    assert.ok((await feed.text()).includes(`UID:${r.id}@party-up`));
    assert.equal((await fetch(url + "&token=" + data.token)).status, 400);
    assert.equal((await fetch(base + "/api/calendar?token=wrong")).status, 404);
    const state = await (
      await fetch(base + "/api/user/calendar", { headers })
    ).json();
    assert.equal(state.data.token, undefined);
  },
);
