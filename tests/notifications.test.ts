import "./support/isolated";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../server/db";
import { registeredToken, testCookie } from "./support/member";
import {
  createReservation,
  detail,
  editReservation,
  cancelReservation,
  joinReservation,
  joinWaitlist,
  leaveReservation,
  removeRosterEntry,
  deleteReservation,
  purgeReservation,
} from "../server/reservations";
import { setMeeting } from "../server/reservation-meeting";
import {
  listNotifications,
  markNotificationsRead,
  unreadNotificationCount,
  notificationSearchParams,
  recordNotifications,
} from "../server/notifications";
import {
  acceptInvitation,
  currentInvitation,
  rotateInvitation,
} from "../server/reservation-invitations";
import { claimGuestRecords, previewGuestClaim } from "../server/guest-claims";
import { digest, resolveViewer, viewerContext } from "../server/user-identity";

const token = () => randomBytes(32).toString("hex");
const ids: string[] = [];
const actor = { id: 320001, username: "notifications-admin" };
async function fixture(invite = false) {
  const owner = await registeredToken();
  const input = {
    gameName: "Inbox-" + token().slice(0, 8),
    hostName: "Host",
    maxPlayers: 2,
    scheduledAt: new Date(Date.now() + 86400000).toISOString(),
    description: "",
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
  await db.$disconnect();
});

test("events reach current affected identities without self-notifications, private payloads or retry duplicates", async () => {
  const f = await fixture(),
    member = token(),
    waiter = await registeredToken();
  await joinReservation(f.id, { name: "Member" }, member);
  await joinWaitlist(f.id, { name: "Waiter" }, waiter);
  const meeting = {
    roomName: "private-room",
    roomPassword: "private-password",
    voice: "private-voice",
    version: 0,
  };
  await setMeeting(f.id, meeting, f.owner);
  await setMeeting(f.id, { ...meeting, version: 1 }, f.owner);
  assert.deepEqual(
    (await listNotifications(member)).items.map((n) => n.kind),
    ["MEETING_UPDATED"],
  );
  assert.equal((await listNotifications(waiter)).total, 0);
  await editReservation(
    f.id,
    { ...f.input, description: "ordinary edit", editVersion: 0 },
    f.owner,
  );
  assert.equal((await listNotifications(member)).total, 1);
  const moved = {
    ...f.input,
    scheduledAt: new Date(Date.now() + 2 * 86400000).toISOString(),
    editVersion: 1,
  };
  await editReservation(f.id, moved, f.owner);
  await assert.rejects(editReservation(f.id, moved, f.owner), {
    code: "EDIT_CONFLICT",
  });
  assert.deepEqual(
    (await listNotifications(member)).items.map((n) => n.kind),
    ["RESCHEDULED", "MEETING_UPDATED"],
  );
  assert.deepEqual(
    (await listNotifications(waiter)).items.map((n) => n.kind),
    ["RESCHEDULED"],
  );
  const participant = (await detail(f.id, member)).participants.find(
    (p) => p.isMe,
  )!;
  const removal = {
    kind: "participants",
    entryId: participant.id,
    expectedName: participant.name,
    reason: "private removal reason",
  };
  await removeRosterEntry(f.id, removal, f.owner);
  await removeRosterEntry(f.id, removal, f.owner);
  assert.deepEqual(
    (await listNotifications(member)).items.map((n) => n.kind),
    ["REMOVED", "RESCHEDULED", "MEETING_UPDATED"],
  );
  assert.deepEqual(
    (await listNotifications(waiter)).items.map((n) => n.kind),
    ["PROMOTED", "RESCHEDULED"],
  );
  await cancelReservation(
    f.id,
    { reason: "private cancellation reason" },
    f.owner,
  );
  await assert.rejects(cancelReservation(f.id, { reason: "retry" }, f.owner), {
    code: "CANCELLED",
  });
  assert.deepEqual(
    (await listNotifications(waiter)).items.map((n) => n.kind),
    ["CANCELLED", "PROMOTED", "RESCHEDULED"],
  );
  assert.equal((await listNotifications(member)).total, 3);
  assert.equal((await listNotifications(f.owner)).total, 0);
  const stored = JSON.stringify(
    await db.notification.findMany({ where: { reservationId: f.id } }),
  );
  for (const privateValue of [
    meeting.roomName,
    meeting.roomPassword,
    meeting.voice,
    removal.reason,
    "private cancellation reason",
  ])
    assert.equal(stored.includes(privateValue), false);
  const administered = await fixture();
  await cancelReservation(
    administered.id,
    { reason: "Admin cancelled" },
    token(),
    actor,
  );
  assert.deepEqual(
    (await listNotifications(administered.owner)).items.map((n) => n.kind),
    ["CANCELLED"],
  );
});

