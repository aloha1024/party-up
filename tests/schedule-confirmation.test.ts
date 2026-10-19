import "./support/isolated";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../server/db";
import {
  createReservation,
  detail,
  editReservation,
  joinReservation,
  joinWaitlist,
  leaveReservation,
  cancelReservation,
  deleteReservation,
  restoreReservation,
  purgeReservation,
  setRecruitment,
} from "../server/reservations";
import { setScheduleConfirmation } from "../server/reservation-schedule-confirmation";
import { setAttendance } from "../server/reservation-attendance";
import {
  acceptInvitation,
  currentInvitation,
  rotateInvitation,
} from "../server/reservation-invitations";
import { reservationHistory } from "../server/reservation-history";
import { reservationTemplate } from "../server/reservation-template";
import { registeredToken, testCookie } from "./support/member";
import { resolveViewer, viewerContext } from "../server/user-identity";

const ids: string[] = [],
  users: string[] = [];
const token = () => randomBytes(32).toString("hex");
const actor = { id: 330091, username: "schedule-confirmation-admin" };
async function fixture(options: Record<string, unknown> = {}, owner = token()) {
  const input = {
    gameName: "Reschedule-" + randomUUID(),
    hostName: "Host",
    maxPlayers: 4,
    description: "",
    scheduledAt: new Date(Date.now() + 600000).toISOString(),
    ...options,
  };
  const r = await createReservation(input, owner);
  ids.push(r.id);
  return { id: r.id, owner, input };
}
async function move(
  f: Awaited<ReturnType<typeof fixture>>,
  changes: Record<string, unknown> = {},
  administrator: typeof actor | null = null,
) {
  const current = await detail(f.id, f.owner);
  return editReservation(
    f.id,
    {
      gameName: current.gameName,
      hostName: current.hostName,
      scheduledAt: current.scheduledAt,
      description: current.description,
      maxPlayers: current.maxPlayers,
      editVersion: current.editVersion,
      ...changes,
    },
    f.owner,
    administrator,
  );
}
async function payload(id: string, who: string) {
  const r = await detail(id, who);
  return {
    participantId: r.participants.find((p) => p.isMe)!.id,
    scheduleVersion: r.scheduleVersion,
  };
}
async function mine(id: string, who: string) {
  return (await detail(id, who)).participants.find((p) => p.isMe)!;
}
after(async () => {
  await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
  await db.adminAuditLog.deleteMany({ where: { targetId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

test("actual rescheduling requires every existing member including the host to reconfirm; no-op edits and confirmations do not add events", async () => {
  const f = await fixture(),
    member = token();
  const joined = await joinReservation(
    f.id,
    { name: "Member", scheduleVersion: 0 },
    member,
  );
  assert.equal(joined.scheduleVersion, 0);
  assert.ok(
    joined.participants.every(
      (p) => p.scheduleConfirmed && !p.scheduleConfirmedAt,
    ),
  );
  const originalRows = await db.participant.findMany({
    where: { reservationId: f.id },
    orderBy: { id: "asc" },
  });
  const self = await mine(f.id, member);
  await setAttendance(
    f.id,
    {
      participantId: self.id,
      attendanceVersion: self.attendanceVersion,
      editVersion: 0,
      checkedIn: true,
    },
    member,
  );
  const unchanged = await move(f, { description: "ordinary edit" });
  assert.equal(unchanged.scheduleVersion, 0);
  assert.ok((await mine(f.id, member)).checkedInAt);
  const changed = await move(f, {
    scheduledAt: new Date(Date.now() + 1200000).toISOString(),
  });
  assert.equal(changed.scheduleVersion, 1);
  assert.equal(changed.participants.length, 2);
  assert.ok(
    changed.participants.every(
      (p) => !p.scheduleConfirmed && !p.scheduleConfirmedAt && !p.checkedInAt,
    ),
  );
  const afterRows = await db.participant.findMany({
    where: { reservationId: f.id },
    orderBy: { id: "asc" },
  });
  assert.deepEqual(
    afterRows.map((p) => [p.id, p.joinedAt, p.name]),
    originalRows.map((p) => [p.id, p.joinedAt, p.name]),
  );
  const history = await reservationHistory(f.id),
    notifications = await db.notification.findMany({
      where: { reservationId: f.id },
    });
  const request = await payload(f.id, member);
  const confirmed = await setScheduleConfirmation(f.id, request, member);
  const result = confirmed.participants.find((p) => p.isMe)!;
  assert.equal(result.scheduleConfirmed, true);
  assert.ok(result.scheduleConfirmedAt);
  assert.equal(result.checkedInAt, null);
  assert.equal(confirmed.editVersion, changed.editVersion);
  assert.equal(
    confirmed.participants.find((p) => p.isHost)!.scheduleConfirmed,
    false,
  );
  await setScheduleConfirmation(f.id, request, member);
  assert.equal(
    (await mine(f.id, member)).scheduleConfirmedAt,
    result.scheduleConfirmedAt,
  );
  assert.deepEqual(await reservationHistory(f.id), history);
  assert.deepEqual(
    await db.notification.findMany({ where: { reservationId: f.id } }),
    notifications,
  );
  assert.equal(notifications.filter((n) => n.kind === "RESCHEDULED").length, 1);
  await move(f, { description: "another edit" });
  assert.equal(
    (await mine(f.id, member)).scheduleConfirmedAt,
    result.scheduleConfirmedAt,
  );
  const attendance = await detail(f.id, member);
  await setAttendance(
    f.id,
    {
      participantId: self.id,
      attendanceVersion: attendance.participants.find((p) => p.isMe)!
        .attendanceVersion,
      editVersion: attendance.editVersion,
      checkedIn: true,
    },
    member,
  );
  await setScheduleConfirmation(f.id, await payload(f.id, f.owner), f.owner);
  assert.ok((await mine(f.id, member)).checkedInAt);
});

test("schedule generations reject A to B to A responses and new roster IDs reject requests from a previous signup", async () => {
  const f = await fixture(),
    member = token();
  await joinReservation(f.id, { name: "Member", scheduleVersion: 0 }, member);
  const first = await payload(f.id, member);
  await move(f, { scheduledAt: new Date(Date.now() + 3600000).toISOString() });
  const second = await payload(f.id, member);
  await setScheduleConfirmation(f.id, second, member);
  await move(f, { scheduledAt: f.input.scheduledAt });
  const current = await detail(f.id, member);
  assert.equal(current.scheduleVersion, 2);
  assert.equal(
    current.participants.find((p) => p.isMe)!.scheduleConfirmedAt,
    null,
  );
  for (const stale of [first, second])
    await assert.rejects(setScheduleConfirmation(f.id, stale, member), {
      code: "SCHEDULE_CONFLICT",
    });
  const oldRoster = await payload(f.id, member);
  await leaveReservation(f.id, member);
  const rejoined = await joinReservation(
    f.id,
    { name: "Member", scheduleVersion: 2 },
    member,
  );
  assert.notEqual(
    rejoined.participants.find((p) => p.isMe)!.id,
    oldRoster.participantId,
  );
  assert.equal(
    rejoined.participants.find((p) => p.isMe)!.scheduleConfirmed,
    true,
  );
  await assert.rejects(setScheduleConfirmation(f.id, oldRoster, member), {
    code: "ROSTER_CHANGED",
  });
  await assert.rejects(
    joinReservation(f.id, { name: "Stale", scheduleVersion: 1 }, token()),
    { code: "SCHEDULE_CONFLICT" },
  );
  const legacy = token();
  await joinReservation(f.id, { name: "Legacy" }, legacy);
  assert.equal((await mine(f.id, legacy)).scheduleConfirmed, false);
  const ordinary = await fixture();
  await joinReservation(ordinary.id, { name: "Old client" }, member);
  assert.equal((await mine(ordinary.id, member)).scheduleConfirmed, true);
});

test("waitlist promotion preserves the schedule accepted on entry and does not silently reconfirm an older waiter", async () => {
  const f = await fixture({ maxPlayers: 2 }),
    member = token(),
    oldWaiter = token(),
    newWaiter = token();
  await joinReservation(f.id, { name: "Member", scheduleVersion: 0 }, member);
  await joinWaitlist(
    f.id,
    { name: "Old waiter", scheduleVersion: 0 },
    oldWaiter,
  );
  const before = await db.waitlistEntry.findFirstOrThrow({
    where: { reservationId: f.id },
  });
  await move(f, { scheduledAt: new Date(Date.now() + 3600000).toISOString() });
  await assert.rejects(
    joinWaitlist(f.id, { name: "Stale waiter", scheduleVersion: 0 }, token()),
    { code: "SCHEDULE_CONFLICT" },
  );
  await joinWaitlist(
    f.id,
    { name: "New waiter", scheduleVersion: 1 },
    newWaiter,
  );
  const waiting = await db.waitlistEntry.findMany({
    where: { reservationId: f.id },
    orderBy: { id: "asc" },
  });
  assert.deepEqual(waiting[0], before);
  await assert.rejects(
    setScheduleConfirmation(f.id, await payload(f.id, member), oldWaiter),
    { code: "ROSTER_CHANGED" },
  );
  await leaveReservation(f.id, member);
  assert.equal((await mine(f.id, oldWaiter)).scheduleConfirmed, false);
  assert.equal((await mine(f.id, oldWaiter)).scheduleConfirmedAt, null);
  await leaveReservation(f.id, f.owner);
  assert.equal((await mine(f.id, newWaiter)).scheduleConfirmed, true);
  assert.equal((await mine(f.id, newWaiter)).scheduleConfirmedAt, null);
  assert.equal((await detail(f.id)).waitlist.length, 0);
  assert.equal((await detail(f.id)).participants.length, 2);
});

test("confirmation is self-only, open until the exact start, independent of recruitment closure and retained after cancellation or deletion", async (t) => {
  const f = await fixture(),
    member = token();
  await joinReservation(f.id, { name: "Member", scheduleVersion: 0 }, member);
  await move(f, { scheduledAt: new Date(Date.now() + 3600000).toISOString() });
  const r = await detail(f.id, member),
    request = await payload(f.id, member);
  await assert.rejects(setScheduleConfirmation(f.id, request, f.owner), {
    code: "ROSTER_CHANGED",
  });
  await assert.rejects(setScheduleConfirmation(f.id, request, token()), {
    code: "ROSTER_CHANGED",
  });
  await setRecruitment(
    f.id,
    { paused: true, editVersion: r.editVersion },
    f.owner,
  );
  await db.gameReservation.update({
    where: { id: f.id },
    data: { registrationDeadline: new Date(Date.now() - 1) },
  });
  await setScheduleConfirmation(f.id, request, member);
  assert.ok((await mine(f.id, member)).scheduleConfirmedAt);
  const beforeStart = await payload(f.id, f.owner);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(r.scheduledAt) - 1 });
  try {
    await setScheduleConfirmation(f.id, beforeStart, f.owner);
    t.mock.timers.setTime(Date.parse(r.scheduledAt));
    await assert.rejects(setScheduleConfirmation(f.id, beforeStart, f.owner), {
      code: "SCHEDULE_CLOSED",
    });
  } finally {
    t.mock.timers.reset();
  }
  await cancelReservation(f.id, { reason: "cancelled" }, f.owner);
  await assert.rejects(setScheduleConfirmation(f.id, request, member), {
    code: "SCHEDULE_CLOSED",
  });
  assert.equal((await mine(f.id, member)).scheduleConfirmed, true);
  await deleteReservation(f.id, actor);
  await assert.rejects(setScheduleConfirmation(f.id, request, member), {
    status: 404,
  });
  await restoreReservation(f.id, actor);
  assert.equal((await mine(f.id, member)).scheduleConfirmed, true);
  await db.gameReservation.update({
    where: { id: f.id },
    data: { status: "ENDED" },
  });
  await assert.rejects(setScheduleConfirmation(f.id, request, member), {
    code: "SCHEDULE_CLOSED",
  });
  await deleteReservation(f.id, actor);
  await purgeReservation(f.id, actor);
  assert.equal(
    await db.participant.count({ where: { reservationId: f.id } }),
    0,
  );
});

test("invitation and current account guards apply while copied reservations start independently confirmed", async () => {
  const owner = await registeredToken(),
    member = token(),
    f = await fixture({ visibility: "INVITE" }, owner);
  const ownerViewer = await resolveViewer(testCookie(owner).split("=")[1]);
  users.push(ownerViewer.user!.id);
  const link = await currentInvitation(f.id, owner);
  await acceptInvitation(
    f.id,
    { token: link.path.split("#invite=")[1] },
    member,
  );
  await joinReservation(f.id, { name: "Member", scheduleVersion: 0 }, member);
  await move(f, { scheduledAt: new Date(Date.now() + 3600000).toISOString() });
  await rotateInvitation(f.id, { expectedVersion: link.version }, owner);
  const request = await payload(f.id, member);
  await assert.rejects(setScheduleConfirmation(f.id, request, token()), {
    code: "INVITATION_REQUIRED",
  });
  await setScheduleConfirmation(f.id, request, member);
  const template = await reservationTemplate(f.id, owner);
  assert.equal("scheduleVersion" in template, false);
  const copy = await createReservation(
    { ...template, scheduledAt: f.input.scheduledAt },
    owner,
  );
  ids.push(copy.id);
  assert.equal(copy.scheduleVersion, 0);
  assert.equal(copy.participants.length, 1);
  assert.equal(copy.participants[0].scheduleConfirmed, true);
  assert.equal(copy.participants[0].scheduleConfirmedAt, null);
  const oldRequest = await payload(f.id, owner);
  await db.user.update({
    where: { id: ownerViewer.user!.id },
    data: { isActive: false },
  });
  await assert.rejects(
    viewerContext.run(ownerViewer, () =>
      setScheduleConfirmation(f.id, oldRequest, owner),
    ),
    { code: "USER_SESSION" },
  );
  assert.equal(
    (
      await db.participant.findUniqueOrThrow({
        where: { id: oldRequest.participantId },
      })
    ).acceptedScheduleVersion,
    0,
  );
});

test("concurrent confirmations are idempotent and rescheduling or leaving never applies confirmation to another generation or roster entry", async () => {
  const f = await fixture(),
    member = token();
  await joinReservation(f.id, { name: "Member", scheduleVersion: 0 }, member);
  await move(f, { scheduledAt: new Date(Date.now() + 3600000).toISOString() });
  const request = await payload(f.id, member);
  const duplicate = await Promise.all([
    setScheduleConfirmation(f.id, request, member),
    setScheduleConfirmation(f.id, request, member),
  ]);
  assert.equal(
    duplicate[0].participants.find((p) => p.isMe)!.scheduleConfirmedAt,
    duplicate[1].participants.find((p) => p.isMe)!.scheduleConfirmedAt,
  );
  const hostRequest = await payload(f.id, f.owner);
  const raced = await Promise.allSettled([
    setScheduleConfirmation(f.id, hostRequest, f.owner),
    move(f, { scheduledAt: new Date(Date.now() + 7200000).toISOString() }),
  ]);
  assert.equal(raced[1].status, "fulfilled");
  assert.equal((await mine(f.id, f.owner)).scheduleConfirmed, false);
  assert.equal((await mine(f.id, member)).scheduleConfirmed, false);
  const latest = await payload(f.id, member);
  const left = await Promise.allSettled([
    setScheduleConfirmation(f.id, latest, member),
    leaveReservation(f.id, member),
  ]);
  assert.equal(left[1].status, "fulfilled");
  assert.equal(
    (await detail(f.id, member)).participants.some((p) => p.isMe),
    false,
  );
  await joinReservation(f.id, { name: "Member", scheduleVersion: 2 }, member);
  await assert.rejects(setScheduleConfirmation(f.id, latest, member), {
    code: "ROSTER_CHANGED",
  });
});

test("history, notification and administrator audit failures roll back rescheduling, attendance clearing and confirmation generation together", async () => {
  const f = await fixture(),
    member = token();
  await joinReservation(f.id, { name: "Member", scheduleVersion: 0 }, member);
  await move(f, { scheduledAt: new Date(Date.now() + 1200000).toISOString() });
  await setScheduleConfirmation(f.id, await payload(f.id, member), member);
  const r = await detail(f.id, member),
    p = r.participants.find((p) => p.isMe)!;
  await setAttendance(
    f.id,
    {
      participantId: p.id,
      attendanceVersion: p.attendanceVersion,
      editVersion: r.editVersion,
      checkedIn: true,
    },
    member,
  );
  for (const table of ["ReservationChange", "Notification", "AdminAuditLog"]) {
    const before = await detail(f.id, f.owner),
      stored = await db.participant.findMany({
        where: { reservationId: f.id },
        orderBy: { id: "asc" },
      });
    const history = await reservationHistory(f.id),
      notifications = await db.notification.findMany({
        where: { reservationId: f.id },
        orderBy: { id: "asc" },
      });
    await db.$executeRawUnsafe(
      `CREATE TRIGGER fail_schedule_confirmation BEFORE INSERT ON "${table}" BEGIN SELECT RAISE(ABORT,'schedule test rollback'); END`,
    );
    try {
      await assert.rejects(
        move(
          f,
          { scheduledAt: new Date(Date.now() + 3600000).toISOString() },
          table === "AdminAuditLog" ? actor : null,
        ),
      );
      assert.deepEqual(await detail(f.id, f.owner), before);
      assert.deepEqual(
        await db.participant.findMany({
          where: { reservationId: f.id },
          orderBy: { id: "asc" },
        }),
        stored,
      );
      assert.deepEqual(await reservationHistory(f.id), history);
      assert.deepEqual(
        await db.notification.findMany({
          where: { reservationId: f.id },
          orderBy: { id: "asc" },
        }),
        notifications,
      );
    } finally {
      await db.$executeRawUnsafe("DROP TRIGGER fail_schedule_confirmation");
    }
  }
});
