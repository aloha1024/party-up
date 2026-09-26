import "./support/isolated";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { db } from "../server/db";
import {
  createReservation,
  detail,
  joinReservation,
  joinWaitlist,
  leaveReservation,
  leaveWaitlist,
  editReservation,
  cancelReservation,
  removeRosterEntry,
  renameRosterEntry,
  deleteReservation,
  restoreReservation,
  purgeReservation,
  hashToken,
} from "../server/reservations";
import { setAttendance, setCompletion } from "../server/reservation-attendance";
import {
  listReservations,
  listAdminReservations,
  listMyReservations,
} from "../server/reservation-list";
import { reservationHistory } from "../server/reservation-history";
import { calendarReservation } from "../server/reservation-calendar";
import { reservationTemplate } from "../server/reservation-template";
import {
  currentInvitation,
  acceptInvitation,
  rotateInvitation,
} from "../server/reservation-invitations";
import { reservationShareText } from "../lib/reservation-share";
import { attendanceOpensAt } from "../lib/reservation-attendance";
import { ADMIN_COOKIE, createAdminSession } from "../server/admin-auth";
const token = () => randomBytes(32).toString("hex");
const ids: string[] = [];
const actor = { id: 300001, username: "attendance-admin", sessionVersion: 0 };
async function fixture(invite = false) {
  const owner = token(),
    guest = token();
  const input = {
    gameName: "Attendance-" + token().slice(0, 8),
    hostName: "Host",
    maxPlayers: 2,
    description: "",
    scheduledAt: new Date(Date.now() + 600000).toISOString(),
  };
  const r = await createReservation(
    { ...input, visibility: invite ? "INVITE" : "PUBLIC" },
    owner,
  );
  ids.push(r.id);
  if (invite) {
    const link = await currentInvitation(r.id, owner);
    await acceptInvitation(
      r.id,
      { token: link.path.split("#invite=")[1] },
      guest,
    );
  }
  await joinReservation(r.id, { name: "Guest" }, guest);
  return { id: r.id, owner, guest, input };
}
async function payload(id: string, token: string, checkedIn = true) {
  const r = await detail(id, token),
    p = r.participants.find((p) => p.isMe)!;
  return {
    participantId: p.id,
    attendanceVersion: p.attendanceVersion,
    editVersion: r.editVersion,
    checkedIn,
  };
}
after(async () => {
  await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
  await db.adminAuditLog.deleteMany({ where: { targetId: { in: ids } } });
  await db.adminCredential.deleteMany({ where: { id: actor.id } });
  await db.$disconnect();
});
test("attendance is self-only, windowed, versioned and retains original confirmation timestamp on a no-op", async () => {
  const f = await fixture();
  const first = await payload(f.id, f.guest);
  await assert.rejects(setAttendance(f.id, first, token()), {
    code: "ROSTER_CHANGED",
  });
  const checked = await setAttendance(f.id, first, f.guest);
  const p = checked.participants.find((p) => p.isMe)!;
  assert.ok(p.checkedInAt);
  assert.equal(p.attendanceVersion, 1);
  assert.equal(checked.editVersion, 0);
  assert.equal((await reservationHistory(f.id)).items.length, 0);
  await assert.rejects(setAttendance(f.id, first, f.guest), {
    code: "ATTENDANCE_CONFLICT",
  });
  const noOp = await setAttendance(f.id, await payload(f.id, f.guest), f.guest);
  assert.equal(
    noOp.participants.find((p) => p.isMe)!.checkedInAt,
    p.checkedInAt,
  );
  const cleared = await setAttendance(
    f.id,
    await payload(f.id, f.guest, false),
    f.guest,
  );
  assert.equal(cleared.participants.find((p) => p.isMe)!.checkedInAt, null);
  const before = await payload(f.id, f.guest);
  await leaveReservation(f.id, f.guest);
  await joinReservation(f.id, { name: "Guest" }, f.guest);
  await assert.rejects(setAttendance(f.id, before, f.guest), {
    code: "ROSTER_CHANGED",
  });
  const waiter = token();
  await joinWaitlist(f.id, { name: "Waiter" }, waiter);
  await assert.rejects(
    setAttendance(f.id, await payload(f.id, f.owner), waiter),
    { code: "ROSTER_CHANGED" },
  );
  await leaveReservation(f.id, f.guest);
  assert.equal(
    (await detail(f.id, waiter)).participants.find((p) => p.isMe)!.checkedInAt,
    null,
  );
});
test("exact opening boundary and rescheduling clear confirmations atomically; unrelated edits preserve them", async (t) => {
  const f = await fixture();
  const opens = attendanceOpensAt(f.input.scheduledAt).getTime();
  t.mock.timers.enable({ apis: ["Date"], now: opens - 1 });
  try {
    await assert.rejects(
      setAttendance(f.id, await payload(f.id, f.owner), f.owner),
      { code: "ATTENDANCE_EARLY" },
    );
    t.mock.timers.setTime(opens);
    await setAttendance(f.id, await payload(f.id, f.owner), f.owner);
  } finally {
    t.mock.timers.reset();
  }
  const saved = (await detail(f.id, f.owner)).participants.find(
    (p) => p.isMe,
  )!.checkedInAt;
  await editReservation(
    f.id,
    { ...f.input, description: "updated", editVersion: 0 },
    f.owner,
  );
  assert.equal(
    (await detail(f.id, f.owner)).participants.find((p) => p.isMe)!.checkedInAt,
    saved,
  );
  const stale = await payload(f.id, f.owner, false);
  await editReservation(
    f.id,
    {
      ...f.input,
      scheduledAt: new Date(Date.now() + 3600000).toISOString(),
      editVersion: 1,
    },
    f.owner,
  );
  assert.equal(
    (await detail(f.id, f.owner)).participants.find((p) => p.isMe)!.checkedInAt,
    null,
  );
  await assert.rejects(setAttendance(f.id, stale, f.owner), {
    code: "ATTENDANCE_CONFLICT",
  });
});
test("completion and reopening preserve attendance, lock roster actions, expose history and support recycle/copy", async () => {
  const f = await fixture();
  await setAttendance(f.id, await payload(f.id, f.owner), f.owner);
  await assert.rejects(setCompletion(f.id, { editVersion: 0 }, f.owner, true), {
    code: "COMPLETION_STATE",
  });
  await db.gameReservation.update({
    where: { id: f.id },
    data: { scheduledAt: new Date(Date.now() - 10000) },
  });
  await assert.rejects(setCompletion(f.id, { editVersion: 0 }, f.guest, true), {
    code: "FORBIDDEN",
  });
  const ended = await setCompletion(f.id, { editVersion: 0 }, f.owner, true);
  assert.equal(ended.status, "ENDED");
  assert.ok(ended.endedAt);
  assert.ok(ended.participants.find((p) => p.isMe)!.checkedInAt);
  await assert.rejects(setCompletion(f.id, { editVersion: 0 }, f.owner, true), {
    code: "EDIT_CONFLICT",
  });
  for (const op of [
    () => setAttendance(f.id, awaitPayload(ended), f.owner),
    () => joinReservation(f.id, { name: "New" }, token()),
    () => leaveReservation(f.id, f.guest),
    () => cancelReservation(f.id, { reason: "x" }, f.owner),
    () => editReservation(f.id, { ...f.input, editVersion: 1 }, f.owner),
    () =>
      renameRosterEntry(
        f.id,
        "participants",
        {
          entryId: ended.participants[0].id,
          expectedName: "Host",
          name: "Next",
        },
        f.owner,
      ),
    () =>
      removeRosterEntry(
        f.id,
        {
          kind: "participants",
          entryId: ended.participants[1].id,
          expectedName: "Guest",
          reason: "x",
        },
        f.owner,
      ),
    () => calendarReservation(f.id, f.owner),
  ])
    await assert.rejects(op);
  assert.equal(
    (await listReservations({ view: "ended", q: f.input.gameName })).total,
    1,
  );
  assert.equal(
    (await listReservations({ view: "started", q: f.input.gameName })).total,
    0,
  );
  assert.equal(
    (await listReservations({ view: "available", q: f.input.gameName })).total,
    0,
  );
  assert.equal(
    (
      await listMyReservations({ view: "ended", tab: "joined" }, f.guest)
    ).items.some((r) => r.id === f.id),
    true,
  );
  const share = reservationShareText(ended, "https://example.test");
  assert.ok(share.includes("已结束"));
  assert.ok(!share.includes("已到场"));
  const template = await reservationTemplate(f.id, f.owner);
  assert.ok(!("endedAt" in template));
  const copy = await createReservation(
    { ...template, scheduledAt: f.input.scheduledAt },
    f.owner,
  );
  ids.push(copy.id);
  assert.equal(copy.endedAt, null);
  assert.equal(copy.participants[0].checkedInAt, null);
  await deleteReservation(f.id, actor);
  await assert.rejects(
    setCompletion(f.id, { editVersion: 1 }, f.owner, false),
    { status: 404 },
  );
  await restoreReservation(f.id, actor);
  assert.equal((await detail(f.id)).status, "ENDED");
  const reopened = await setCompletion(
    f.id,
    { editVersion: 1 },
    f.owner,
    false,
    actor,
  );
  assert.equal(reopened.status, "STARTED");
  assert.equal(reopened.endedAt, null);
  assert.ok(reopened.participants.find((p) => p.isMe)!.checkedInAt);
  assert.deepEqual(
    (await reservationHistory(f.id)).items.map((r) => [r.action, r.actorRole]),
    [
      ["REOPEN", "ADMIN"],
      ["END", "HOST"],
    ],
  );
  await setAttendance(f.id, await payload(f.id, f.owner, false), f.owner);
});
function awaitPayload(r: Awaited<ReturnType<typeof detail>>) {
  const p = r.participants.find((p) => p.isMe)!;
  return {
    participantId: p.id,
    attendanceVersion: p.attendanceVersion,
    editVersion: r.editVersion,
    checkedIn: false,
  };
}
test("invited members retain attendance permission after rotation; unauthorized visitors see no data; cancelled and ended waiters may leave", async () => {
  const f = await fixture(true),
    waiter = token();
  const link = await currentInvitation(f.id, f.owner);
  await acceptInvitation(
    f.id,
    { token: link.path.split("#invite=")[1] },
    waiter,
  );
  await joinWaitlist(f.id, { name: "Waiter" }, waiter);
  await rotateInvitation(f.id, { expectedVersion: 1 }, f.owner);
  await setAttendance(f.id, await payload(f.id, f.guest), f.guest);
  await assert.rejects(
    setAttendance(f.id, await payload(f.id, f.owner), token()),
    { status: 404 },
  );
  await db.gameReservation.update({
    where: { id: f.id },
    data: { scheduledAt: new Date(0) },
  });
  await setCompletion(f.id, { editVersion: 0 }, f.owner, true);
  await leaveWaitlist(f.id, waiter);
  assert.equal(
    (await listReservations({ view: "ended", q: f.input.gameName })).total,
    0,
  );
  assert.equal(
    (await listAdminReservations({ view: "ended", q: f.input.gameName })).total,
    1,
  );
  await deleteReservation(f.id, actor);
  await purgeReservation(f.id, actor);
  assert.equal(
    await db.participant.count({ where: { reservationId: f.id } }),
    0,
  );
  const cancelled = await fixture();
  await cancelReservation(
    cancelled.id,
    { reason: "cancelled" },
    cancelled.owner,
  );
  await assert.rejects(
    setAttendance(
      cancelled.id,
      await payload(cancelled.id, cancelled.owner),
      cancelled.owner,
    ),
    { code: "ATTENDANCE_CLOSED" },
  );
});