test("notification failure rolls back promotion, and later business failures roll back already-created notifications", async () => {
  const f = await fixture(),
    member = token(),
    waiter = token();
  await joinReservation(f.id, { name: "Member" }, member);
  await joinWaitlist(f.id, { name: "Waiter" }, waiter);
  const before = await detail(f.id, f.owner);
  await db.$executeRawUnsafe(
    "CREATE TRIGGER fail_notification_insert BEFORE INSERT ON Notification BEGIN SELECT RAISE(ABORT,'notification rollback'); END",
  );
  try {
    await assert.rejects(leaveReservation(f.id, member));
    assert.deepEqual(await detail(f.id, f.owner), before);
    assert.equal((await listNotifications(waiter)).total, 0);
  } finally {
    await db.$executeRawUnsafe("DROP TRIGGER fail_notification_insert");
  }
  await db.$executeRawUnsafe(
    "CREATE TRIGGER fail_notification_history BEFORE INSERT ON ReservationChange BEGIN SELECT RAISE(ABORT,'notification history rollback'); END",
  );
  try {
    await assert.rejects(
      editReservation(
        f.id,
        {
          ...f.input,
          scheduledAt: new Date(Date.now() + 2 * 86400000).toISOString(),
          editVersion: 0,
        },
        f.owner,
      ),
    );
    assert.deepEqual(await detail(f.id, f.owner), before);
    assert.equal(
      await db.notification.count({ where: { reservationId: f.id } }),
      0,
    );
  } finally {
    await db.$executeRawUnsafe("DROP TRIGGER fail_notification_history");
  }
});

test("inbox queries redact inaccessible invitations and soft deletion; permanent deletion removes receipts", async () => {
  const f = await fixture(true),
    member = token();
  const invite = await currentInvitation(f.id, f.owner);
  await acceptInvitation(
    f.id,
    { token: invite.path.split("#invite=")[1] },
    member,
  );
  await joinReservation(f.id, { name: "Member" }, member);
  await setMeeting(
    f.id,
    {
      roomName: "private",
      roomPassword: "password",
      voice: "voice",
      version: 0,
    },
    f.owner,
  );
  const received = (await listNotifications(member)).items[0];
  assert.equal(received.gameName, f.input.gameName);
  assert.equal(received.reservationId, f.id);
  await leaveReservation(f.id, member);
  await db.reservationAccess.update({
    where: {
      reservationId_tokenHash: {
        reservationId: f.id,
        tokenHash: digest(member),
      },
    },
    data: { hasJoined: false },
  });
  await rotateInvitation(f.id, { expectedVersion: invite.version }, f.owner);
  const redacted = (await listNotifications(member)).items[0];
  assert.equal(redacted.reservationId, null);
  assert.notEqual(redacted.gameName, f.input.gameName);
  assert.equal(JSON.stringify(redacted).includes(f.id), false);
  assert.deepEqual(Object.keys(redacted).sort(), [
    "createdAt",
    "gameName",
    "id",
    "kind",
    "readAt",
    "reservationId",
  ]);
  assert.equal((await listNotifications(token())).total, 0);
  await deleteReservation(f.id, actor);
  assert.equal((await listNotifications(member)).items[0].reservationId, null);
  await purgeReservation(f.id, actor);
  assert.equal((await listNotifications(member)).total, 0);
});

