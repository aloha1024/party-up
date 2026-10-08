import "./support/isolated";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../server/db";
import { adminStatistics } from "../server/admin-statistics";
import {
  adminStatisticsSchema,
  statisticsBounds,
} from "../lib/admin-statistics";
import { ADMIN_COOKIE, createAdminSession } from "../server/admin-auth";
import { ensureAdminRecord } from "../server/admin";
import { registeredToken, testCookie } from "./support/member";

const reservationIds: string[] = [],
  userIds: string[] = [],
  adminIds: number[] = [];
const now = new Date("2045-03-01T04:00:00.000Z");
async function seed(
  time: Date,
  options: {
    status?: string;
    participants?: number;
    waitlist?: number;
    checkedIn?: number;
    deleted?: boolean;
    invite?: boolean;
  } = {},
) {
  const id = randomUUID();
  reservationIds.push(id);
  return db.gameReservation.create({
    data: {
      id,
      gameName: "Statistics private title " + id,
      hostName: "Private host",
      maxPlayers: 100,
      description: "Statistics private notes",
      meetingCipher: "never-selected",
      scheduledAt: time,
      status: options.status ?? "OPEN",
      visibility: options.invite ? "INVITE" : "PUBLIC",
      deletedAt: options.deleted ? now : null,
      participants: {
        create: Array.from(
          { length: options.participants ?? 0 },
          (_, index) => ({
            name: `Member${index}`,
            nameKey: `member${index}`,
            tokenHash: randomBytes(32).toString("hex"),
            checkedInAt: index < (options.checkedIn ?? 0) ? now : null,
          }),
        ),
      },
      waitlist: {
        create: Array.from({ length: options.waitlist ?? 0 }, (_, index) => ({
          name: `Waiter${index}`,
          nameKey: `waiter${index}`,
          tokenHash: randomBytes(32).toString("hex"),
        })),
      },
    },
  });
}
after(async () => {
  await db.gameReservation.deleteMany({
    where: { id: { in: reservationIds } },
  });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.adminCredential.deleteMany({ where: { id: { in: adminIds } } });
  await db.$disconnect();
});

test("statistics ranges are Beijing calendar windows including today and reject duplicate or unknown filters", () => {
  const beforeMidnight = new Date("2032-03-01T15:59:59.999Z");
  assert.deepEqual(statisticsBounds("today", beforeMidnight), {
    start: new Date("2032-02-29T16:00:00.000Z"),
    end: new Date("2032-03-01T16:00:00.000Z"),
  });
  assert.deepEqual(statisticsBounds("week", beforeMidnight), {
    start: new Date("2032-02-23T16:00:00.000Z"),
    end: new Date("2032-03-01T16:00:00.000Z"),
  });
  assert.deepEqual(statisticsBounds("month", beforeMidnight), {
    start: new Date("2032-01-31T16:00:00.000Z"),
    end: new Date("2032-03-01T16:00:00.000Z"),
  });
  assert.deepEqual(
    statisticsBounds("today", new Date("2032-03-01T16:00:00.000Z")),
    {
      start: new Date("2032-03-01T16:00:00.000Z"),
      end: new Date("2032-03-02T16:00:00.000Z"),
    },
  );
  assert.deepEqual(adminStatisticsSchema.parse({}), { range: "month" });
  for (const input of [
    { range: "year" },
    { range: ["today", "week"] },
    { range: "" },
    { q: "private" },
  ])
    assert.equal(adminStatisticsSchema.safeParse(input).success, false);
});

test("aggregate statistics count exact boundaries and current rosters once, including invitation and closed reservations but excluding trash", async () => {
  const start = new Date("2045-02-28T16:00:00.000Z"),
    end = new Date("2045-03-01T16:00:00.000Z");
  const baseline = await adminStatistics({ range: "today" }, now);
  const first = await seed(start, {
    participants: 2,
    checkedIn: 1,
    waitlist: 1,
  });
  await seed(now, { participants: 3, checkedIn: 2, waitlist: 2 });
  await seed(new Date(now.getTime() + 1), { participants: 1 });
  await seed(new Date(end.getTime() - 1), {
    status: "CANCELLED",
    participants: 4,
    checkedIn: 1,
    waitlist: 1,
  });
  await seed(new Date(now.getTime() - 1000), {
    status: "ENDED",
    participants: 5,
    checkedIn: 3,
    waitlist: 3,
  });
  await seed(new Date(now.getTime() - 1), {
    invite: true,
    participants: 2,
    checkedIn: 1,
    waitlist: 1,
  });
  await seed(new Date(start.getTime() - 1), {
    participants: 40,
    checkedIn: 40,
    waitlist: 40,
  });
  await seed(end, { participants: 40, checkedIn: 40, waitlist: 40 });
  await seed(now, {
    deleted: true,
    participants: 40,
    checkedIn: 40,
    waitlist: 40,
  });
  const result = await adminStatistics({ range: "today" }, now);
  assert.deepEqual(result.reservations, {
    total: baseline.reservations.total + 6,
    upcoming: baseline.reservations.upcoming + 1,
    started: baseline.reservations.started + 3,
    ended: baseline.reservations.ended + 1,
    cancelled: baseline.reservations.cancelled + 1,
  });
  assert.deepEqual(result.roster, {
    participants: baseline.roster.participants + 17,
    waitlist: baseline.roster.waitlist + 8,
    checkedIn: baseline.roster.checkedIn + 8,
  });
  assert.equal(
    result.reservations.total,
    result.reservations.upcoming +
      result.reservations.started +
      result.reservations.ended +
      result.reservations.cancelled,
  );
  assert.equal(result.asOf, now.toISOString());
  assert.equal(result.start, start.toISOString());
  assert.equal(result.end, end.toISOString());
  assert.equal(JSON.stringify(result).includes("Private"), false);
  assert.equal(JSON.stringify(result).includes(first.id), false);
  await db.participant.deleteMany({
    where: { reservationId: first.id, checkedInAt: { not: null } },
  });
  const updated = await adminStatistics({ range: "today" }, now);
  assert.equal(updated.roster.participants, result.roster.participants - 1);
  assert.equal(updated.roster.checkedIn, result.roster.checkedIn - 1);
  assert.deepEqual(updated.reservations, result.reservations);
});

