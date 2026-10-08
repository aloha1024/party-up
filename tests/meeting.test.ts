import "./support/isolated";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { registeredToken, identityFetch, testCookie } from "./support/member";
import { db } from "../server/db";
import {
  createReservation,
  detail,
  editReservation,
  joinReservation,
  joinWaitlist,
  leaveReservation,
  removeRosterEntry,
  hashToken,
} from "../server/reservations";
import { setMeeting } from "../server/reservation-meeting";
import {
  acceptInvitation,
  currentInvitation,
  rotateInvitation,
} from "../server/reservation-invitations";
import { calendarReservation } from "../server/reservation-calendar";
import { reservationCalendar } from "../lib/reservation-calendar";
import { reservationTemplate } from "../server/reservation-template";
import { reservationShareText } from "../lib/reservation-share";
import { reservationHistory } from "../server/reservation-history";
import { listReservations } from "../server/reservation-list";
import { ADMIN_COOKIE, createAdminSession } from "../server/admin-auth";

const token = () => randomBytes(32).toString("hex");
const ids: string[] = [];
const actor = { id: 310001, username: "meeting-admin" };
const empty = { roomName: "", roomPassword: "", voice: "", version: 0 };
const secrets = () => ({
  roomName: "room-" + randomUUID(),
  roomPassword: "password-" + randomUUID(),
  voice: "voice-" + randomUUID(),
});

async function fixture(invite = false) {
  const owner = await registeredToken();
  const input = {
    gameName: "Meeting-" + token().slice(0, 8),
    hostName: "Host",
    scheduledAt: new Date(Date.now() + 86400000).toISOString(),
    maxPlayers: 2,
    description: "Public notes",
  };
  const r = await createReservation(
    { ...input, visibility: invite ? "INVITE" : "PUBLIC" },
    owner,
  );
  ids.push(r.id);
  return { id: r.id, owner, input };
}

after(async () => {
  await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
  await db.adminAuditLog.deleteMany({ where: { targetId: { in: ids } } });
  await db.adminCredential.deleteMany({ where: { id: actor.id } });
  await db.$disconnect();
});

test("public platform fields default empty, preserve legacy retry fingerprints and survive omitted edits", async () => {
  const f = await fixture();
  const initial = await detail(f.id, f.owner);
  assert.equal(initial.platform, "");
  assert.equal(initial.gameServer, "");
  const key = randomUUID();
  const old = await createReservation(f.input, f.owner, key);
  ids.push(old.id);
  const submission = await db.creationRequest.findUniqueOrThrow({
    where: { ownerTokenHash_key: { ownerTokenHash: hashToken(f.owner), key } },
  });
  assert.equal(
    submission.inputHash,
    hashToken(
      JSON.stringify({
        gameName: f.input.gameName,
        hostName: f.input.hostName,
        scheduledAt: f.input.scheduledAt,
        maxPlayers: f.input.maxPlayers,
        description: f.input.description,
      }),
    ),
  );
  assert.equal(
    (
      await createReservation(
        { ...f.input, platform: "", gameServer: "" },
        f.owner,
        key,
      )
    ).id,
    old.id,
  );
  await editReservation(
    f.id,
    { ...f.input, platform: "PC", gameServer: "Asia", editVersion: 0 },
    f.owner,
  );
  await editReservation(
    f.id,
    { ...f.input, description: "Legacy client edit", editVersion: 1 },
    f.owner,
  );
  const updated = await detail(f.id);
  assert.equal(updated.platform, "PC");
  assert.equal(updated.gameServer, "Asia");
  await editReservation(
    f.id,
    { ...f.input, platform: "", gameServer: "", editVersion: 2 },
    f.owner,
  );
  assert.equal((await detail(f.id)).platform, "");
  assert.equal((await detail(f.id)).gameServer, "");
});

test("meeting access follows current formal membership, promotion and removal; hosts retain access after leaving", async () => {
  const f = await fixture();
  const member = token(),
    waiter = token(),
    outsider = token();
  assert.deepEqual((await detail(f.id, f.owner)).meeting, empty);
  for (const viewer of [undefined, outsider])
    assert.equal((await detail(f.id, viewer)).meeting, null);
  const privateFields = secrets();
  await setMeeting(f.id, { ...privateFields, version: 0 }, f.owner);
  const expected = { ...privateFields, version: 1 };
  await joinReservation(f.id, { name: "Member" }, member);
  await joinWaitlist(f.id, { name: "Waiter" }, waiter);
  assert.deepEqual((await detail(f.id, member)).meeting, expected);
  assert.equal((await detail(f.id, waiter)).meeting, null);
  for (const viewer of [member, waiter, outsider])
    await assert.rejects(
      setMeeting(f.id, { ...privateFields, version: 1 }, viewer),
      {
        status: 403,
      },
    );
  await leaveReservation(f.id, member);
  assert.equal((await detail(f.id, member)).meeting, null);
  assert.deepEqual((await detail(f.id, waiter)).meeting, expected);
  const entry = (await detail(f.id, waiter)).participants.find((p) => p.isMe)!;
  await removeRosterEntry(
    f.id,
    {
      kind: "participants",
      entryId: entry.id,
      expectedName: entry.name,
      reason: "Roster correction",
    },
    f.owner,
  );
  assert.equal((await detail(f.id, waiter)).meeting, null);
  await leaveReservation(f.id, f.owner);
  assert.deepEqual((await detail(f.id, f.owner)).meeting, expected);
  assert.deepEqual((await detail(f.id, outsider, true)).meeting, expected);
  await setMeeting(
    f.id,
    { ...privateFields, roomName: "Admin room", version: 1 },
    outsider,
    actor,
  );
  assert.equal((await detail(f.id, f.owner)).meeting?.roomName, "Admin room");
});