test("pagination, unread counts and idempotent read operations are identity-scoped and preserve later arrivals", async () => {
  const f = await fixture(),
    recipient = token(),
    outsider = token();
  await db.notification.createMany({
    data: Array.from({ length: 25 }, (_, index) => ({
      reservationId: f.id,
      recipientHash: digest(recipient),
      kind: "RESCHEDULED",
      eventKey: `paging:${f.id}:${index}`,
    })),
  });
  const first = await listNotifications(recipient);
  assert.equal(first.total, 25);
  assert.equal(first.unreadCount, 25);
  assert.equal(first.items.length, 20);
  assert.equal(first.pageCount, 2);
  const second = await listNotifications(recipient, { page: 999 });
  assert.equal(second.page, 2);
  assert.equal(second.items.length, 5);
  assert.equal(
    first.items.some((n) => second.items.some((other) => other.id === n.id)),
    false,
  );
  const target = first.items[0];
  await assert.rejects(markNotificationsRead(outsider, { id: target.id }), {
    status: 404,
  });
  await markNotificationsRead(recipient, { id: target.id });
  const read = await db.notification.findUniqueOrThrow({
    where: { id: target.id },
  });
  await markNotificationsRead(recipient, { id: target.id });
  assert.deepEqual(
    (await db.notification.findUniqueOrThrow({ where: { id: target.id } }))
      .readAt,
    read.readAt,
  );
  assert.equal(
    (await listNotifications(recipient, { unread: "unread" })).total,
    24,
  );
  assert.equal(await unreadNotificationCount(recipient), 24);
  await markNotificationsRead(recipient, { all: true });
  assert.equal(await unreadNotificationCount(recipient), 0);
  await db.$transaction((tx) =>
    recordNotifications(tx, f.id, "PROMOTED", `later:${f.id}`, [
      digest(recipient),
      digest(recipient),
    ]),
  );
  await db.$transaction((tx) =>
    recordNotifications(tx, f.id, "PROMOTED", `later:${f.id}`, [
      digest(recipient),
    ]),
  );
  assert.equal(
    (await listNotifications(recipient, { unread: "unread" })).total,
    1,
  );
  assert.equal((await listNotifications(recipient)).total, 26);
  assert.equal(await unreadNotificationCount(), 0);
  assert.equal((await listNotifications()).total, 0);
  await assert.rejects(markNotificationsRead("invalid", { all: true }), {
    status: 428,
  });
  for (const query of [
    "page=1&page=2",
    "unread=all&unread=unread",
    "page=1.0",
    "page=0",
    "page=01",
    "unread=no",
    "recipientHash=other",
  ])
    assert.throws(() => notificationSearchParams(new URLSearchParams(query)));
  for (const input of [
    {},
    { id: target.id, all: true },
    { all: false },
    { id: "1" },
    { id: 0 },
    { all: true, recipientHash: digest(outsider) },
  ])
    await assert.rejects(markNotificationsRead(recipient, input));
});

test("partial guest claims migrate receipt-only reservations, merge duplicates without losing unread state and retire only after all receipts move", async () => {
  const f = await fixture(),
    other = await fixture();
  const guest = token(),
    account = await registeredToken();
  const viewer = await resolveViewer(testCookie(account).split("=")[1], guest);
  const guestHash = digest(guest),
    userHash = digest(account);
  const firstRead = new Date("2026-01-01T00:00:00Z"),
    secondRead = new Date("2026-01-02T00:00:00Z");
  for (const [eventKey, sourceRead, targetRead] of [
    ["guest-unread", null, firstRead],
    ["account-unread", firstRead, null],
    ["both-read", firstRead, secondRead],
  ] as const) {
    await db.notification.createMany({
      data: [
        {
          reservationId: f.id,
          recipientHash: guestHash,
          kind: "RESCHEDULED",
          eventKey: `${f.id}:${eventKey}`,
          readAt: sourceRead,
        },
        {
          reservationId: f.id,
          recipientHash: userHash,
          kind: "RESCHEDULED",
          eventKey: `${f.id}:${eventKey}`,
          readAt: targetRead,
        },
      ],
    });
  }
  await db.notification.create({
    data: {
      reservationId: other.id,
      recipientHash: guestHash,
      kind: "REMOVED",
      eventKey: `other:${other.id}`,
    },
  });
  const preview = await previewGuestClaim(viewer);
  assert.deepEqual(
    new Set(preview.items.map((r) => r.id)),
    new Set([f.id, other.id]),
  );
  const input = {
    key: randomUUID(),
    fingerprint: preview.fingerprint,
    ids: [f.id],
  };
  const claimed = await claimGuestRecords(viewer, input);
  assert.equal(claimed.retired, false);
  assert.deepEqual(await claimGuestRecords(viewer, input), claimed);
  const merged = await db.notification.findMany({
    where: { reservationId: f.id, recipientHash: userHash },
  });
  assert.equal(merged.length, 3);
  assert.equal(merged.filter((r) => r.readAt === null).length, 2);
  assert.deepEqual(
    merged.find((r) => r.eventKey.endsWith("both-read"))?.readAt,
    firstRead,
  );
  assert.equal((await listNotifications(guest)).total, 1);
  const remaining = await previewGuestClaim(viewer);
  assert.deepEqual(
    remaining.items.map((r) => r.id),
    [other.id],
  );
  const oldGuestViewer = await resolveViewer(undefined, guest);
  assert.equal(
    (
      await claimGuestRecords(viewer, {
        key: randomUUID(),
        fingerprint: remaining.fingerprint,
        ids: [other.id],
      })
    ).retired,
    true,
  );
  assert.equal((await resolveViewer(undefined, guest)).mode, "anonymous");
  assert.equal((await listNotifications(account)).total, 4);
  await assert.rejects(
    viewerContext.run(oldGuestViewer, () =>
      markNotificationsRead(guest, { all: true }),
    ),
    { code: "IDENTITY_CHANGED" },
  );
});