test("global ordinary account totals are independent of the selected range, creation time and administrator accounts", async () => {
  const baseline = await adminStatistics({}, now);
  for (const isActive of [true, true, false]) {
    const user = await db.user.create({
      data: {
        username: "statistics_" + randomUUID(),
        nickname: "Statistics user",
        passwordHash: "unused",
        isActive,
        createdAt: new Date("2001-01-01T00:00:00Z"),
      },
    });
    userIds.push(user.id);
  }
  for (const range of ["today", "week", "month"]) {
    const result = await adminStatistics({ range }, now);
    assert.deepEqual(result.accounts, {
      total: baseline.accounts.total + 3,
      active: baseline.accounts.active + 2,
    });
  }
  const empty = await adminStatistics(
    { range: "today" },
    new Date("1971-01-01T00:00:00Z"),
  );
  assert.deepEqual(empty.reservations, {
    total: 0,
    upcoming: 0,
    started: 0,
    ended: 0,
    cancelled: 0,
  });
  assert.deepEqual(empty.roster, {
    participants: 0,
    waitlist: 0,
    checkedIn: 0,
  });
  assert.deepEqual(empty.accounts, {
    total: baseline.accounts.total + 3,
    active: baseline.accounts.active + 2,
  });
});

test("seven-day and thirty-day ranges include their first calendar day and exclude tomorrow", async () => {
  const snapshot = new Date("2051-06-15T04:00:00.000Z");
  const before = await Promise.all(
    ["today", "week", "month"].map((range) =>
      adminStatistics({ range }, snapshot),
    ),
  );
  for (const time of [
    "2051-06-14T16:00:00.000Z", // Today.
    "2051-06-08T16:00:00.000Z", // First day of the seven-day window.
    "2051-06-08T15:59:59.999Z", // In the thirty-day window only.
    "2051-05-16T16:00:00.000Z", // First day of the thirty-day window.
    "2051-05-16T15:59:59.999Z", // Older than every window.
    "2051-06-15T16:00:00.000Z", // Tomorrow.
  ])
    await seed(new Date(time));
  const after = await Promise.all(
    ["today", "week", "month"].map((range) =>
      adminStatistics({ range }, snapshot),
    ),
  );
  assert.deepEqual(
    after.map(
      (result, index) =>
        result.reservations.total - before[index].reservations.total,
    ),
    [1, 2, 4],
  );
});

test(
  "statistics page permits current regular administrators and rejects ordinary users, revoked, disabled and forced-password sessions",
  { skip: !process.env.TEST_BASE_URL },
  async () => {
    const base = process.env.TEST_BASE_URL!;
    await ensureAdminRecord();
    const admin = await db.adminCredential.create({
      data: {
        username: "statistics_" + randomUUID(),
        passwordHash: "unused",
        mustChangePassword: false,
      },
    });
    adminIds.push(admin.id);
    const cookie = `${ADMIN_COOKIE}=${createAdminSession(admin.id, admin.sessionVersion)}`;
    const html = await (
      await fetch(`${base}/admin/statistics?range=today`, {
        headers: { Cookie: cookie },
      })
    ).text();
    assert.ok(html.includes("预约状态概览"));
    assert.ok(html.includes("全站当前账号概览"));
    assert.ok(html.includes("不受上方日期范围限制"));
    assert.ok(html.includes("不是历史累计报名数"));
    for (const query of ["range=year", "range=today&range=week"]) {
      const invalid = await (
        await fetch(`${base}/admin/statistics?${query}`, {
          headers: { Cookie: cookie },
        })
      ).text();
      assert.ok(invalid.includes("统计范围无效"));
      assert.equal(invalid.includes("预约状态概览"), false);
    }
    for (const value of [
      "",
      testCookie(await registeredToken()),
      `${ADMIN_COOKIE}=invalid`,
    ]) {
      const hidden = await (
        await fetch(`${base}/admin/statistics`, { headers: { Cookie: value } })
      ).text();
      assert.equal(hidden.includes("预约状态概览"), false);
      assert.equal(hidden.includes("全站当前账号概览"), false);
    }
    for (const data of [
      { isActive: false },
      { isActive: true, mustChangePassword: true },
      { mustChangePassword: false, sessionVersion: 1 },
    ]) {
      await db.adminCredential.update({ where: { id: admin.id }, data });
      const hidden = await (
        await fetch(`${base}/admin/statistics`, { headers: { Cookie: cookie } })
      ).text();
      assert.equal(hidden.includes("预约状态概览"), false);
    }
  },
);