test("invitation grants do not expose meeting details and historical access does not retain membership privileges", async () => {
  const f = await fixture(true);
  const member = token(),
    viewer = token(),
    outsider = token();
  const invitation = await currentInvitation(f.id, f.owner);
  for (const who of [member, viewer])
    await acceptInvitation(
      f.id,
      { token: invitation.path.split("#invite=")[1] },
      who,
    );
  await joinReservation(f.id, { name: "Member" }, member);
  const privateFields = secrets();
  await setMeeting(f.id, { ...privateFields, version: 0 }, f.owner);
  assert.equal((await detail(f.id, viewer)).meeting, null);
  await assert.rejects(detail(f.id, outsider), { status: 404 });
  await rotateInvitation(
    f.id,
    { expectedVersion: invitation.version },
    f.owner,
  );
  await assert.rejects(detail(f.id, viewer), { status: 404 });
  assert.deepEqual((await detail(f.id, member)).meeting, {
    ...privateFields,
    version: 1,
  });
  await leaveReservation(f.id, member);
  assert.equal((await detail(f.id, member)).meeting, null);
});

test("meeting changes are independently versioned, reject stale concurrent writes and support no-op and clearing", async () => {
  const f = await fixture();
  const values = secrets();
  const results = await Promise.allSettled([
    setMeeting(f.id, { ...values, version: 0 }, f.owner),
    setMeeting(
      f.id,
      { ...values, roomName: "Competing room", version: 0 },
      f.owner,
    ),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = results.find((r) => r.status === "rejected");
  assert.equal(rejected?.reason.code, "MEETING_CONFLICT");
  const saved = (await detail(f.id, f.owner)).meeting!;
  assert.equal(saved.version, 1);
  const before = await db.gameReservation.findUniqueOrThrow({
    where: { id: f.id },
  });
  await setMeeting(f.id, saved, f.owner);
  const noOp = await db.gameReservation.findUniqueOrThrow({
    where: { id: f.id },
  });
  assert.equal(noOp.meetingVersion, before.meetingVersion);
  assert.equal(noOp.meetingCipher, before.meetingCipher);
  assert.equal(noOp.editVersion, 0);
  await assert.rejects(setMeeting(f.id, { ...saved, version: 0 }, f.owner), {
    code: "MEETING_CONFLICT",
    status: 409,
  });
  await setMeeting(f.id, { ...empty, version: 1 }, f.owner);
  assert.deepEqual((await detail(f.id, f.owner)).meeting, {
    ...empty,
    version: 2,
  });
});

test("started reservations allow meeting updates, while cancellation, completion and deletion lock writes", async () => {
  const f = await fixture();
  await db.gameReservation.update({
    where: { id: f.id },
    data: { scheduledAt: new Date(0) },
  });
  await setMeeting(f.id, { ...secrets(), version: 0 }, f.owner);
  assert.equal((await detail(f.id, f.owner)).meeting?.version, 1);
  for (const status of ["CANCELLED", "ENDED"]) {
    await db.gameReservation.update({ where: { id: f.id }, data: { status } });
    const before = await db.gameReservation.findUniqueOrThrow({
      where: { id: f.id },
    });
    await assert.rejects(
      setMeeting(f.id, { ...secrets(), version: 1 }, f.owner),
      { status: 409 },
    );
    assert.deepEqual(
      await db.gameReservation.findUniqueOrThrow({ where: { id: f.id } }),
      before,
    );
  }
  await db.gameReservation.update({
    where: { id: f.id },
    data: { deletedAt: new Date() },
  });
  await assert.rejects(
    setMeeting(f.id, { ...secrets(), version: 1 }, f.owner),
    { status: 404 },
  );
  await assert.rejects(detail(f.id, f.owner), { status: 404 });
});

test("meeting secrets remain encrypted and absent from listing, sharing, calendar, templates and audit history", async () => {
  const f = await fixture();
  const values = secrets();
  await setMeeting(f.id, { ...values, version: 0 }, f.owner, actor);
  const owned = await detail(f.id, f.owner);
  const row = await db.gameReservation.findUniqueOrThrow({
    where: { id: f.id },
  });
  assert.ok(row.meetingCipher);
  assert.equal("meetingCipher" in owned, false);
  const template = await reservationTemplate(f.id, f.owner);
  const calendar = await calendarReservation(f.id, f.owner);
  const outputs = [
    JSON.stringify(row),
    JSON.stringify(await detail(f.id)),
    JSON.stringify(await listReservations({ q: f.input.gameName })),
    reservationShareText(owned, "https://example.test"),
    JSON.stringify(calendar),
    reservationCalendar(calendar, "https://example.test"),
    JSON.stringify(template),
    JSON.stringify(await reservationHistory(f.id)),
    JSON.stringify(
      await db.adminAuditLog.findMany({ where: { targetId: f.id } }),
    ),
  ];
  for (const output of outputs)
    for (const secret of Object.values(values))
      assert.equal(output.includes(secret), false);
  const copied = await createReservation(
    { ...template, scheduledAt: f.input.scheduledAt },
    f.owner,
  );
  ids.push(copied.id);
  assert.deepEqual((await detail(copied.id, f.owner)).meeting, empty);
});

test("failed administrative audit rolls back the meeting ciphertext and its version", async () => {
  const f = await fixture();
  const before = await db.gameReservation.findUniqueOrThrow({
    where: { id: f.id },
  });
  await db.$executeRawUnsafe(
    "CREATE TRIGGER fail_meeting_audit BEFORE INSERT ON AdminAuditLog BEGIN SELECT RAISE(ABORT,'test meeting rollback'); END",
  );
  try {
    await assert.rejects(
      setMeeting(f.id, { ...secrets(), version: 0 }, token(), actor),
    );
    assert.deepEqual(
      await db.gameReservation.findUniqueOrThrow({ where: { id: f.id } }),
      before,
    );
  } finally {
    await db.$executeRawUnsafe("DROP TRIGGER fail_meeting_audit");
  }
});

test(
  "meeting HTTP endpoints enforce origin, current identity, membership, body validation and live administrator sessions",
  { skip: !process.env.TEST_BASE_URL },
  async () => {
    const f = await fixture();
    const base = process.env.TEST_BASE_URL!;
    const url = `${base}/api/reservations/${f.id}/meeting`;
    const values = secrets();
    const cookie = testCookie(f.owner);
    const send = (data: unknown, who = f.owner, extraCookie = "") =>
      identityFetch(url, {
        method: "PATCH",
        headers: {
          Origin: base,
          "Content-Type": "application/json",
          Cookie: testCookie(who) + extraCookie,
        },
        body: JSON.stringify(data),
      });
    const initial = { ...values, version: 0 };
    const foreign = await identityFetch(url, {
      method: "PATCH",
      headers: {
        Origin: "https://invalid.test",
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify(initial),
    });
    assert.equal(foreign.status, 403);
    const stale = await globalThis.fetch(url, {
      method: "PATCH",
      headers: {
        Origin: base,
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-Identity-Scope": "stale",
      },
      body: JSON.stringify(initial),
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, "IDENTITY_CHANGED");
    for (const invalid of [
      { ...initial, version: -1 },
      { ...initial, roomName: 123 },
      { ...initial, token: f.owner },
    ])
      assert.equal((await send(invalid)).status, 400);
    assert.equal((await send(initial, token())).status, 403);
    const saved = await send(initial);
    assert.equal(saved.status, 200);
    assert.equal(saved.headers.get("cache-control"), "no-store");
    const own = await identityFetch(url, { headers: { Cookie: cookie } });
    assert.deepEqual((await own.json()).data, { ...values, version: 1 });
    const publicResult = await identityFetch(url);
    assert.equal(publicResult.status, 200);
    assert.equal((await publicResult.json()).data, null);
    assert.equal((await send(initial)).status, 409);
    await db.adminCredential.create({
      data: {
        id: actor.id,
        username: actor.username,
        passwordHash: "unused",
        mustChangePassword: false,
      },
    });
    const adminCookie = `; ${ADMIN_COOKIE}=${createAdminSession(actor.id, 0)}`;
    const outsider = token();
    assert.equal(
      (
        await send(
          { ...values, roomName: "Admin room", version: 1 },
          outsider,
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
      (await send({ ...values, version: 2 }, outsider, adminCookie)).status,
      403,
    );
    const invited = await fixture(true);
    await setMeeting(invited.id, initial, invited.owner);
    const forbidden = await identityFetch(
      `${base}/api/reservations/${invited.id}/meeting`,
      { headers: { Cookie: testCookie(outsider) } },
    );
    assert.equal(forbidden.status, 404);
    for (const value of Object.values(values))
      assert.equal((await forbidden.clone().text()).includes(value), false);
  },
);