test("notification arrivals and read changes invalidate guest claim previews and failed claims roll receipt migration back", async () => {
  const f = await fixture(),
    guest = token(),
    account = await registeredToken();
  const viewer = await resolveViewer(testCookie(account).split("=")[1], guest);
  const row = await db.notification.create({
    data: {
      reservationId: f.id,
      recipientHash: digest(guest),
      kind: "REMOVED",
      eventKey: `claim:${f.id}`,
    },
  });
  const preview = await previewGuestClaim(viewer);
  await markNotificationsRead(guest, { id: row.id });
  await assert.rejects(
    claimGuestRecords(viewer, {
      key: randomUUID(),
      fingerprint: preview.fingerprint,
      ids: [f.id],
    }),
    { code: "CLAIM_STALE" },
  );
  const fresh = await previewGuestClaim(viewer);
  await db.$executeRawUnsafe(
    "CREATE TRIGGER fail_notification_claim BEFORE INSERT ON GuestClaim BEGIN SELECT RAISE(ABORT,'receipt migration rollback'); END",
  );
  try {
    await assert.rejects(
      claimGuestRecords(viewer, {
        key: randomUUID(),
        fingerprint: fresh.fingerprint,
        ids: [f.id],
      }),
    );
    assert.equal(
      (await db.notification.findUniqueOrThrow({ where: { id: row.id } }))
        .recipientHash,
      digest(guest),
    );
    assert.deepEqual(await previewGuestClaim(viewer), fresh);
  } finally {
    await db.$executeRawUnsafe("DROP TRIGGER fail_notification_claim");
  }
});

test(
  "notification HTTP read and write endpoints never create identities, enforce ownership, strict queries and identity scope",
  { skip: !process.env.TEST_BASE_URL },
  async () => {
    const base = process.env.TEST_BASE_URL!,
      f = await fixture(),
      recipient = token(),
      outsider = token();
    const row = await db.notification.create({
      data: {
        reservationId: f.id,
        recipientHash: digest(recipient),
        kind: "PROMOTED",
        eventKey: `http:${f.id}`,
      },
    });
    const headersFor = async (who: string) => {
      const cookie = testCookie(who);
      const identity = await (
        await fetch(`${base}/api/identity`, { headers: { Cookie: cookie } })
      ).json();
      return {
        Origin: base,
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-Identity-Scope": identity.data.scope,
      };
    };
    const headers = await headersFor(recipient);
    const guestsBefore = await db.guestIdentity.count();
    const anonymous = await fetch(`${base}/api/notifications`);
    assert.equal(anonymous.status, 200);
    assert.equal(anonymous.headers.get("set-cookie"), null);
    assert.equal((await anonymous.json()).data.total, 0);
    assert.equal(await db.guestIdentity.count(), guestsBefore);
    const inbox = await fetch(`${base}/api/notifications`, { headers });
    assert.equal(inbox.headers.get("cache-control"), "no-store");
    const json = await inbox.json();
    assert.equal(json.data.total, 1);
    assert.equal(JSON.stringify(json).includes(digest(recipient)), false);
    for (const query of [
      "?page=1&page=2",
      "?unread=all&unread=unread",
      "?page=1e2",
      "?unread=0",
    ])
      assert.equal(
        (await fetch(`${base}/api/notifications${query}`, { headers })).status,
        400,
      );
    const send = (data: unknown, requestHeaders = headers) =>
      fetch(`${base}/api/notifications`, {
        method: "PATCH",
        headers: requestHeaders,
        body: JSON.stringify(data),
      });
    assert.equal(
      (await send({ id: row.id }, { ...headers, Origin: "https://other.test" }))
        .status,
      403,
    );
    assert.equal(
      (await send({ id: row.id }, { ...headers, "X-Identity-Scope": "stale" }))
        .status,
      409,
    );
    assert.equal(
      (await send({ id: row.id }, await headersFor(outsider))).status,
      404,
    );
    assert.equal((await send({ id: row.id, all: true })).status, 400);
    assert.equal((await send({ id: row.id })).status, 200);
    assert.equal((await send({ id: row.id })).status, 200);
    assert.equal(await unreadNotificationCount(recipient), 0);
  },
);
