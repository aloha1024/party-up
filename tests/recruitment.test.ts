import "./support/isolated";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../server/db";
import {
  createReservation,
  detail,
  setRecruitment,
  joinReservation,
  joinWaitlist,
  leaveReservation,
  leaveWaitlist,
  editReservation,
  renameRosterEntry,
  removeRosterEntry,
  deleteReservation,
  restoreReservation,
  purgeReservation,
  cancelReservation,
} from "../server/reservations";
import { reservationHistory } from "../server/reservation-history";
import {
  listReservations,
  listAdminReservations,
  listMyReservations,
} from "../server/reservation-list";
import { listMySchedule } from "../server/reservation-schedule";
import { creationFingerprint, creationInputSchema } from "../lib/validation";
import {
  creationInputFromFields,
  draftMatchesSubmission,
} from "../lib/reservation-draft";
import { recruitmentClosure, recruitmentWakeups } from "../lib/recruitment";
import { reservationShareText } from "../lib/reservation-share";
import { registerUser } from "../server/user-accounts";
import { resolveViewer, viewerContext } from "../server/user-identity";
import { reservationTemplate } from "../server/reservation-template";

const ids: string[] = [],
  users: string[] = [];
const token = () => randomBytes(32).toString("hex");
const actor = { id: 980091, username: "recruitment-admin" };
const input = () => ({
  gameName: "Recruit-" + randomUUID(),
  hostName: "Host",
  maxPlayers: 2,
  description: "",
  scheduledAt: new Date(Date.now() + 86400000).toISOString(),
});
async function fixture(extra = {}) {
  const owner = token(),
    data = { ...input(), ...extra };
  const r = await createReservation(data, owner);
  ids.push(r.id);
  return { r, data, owner };
}
async function toggle(id: string, owner: string, paused: boolean) {
  return setRecruitment(
    id,
    { paused, editVersion: (await detail(id, owner)).editVersion },
    owner,
  );
}
async function edit(id: string, owner: string, patch: Record<string, unknown>) {
  const r = await detail(id, owner);
  return editReservation(
    id,
    {
      gameName: r.gameName,
      hostName: r.hostName,
      maxPlayers: r.maxPlayers,
      description: r.description,
      scheduledAt: r.scheduledAt,
      editVersion: r.editVersion,
      ...patch,
    },
    owner,
  );
}
after(async () => {
  await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
  await db.adminAuditLog.deleteMany({ where: { targetId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

test("pause preserves rosters, blocks all entry paths, and resume promotes FIFO before newcomers", async () => {
  const { r, owner } = await fixture();
  const member = token(),
    w1 = token(),
    w2 = token();
  await joinReservation(r.id, { name: "Member" }, member);
  await joinWaitlist(r.id, { name: "First" }, w1);
  await joinWaitlist(r.id, { name: "Second" }, w2);
  const before = await detail(r.id, owner);
  const paused = await toggle(r.id, owner, true);
  assert.equal(paused.editVersion, 1);
  assert.deepEqual(paused.waitlist, before.waitlist);
  await assert.rejects(joinReservation(r.id, { name: "New" }, token()), {
    code: "RECRUITMENT_CLOSED",
  });
  await assert.rejects(joinWaitlist(r.id, { name: "New" }, token()), {
    code: "RECRUITMENT_CLOSED",
  });
  await leaveReservation(r.id, member);
  const expanded = await edit(r.id, owner, { maxPlayers: 3 });
  assert.equal(expanded.participants.length, 1);
  assert.equal(expanded.waitlist.length, 2);
  const resumed = await toggle(r.id, owner, false);
  assert.deepEqual(
    resumed.participants.map((p) => p.name),
    ["Host", "First", "Second"],
  );
  assert.equal(resumed.waitlist.length, 0);
  assert.ok(
    resumed.participants.every(
      (p) => p.checkedInAt === null && p.attendanceVersion === 0,
    ),
  );
  await assert.rejects(joinReservation(r.id, { name: "Late" }, token()), {
    code: "FULL",
  });
  const history = await reservationHistory(r.id);
  assert.deepEqual(
    history.items.map((h) => h.action),
    ["RESUME", "EDIT", "PAUSE"],
  );
  assert.ok(history.items.every((h) => h.actorRole === "HOST"));
});

test("deadline uses exact locked-time boundary, equal start allowed, old creates remain idempotent", async (t) => {
  const now = Date.now(),
    deadline = new Date(now + 60000).toISOString();
  const { r, owner, data } = await fixture({ registrationDeadline: deadline });
  const key = randomUUID();
  const legacy = await createReservation(data, owner, key);
  ids.push(legacy.id);
  t.mock.timers.enable({ apis: ["Date"], now: now + 59999 });
  const member = token();
  await joinReservation(r.id, { name: "Member" }, member);
  t.mock.timers.setTime(now + 60000);
  await assert.rejects(joinWaitlist(r.id, { name: "Waiter" }, token()), {
    code: "RECRUITMENT_CLOSED",
  });
  await leaveReservation(r.id, member);
  await assert.rejects(joinReservation(r.id, { name: "Member" }, member), {
    code: "RECRUITMENT_CLOSED",
  });
  assert.equal((await reservationHistory(r.id)).items.length, 0);
  assert.equal(recruitmentClosure(await detail(r.id)), "报名已截止");
  await assert.rejects(
    createReservation({ ...input(), registrationDeadline: deadline }, token()),
    { code: "VALIDATION" },
  );
  await assert.rejects(
    createReservation(
      {
        ...input(),
        registrationDeadline: new Date(now + 172800000).toISOString(),
      },
      token(),
    ),
    { code: "VALIDATION" },
  );
  const equal = input();
  const equalR = await createReservation(
    { ...equal, registrationDeadline: equal.scheduledAt },
    token(),
  );
  ids.push(equalR.id);
  t.mock.timers.setTime(now + 60001);
  assert.equal((await createReservation(data, owner, key)).id, legacy.id);
});

test("editing preserves an omitted/unchanged past deadline; reopening and manual pause are independent", async (t) => {
  const now = Date.now(),
    cutoff = new Date(now + 60000).toISOString();
  const { r, owner } = await fixture({ registrationDeadline: cutoff });
  const member = token(),
    waiter = token();
  await joinReservation(r.id, { name: "Member" }, member);
  await joinWaitlist(r.id, { name: "Waiter" }, waiter);
  t.mock.timers.enable({ apis: ["Date"], now: now + 60000 });
  await leaveReservation(r.id, member);
  let updated = await edit(r.id, owner, { description: "New" });
  assert.equal(updated.registrationDeadline, cutoff);
  updated = await edit(r.id, owner, { registrationDeadline: cutoff });
  assert.equal(updated.participants.length, 1);
  await toggle(r.id, owner, true);
  await assert.rejects(toggle(r.id, owner, false), {
    code: "RECRUITMENT_CLOSED",
  });
  await edit(r.id, owner, { registrationDeadline: null });
  assert.equal((await detail(r.id)).participants.length, 1);
  updated = await toggle(r.id, owner, false);
  assert.equal(updated.participants[1].name, "Waiter");
  const h = (await reservationHistory(r.id)).items.find((x) =>
    x.fields.includes("registrationDeadline"),
  )!;
  assert.equal(h.registrationDeadlineBefore, cutoff);
  assert.equal(h.registrationDeadlineAfter, null);
  await assert.rejects(
    edit(r.id, owner, { registrationDeadline: new Date(now).toISOString() }),
    { code: "VALIDATION" },
  );
  const future = new Date(now + 3600000).toISOString();
  await edit(r.id, owner, { registrationDeadline: future });
  await assert.rejects(
    edit(r.id, owner, { scheduledAt: new Date(now + 1800000).toISOString() }),
    { code: "VALIDATION" },
  );
});

test("pause allows rename, removal and queue exit; delete/restore cannot promote until reopened", async () => {
  const { r, owner } = await fixture();
  const member = token(),
    waiter = token();
  await joinReservation(r.id, { name: "Member" }, member);
  await joinWaitlist(r.id, { name: "Waiter" }, waiter);
  await toggle(r.id, owner, true);
  const p = (await detail(r.id, member)).participants.find((p) => p.isMe)!;
  await renameRosterEntry(
    r.id,
    "participants",
    { entryId: p.id, expectedName: p.name, name: "Renamed" },
    member,
  );
  await removeRosterEntry(
    r.id,
    {
      kind: "participants",
      entryId: p.id,
      expectedName: "Renamed",
      reason: "Reason",
    },
    owner,
  );
  assert.equal((await detail(r.id)).waitlist.length, 1);
  await deleteReservation(r.id, actor);
  await assert.rejects(toggle(r.id, owner, false), { code: "NOT_FOUND" });
  await restoreReservation(r.id, actor);
  assert.equal((await detail(r.id)).participants.length, 1);
  await leaveWaitlist(r.id, waiter);
  assert.equal((await detail(r.id)).waitlist.length, 0);
  await deleteReservation(r.id, actor);
  await purgeReservation(r.id, actor);
});

test("extending or clearing a closed cutoff promotes multiple vacancies atomically", async (t) => {
  const now = Date.now();
  for (const registrationDeadline of [
    null,
    new Date(now + 3600000).toISOString(),
  ]) {
    const { r, owner } = await fixture({
      maxPlayers: 3,
      registrationDeadline: new Date(now + 60000).toISOString(),
    });
    const a = token(),
      b = token();
    await joinReservation(r.id, { name: "A" }, a);
    await joinReservation(r.id, { name: "B" }, b);
    await joinWaitlist(r.id, { name: "First" }, token());
    await joinWaitlist(r.id, { name: "Second" }, token());
    t.mock.timers.enable({ apis: ["Date"], now: now + 60000 });
    await leaveReservation(r.id, a);
    await leaveReservation(r.id, b);
    const before = await detail(r.id, owner);
    await db.$executeRawUnsafe(
      "CREATE TRIGGER fail_deadline BEFORE INSERT ON ReservationChange BEGIN SELECT RAISE(ABORT, 'test'); END",
    );
    try {
      await assert.rejects(edit(r.id, owner, { registrationDeadline }));
      assert.deepEqual(await detail(r.id, owner), before);
    } finally {
      await db.$executeRawUnsafe("DROP TRIGGER fail_deadline");
    }
    const opened = await edit(r.id, owner, { registrationDeadline });
    assert.deepEqual(
      opened.participants.map((p) => p.name),
      ["Host", "First", "Second"],
    );
    assert.equal(opened.waitlist.length, 0);
    t.mock.timers.reset();
  }
});

test("management checks host/admin, edit versions, state and rolls back promotions/history/audit failures", async () => {
  const { r, owner } = await fixture();
  await assert.rejects(
    setRecruitment(r.id, { paused: true, editVersion: 0 }, token()),
    { code: "FORBIDDEN" },
  );
  await setRecruitment(r.id, { paused: true, editVersion: 0 }, "", actor);
  await assert.rejects(
    setRecruitment(r.id, { paused: true, editVersion: 0 }, owner),
    { code: "EDIT_CONFLICT" },
  );
  const noop = await setRecruitment(
    r.id,
    { paused: true, editVersion: 1 },
    owner,
  );
  assert.equal(noop.editVersion, 1);
  assert.equal((await reservationHistory(r.id)).items.length, 1);
  assert.equal((await reservationHistory(r.id)).items[0].actorRole, "ADMIN");
  await db.waitlistEntry.create({
    data: {
      reservationId: r.id,
      name: "Waiter",
      nameKey: "waiter",
      tokenHash: token(),
    },
  });
  for (const table of ["ReservationChange", "AdminAuditLog"]) {
    const before = await db.gameReservation.findUniqueOrThrow({
      where: { id: r.id },
      include: { participants: true, waitlist: true, changes: true },
    });
    await db.$executeRawUnsafe(
      `CREATE TRIGGER fail_recruitment BEFORE INSERT ON "${table}" BEGIN SELECT RAISE(ABORT, 'test'); END`,
    );
    try {
      await assert.rejects(
        setRecruitment(r.id, { paused: false, editVersion: 1 }, "", actor),
      );
      assert.deepEqual(
        await db.gameReservation.findUniqueOrThrow({
          where: { id: r.id },
          include: { participants: true, waitlist: true, changes: true },
        }),
        before,
      );
    } finally {
      await db.$executeRawUnsafe("DROP TRIGGER fail_recruitment");
    }
  }
  await cancelReservation(r.id, { reason: "Cancelled" }, owner);
  await assert.rejects(toggle(r.id, owner, false), { code: "CANCELLED" });
  const started = await fixture();
  await db.gameReservation.update({
    where: { id: started.r.id },
    data: { scheduledAt: new Date(0) },
  });
  await assert.rejects(toggle(started.r.id, started.owner, true), {
    code: "STARTED",
  });
  await db.gameReservation.update({
    where: { id: started.r.id },
    data: { status: "ENDED" },
  });
  await assert.rejects(toggle(started.r.id, started.owner, false), {
    code: "ENDED",
  });
});

test("join/pause and resume/leave races serialize without overbooking, lost waiters or partial writes", async () => {
  for (let i = 0; i < 3; i++) {
    const { r, owner } = await fixture();
    const guest = token();
    const results = await Promise.allSettled([
      toggle(r.id, owner, true),
      joinReservation(r.id, { name: "Guest" }, guest),
    ]);
    assert.equal(results[0].status, "fulfilled");
    if (results[1].status === "rejected")
      assert.equal(results[1].reason.code, "RECRUITMENT_CLOSED");
    assert.equal((await detail(r.id)).recruitmentPaused, true);
    assert.ok((await detail(r.id)).participants.length <= 2);
    await db.waitlistEntry.create({
      data: {
        reservationId: r.id,
        name: "Waiter",
        nameKey: "waiter",
        tokenHash: token(),
      },
    });
    await Promise.all([
      toggle(r.id, owner, false),
      leaveReservation(r.id, owner),
    ]);
    const final = await detail(r.id);
    assert.equal(final.recruitmentPaused, false);
    assert.equal(final.waitlist.length, 0);
    assert.ok(final.participants.some((p) => p.name === "Waiter"));
    assert.ok(final.participants.length <= 2);
  }
});

test("available query filters closure before counts/paging while other views and schedules retain it", async () => {
  const q = "RecruitQuery-" + randomUUID(),
    owner = token(),
    now = new Date();
  const closedIds: string[] = [],
    openIds: string[] = [];
  for (let i = 0; i < 17; i++) {
    const r = await createReservation(
      {
        ...input(),
        gameName: q,
        scheduledAt: new Date(now.getTime() + (i + 1) * 60000).toISOString(),
      },
      owner,
    );
    ids.push(r.id);
    if (i % 3 === 0) {
      await db.gameReservation.update({
        where: { id: r.id },
        data:
          i % 2 ? { recruitmentPaused: true } : { registrationDeadline: now },
      });
      closedIds.push(r.id);
    } else openIds.push(r.id);
  }
  const result = await listReservations(
    { q, view: "available", pageSize: 3, page: 999 },
    now,
  );
  assert.equal(result.total, openIds.length);
  assert.equal(result.page, Math.ceil(openIds.length / 3));
  assert.deepEqual(
    result.items.map((r) => r.id),
    openIds.slice(9),
  );
  for (const tab of ["hosted", "joined"])
    assert.equal(
      (await listMyReservations({ q, view: "available", tab }, owner, now))
        .total,
      openIds.length,
    );
  assert.equal(
    (await listMyReservations({ q, view: "available" }, token(), now)).total,
    0,
  );
  assert.equal(
    (await listAdminReservations({ q, view: "available" }, now)).total,
    openIds.length,
  );
  assert.equal(
    (await listReservations({ q, view: "upcoming" }, now)).total,
    17,
  );
  assert.equal((await listMySchedule({ range: "week" }, owner, now)).total, 17);
  const closed = (
    await listReservations({ q, pageSize: 48 }, now)
  ).items.filter((r) => closedIds.includes(r.id));
  assert.ok(closed.every((r) => recruitmentClosure(r, now)));
});

test("legacy drafts/fingerprints remain compatible and a copied reservation drops recruitment settings", async () => {
  const data = input();
  const legacy = JSON.stringify({
    gameName: data.gameName,
    hostName: data.hostName,
    scheduledAt: data.scheduledAt,
    maxPlayers: data.maxPlayers,
    description: data.description,
  });
  assert.equal(creationFingerprint(creationInputSchema.parse(data)), legacy);
  assert.equal(
    creationFingerprint(
      creationInputSchema.parse({ ...data, registrationDeadline: null }),
    ),
    creationFingerprint(creationInputSchema.parse(data)),
  );
  const fields = {
    gameName: "Game",
    hostName: "Host",
    date: "2030-01-01",
    time: "12:00",
    maxPlayers: "2",
    description: "",
  };
  const payload = JSON.stringify(creationInputFromFields(fields));
  assert.equal(draftMatchesSubmission(fields, payload), true);
  const precise = "2030-01-01T04:00:30.123Z";
  const unchanged = creationInputFromFields(
    { ...fields, deadline: "2030-01-01T12:00:30" },
    { scheduledAt: precise, registrationDeadline: precise },
  );
  assert.equal(unchanged.scheduledAt, precise);
  assert.equal(unchanged.registrationDeadline, precise);
  assert.equal(
    creationInputFromFields(
      { ...fields, deadline: "" },
      { scheduledAt: precise, registrationDeadline: precise },
    ).registrationDeadline,
    null,
  );
  assert.equal(
    draftMatchesSubmission({ ...fields, deadline: "" }, payload),
    true,
  );
  assert.equal(
    draftMatchesSubmission(
      { ...fields, deadline: "2030-01-01T11:00" },
      payload,
    ),
    false,
  );
  const auth = await registerUser({
    username: "rc_" + randomUUID().slice(0, 8),
    nickname: "Host",
    password: "recruitment-password",
  });
  const viewer = await resolveViewer(auth.token);
  users.push(viewer.user!.id);
  const r = await viewerContext.run(viewer, () =>
    createReservation(
      {
        ...input(),
        visibility: "INVITE",
        registrationDeadline: new Date(Date.now() + 600000).toISOString(),
      },
      viewer.token!,
    ),
  );
  ids.push(r.id);
  await viewerContext.run(viewer, () => toggle(r.id, viewer.token!, true));
  await assert.rejects(joinReservation(r.id, { name: "Unknown" }, token()), {
    code: "INVITATION_REQUIRED",
  });
  const template = await reservationTemplate(r.id, viewer.token!);
  assert.equal("registrationDeadline" in template, false);
  assert.equal("recruitmentPaused" in template, false);
  const copy = await viewerContext.run(viewer, () =>
    createReservation(
      {
        ...template,
        scheduledAt: new Date(Date.now() + 86400000).toISOString(),
      },
      viewer.token!,
    ),
  );
  ids.push(copy.id);
  assert.equal(copy.registrationDeadline, null);
  assert.equal(copy.recruitmentPaused, false);
  assert.equal((await listReservations({ q: r.gameName })).total, 0);
  assert.equal(recruitmentWakeups(r).length, 2);
  assert.match(
    reservationShareText(
      { ...r, recruitmentPaused: true },
      "https://example.test",
    ),
    /暂停招募/,
  );
});