test("concurrent attendance, rescheduling, removal and completion remain serialized", async () => {
  const f = await fixture();
  const initial = await payload(f.id, f.guest);
  const confirmations = await Promise.allSettled([
    setAttendance(f.id, initial, f.guest),
    setAttendance(f.id, initial, f.guest),
  ]);
  assert.equal(confirmations.filter((r) => r.status === "fulfilled").length, 1);
  const checked = await payload(f.id, f.guest, false);
  const moved = await Promise.allSettled([
    setAttendance(f.id, checked, f.guest),
    editReservation(
      f.id,
      {
        ...f.input,
        scheduledAt: new Date(Date.now() + 7200000).toISOString(),
        editVersion: 0,
      },
      f.owner,
    ),
  ]);
  assert.equal(moved[1].status, "fulfilled");
  assert.equal(
    (await detail(f.id, f.guest)).participants.find((p) => p.isMe)!.checkedInAt,
    null,
  );
  await db.gameReservation.update({
    where: { id: f.id },
    data: { scheduledAt: new Date(Date.now() + 600000) },
  });
  const remove = await payload(f.id, f.guest),
    guest = (await detail(f.id, f.guest)).participants.find((p) => p.isMe)!;
  const removed = await Promise.allSettled([
    setAttendance(f.id, remove, f.guest),
    removeRosterEntry(
      f.id,
      {
        kind: "participants",
        entryId: guest.id,
        expectedName: guest.name,
        reason: "race",
      },
      f.owner,
    ),
  ]);
  assert.equal(removed[1].status, "fulfilled");
  assert.equal((await detail(f.id)).participants.length, 1);
  await db.gameReservation.update({
    where: { id: f.id },
    data: { scheduledAt: new Date(0) },
  });
  const host = await payload(f.id, f.owner);
  const ended = await Promise.allSettled([
    setAttendance(f.id, host, f.owner),
    setCompletion(f.id, { editVersion: 1 }, f.owner, true),
  ]);
  assert.equal(ended[1].status, "fulfilled");
  assert.equal((await detail(f.id)).status, "ENDED");
  const competing = await Promise.allSettled([
    setCompletion(f.id, { editVersion: 2 }, f.owner, false),
    setCompletion(f.id, { editVersion: 2 }, f.owner, false),
  ]);
  assert.equal(competing.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    (await reservationHistory(f.id)).items.filter((r) => r.action === "REOPEN")
      .length,
    1,
  );
});
test("failed history or audit writes roll back completion and rescheduling attendance resets", async () => {
  const f = await fixture();
  await setAttendance(f.id, await payload(f.id, f.owner), f.owner);
  const original = await detail(f.id, f.owner);
  await db.$executeRawUnsafe(
    `CREATE TRIGGER fail_attendance_history BEFORE INSERT ON ReservationChange BEGIN SELECT RAISE(ABORT,'test rollback'); END`,
  );
  try {
    await assert.rejects(
      editReservation(
        f.id,
        {
          ...f.input,
          scheduledAt: new Date(Date.now() + 3600000).toISOString(),
          editVersion: 0,
        },
        f.owner,
      ),
    );
    assert.deepEqual(await detail(f.id, f.owner), original);
    await db.gameReservation.update({
      where: { id: f.id },
      data: { scheduledAt: new Date(0) },
    });
    const before = await detail(f.id, f.owner);
    await assert.rejects(
      setCompletion(f.id, { editVersion: 0 }, f.owner, true),
    );
    assert.deepEqual(await detail(f.id, f.owner), before);
  } finally {
    await db.$executeRawUnsafe("DROP TRIGGER fail_attendance_history");
  }
  await db.$executeRawUnsafe(
    `CREATE TRIGGER fail_attendance_audit BEFORE INSERT ON AdminAuditLog BEGIN SELECT RAISE(ABORT,'test audit rollback'); END`,
  );
  try {
    await assert.rejects(
      setCompletion(f.id, { editVersion: 0 }, token(), true, actor),
    );
    assert.equal((await detail(f.id)).status, "STARTED");
    assert.equal((await reservationHistory(f.id)).items.length, 0);
  } finally {
    await db.$executeRawUnsafe("DROP TRIGGER fail_attendance_audit");
  }
});
test(
  "HTTP attendance/completion validates origin, body, membership, admin sessions, privacy and quota",
  { skip: !process.env.TEST_BASE_URL },
  async () => {
    const f = await fixture(),
      base = process.env.TEST_BASE_URL!;
    async function send(
      path: string,
      method: string,
      body: unknown,
      who = f.guest,
      adminCookie = "",
    ) {
      return fetch(`${base}/api/reservations/${f.id}${path}`, {
        method,
        headers: {
          origin: base,
          "content-type": "application/json",
          cookie: `party_identity=${who}${adminCookie}`,
        },
        body: JSON.stringify(body),
      });
    }
    const initial = await payload(f.id, f.guest);
    const foreign = await fetch(`${base}/api/reservations/${f.id}/attendance`, {
      method: "PATCH",
      headers: {
        origin: "https://invalid.test",
        "content-type": "application/json",
        cookie: `party_identity=${f.guest}`,
      },
      body: JSON.stringify(initial),
    });
    assert.equal(foreign.status, 403);
    assert.equal(
      (await send("/attendance", "PATCH", { ...initial, checkedIn: "yes" }))
        .status,
      400,
    );
    assert.equal(
      (await send("/attendance", "PATCH", { ...initial, targetToken: f.guest }))
        .status,
      400,
    );
    const result = await send("/attendance", "PATCH", initial);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("cache-control"), "no-store");
    const json = await result.json();
    assert.ok(
      json.data.participants.find((p: { isMe: boolean }) => p.isMe).checkedInAt,
    );
    assert.ok(!JSON.stringify(json).includes(hashToken(f.guest)));
    assert.equal(
      (await send("/attendance", "PATCH", initial, token())).status,
      409,
    );
    await db.gameReservation.update({
      where: { id: f.id },
      data: { scheduledAt: new Date(0) },
    });
    assert.equal(
      (await send("/completion", "POST", { editVersion: 0 })).status,
      403,
    );
    await db.adminCredential.create({
      data: {
        id: actor.id,
        username: actor.username,
        passwordHash: "unused",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const adminCookie = `; ${ADMIN_COOKIE}=${createAdminSession(actor.id, 0)}`;
    assert.equal(
      (
        await send(
          "/completion",
          "POST",
          { editVersion: 0 },
          f.guest,
          adminCookie,
        )
      ).status,
      200,
    );
    await db.adminCredential.update({
      where: { id: actor.id },
      data: { sessionVersion: 1 },
    });
    assert.equal(
      (
        await send(
          "/completion",
          "DELETE",
          { editVersion: 1 },
          f.guest,
          adminCookie,
        )
      ).status,
      403,
    );
    assert.equal(
      (await send("/completion", "DELETE", { editVersion: 1 }, f.owner)).status,
      200,
    );
    const limited = token();
    for (let i = 0; i < 30; i++)
      assert.equal(
        (await send("/attendance", "PATCH", initial, limited)).status,
        409,
      );
    assert.equal(
      (await send("/attendance", "PATCH", initial, limited)).status,
      429,
    );
    const listed = await fetch(`${base}/api/reservations?view=ended`);
    assert.equal(listed.status, 200);
  },
);

test("ended filtering combines Beijing dates, stable pagination and personal scope without roster leakage", async () => {
  const owner = token(),
    q = "EndedPages-" + token().slice(0, 8),
    endedIds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const r = await createReservation(
      {
        gameName: q,
        hostName: "Host",
        maxPlayers: 3,
        scheduledAt: new Date(Date.now() + 86400000).toISOString(),
      },
      owner,
    );
    ids.push(r.id);
    const scheduledAt = new Date(`2020-01-01T${i === 4 ? "16" : "15"}:00:00Z`);
    await db.gameReservation.update({
      where: { id: r.id },
      data: {
        scheduledAt,
        status: i === 3 ? "OPEN" : "ENDED",
        endedAt: i === 3 ? null : new Date("2020-01-02T00:00:00Z"),
      },
    });
    if (i < 3) endedIds.push(r.id);
  }
  const now = new Date("2020-01-03T00:00:00Z"),
    filters = { q, view: "ended", date: "2020-01-01", pageSize: 2 };
  const one = await listReservations(filters, now),
    two = await listReservations({ ...filters, page: 99 }, now);
  assert.equal(one.total, 3);
  assert.equal(two.page, 2);
  assert.deepEqual(
    [...one.items, ...two.items].map((r) => r.id),
    endedIds.sort(),
  );
  assert.equal((await listReservations({ q, view: "started" }, now)).total, 1);
  const personal = await listMyReservations(
    { ...filters, tab: "hosted" },
    owner,
    now,
  );
  assert.equal(personal.total, 3);
  assert.equal(
    (await listMyReservations({ ...filters, tab: "joined" }, token(), now))
      .total,
    0,
  );
  assert.ok(
    one.items.every((r) => !("participants" in r) && !("checkedInAt" in r)),
  );
  assert.equal(
    (await listReservations({ ...filters, date: "2020-01-03" }, now)).total,
    0,
  );
});
