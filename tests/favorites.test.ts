import "./support/isolated";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../server/db";
import { registeredToken, testCookie } from "./support/member";
import { digest, resolveViewer, type Viewer } from "../server/user-identity";
import {
  createReservation,
  deleteReservation,
  restoreReservation,
  purgeReservation,
  joinReservation,
  joinWaitlist,
  leaveReservation,
} from "../server/reservations";
import {
  acceptInvitation,
  currentInvitation,
  rotateInvitation,
} from "../server/reservation-invitations";
import {
  listFavorites,
  readFavoriteStatus,
  setFavorite,
} from "../server/reservation-favorites";

const ids: string[] = [],
  users: string[] = [];
const guest = () => randomBytes(32).toString("hex");
const actor = { id: 930021, username: "favorites-test-admin" };
async function account() {
  const token = await registeredToken();
  const cookie = testCookie(token);
  const viewer = await resolveViewer(cookie.split("=")[1]);
  users.push(viewer.user!.id);
  return { token, viewer, cookie };
}
async function reservation(owner = guest(), visibility = "PUBLIC") {
  const result = await createReservation(
    {
      gameName: "Favorite-" + randomUUID(),
      hostName: "收藏队长",
      maxPlayers: 2,
      scheduledAt: new Date(Date.now() + 2 * 86400000).toISOString(),
      visibility,
      description: "不应出现在收藏摘要中的备注",
    },
    owner,
  );
  ids.push(result.id);
  return result;
}
async function status(id: string, token?: string) {
  return db.$transaction(async (tx) =>
    readFavoriteStatus(
      tx,
      await tx.gameReservation.findUniqueOrThrow({ where: { id } }),
      token,
    ),
  );
}
after(async () => {
  await db.adminAuditLog.deleteMany({ where: { targetId: { in: ids } } });
  await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

test("favorites are account private and concurrent idempotent writes never mutate a reservation or its roster", async () => {
  const first = await account(),
    second = await account(),
    r = await reservation();
  const snapshot = () =>
    db.gameReservation.findUniqueOrThrow({
      where: { id: r.id },
      include: {
        participants: true,
        waitlist: true,
        access: true,
        changes: true,
        notifications: true,
      },
    });
  const before = await snapshot();
  assert.equal(await status(r.id, guest()), null);
  assert.equal(await status(r.id), null);
  assert.deepEqual(await status(r.id, first.token), {
    saved: false,
    allowed: true,
  });
  assert.deepEqual(
    await Promise.all([
      setFavorite(first.viewer, r.id, true),
      setFavorite(first.viewer, r.id, true),
    ]),
    [{ saved: true }, { saved: true }],
  );
  const saved = await db.userReservationFavorite.findMany({
    where: { reservationId: r.id },
  });
  assert.equal(saved.length, 1);
  await setFavorite(first.viewer, r.id, true);
  assert.deepEqual(
    await db.userReservationFavorite.findMany({
      where: { reservationId: r.id },
    }),
    saved,
  );
  assert.deepEqual(await status(r.id, first.token), {
    saved: true,
    allowed: true,
  });
  assert.deepEqual(await status(r.id, second.token), {
    saved: false,
    allowed: true,
  });
  assert.equal((await listFavorites(first.viewer)).total, 1);
  assert.equal((await listFavorites(second.viewer)).total, 0);
  assert.deepEqual(await setFavorite(second.viewer, r.id, false), {
    saved: false,
  });
  assert.equal((await listFavorites(first.viewer)).total, 1);
  await setFavorite(second.viewer, r.id, true);
  await setFavorite(first.viewer, r.id, false);
  assert.deepEqual(await setFavorite(first.viewer, r.id, false), {
    saved: false,
  });
  assert.equal((await listFavorites(second.viewer)).total, 1);
  assert.deepEqual(await setFavorite(first.viewer, randomUUID(), false), {
    saved: false,
  });
  assert.deepEqual(await snapshot(), before);
});

test("invitation rotation hides saved nonmembers without granting access while current and historical members retain favorites", async () => {
  const host = await account(),
    visitor = await account(),
    historical = await account(),
    member = await account(),
    waiter = await account();
  const r = await reservation(host.token, "INVITE");
  const invitation = await currentInvitation(r.id, host.token);
  for (const person of [visitor, historical, member, waiter]) {
    await acceptInvitation(
      r.id,
      { token: invitation.path.split("#invite=")[1] },
      person.token,
    );
    await setFavorite(person.viewer, r.id, true);
  }
  await setFavorite(host.viewer, r.id, true);
  await joinReservation(r.id, { name: "历史成员" }, historical.token);
  await leaveReservation(r.id, historical.token);
  await joinReservation(r.id, { name: "正式成员" }, member.token);
  await joinWaitlist(r.id, { name: "候补成员" }, waiter.token);
  // Current membership remains a read grant even for legacy rows without access history.
  await db.reservationAccess.deleteMany({
    where: {
      reservationId: r.id,
      tokenHash: { in: [digest(member.token), digest(waiter.token)] },
    },
  });
  await rotateInvitation(
    r.id,
    { expectedVersion: invitation.version },
    host.token,
  );
  assert.equal((await listFavorites(visitor.viewer)).total, 0);
  assert.deepEqual(await status(r.id, visitor.token), {
    saved: true,
    allowed: false,
  });
  assert.equal(
    await db.userReservationFavorite.count({
      where: { userId: visitor.viewer.user!.id, reservationId: r.id },
    }),
    1,
  );
  await assert.rejects(setFavorite(visitor.viewer, r.id, true), {
    status: 404,
  });
  for (const person of [host, historical, member, waiter]) {
    assert.equal((await listFavorites(person.viewer)).items[0].id, r.id);
    assert.deepEqual(await status(r.id, person.token), {
      saved: true,
      allowed: true,
    });
  }
  const latest = await currentInvitation(r.id, host.token);
  await acceptInvitation(
    r.id,
    { token: latest.path.split("#invite=")[1] },
    visitor.token,
  );
  assert.equal((await listFavorites(visitor.viewer)).items[0].id, r.id);
  await rotateInvitation(r.id, { expectedVersion: latest.version }, host.token);
  assert.deepEqual(await setFavorite(visitor.viewer, r.id, false), {
    saved: false,
  });
  assert.deepEqual(await setFavorite(visitor.viewer, r.id, false), {
    saved: false,
  });
  assert.equal(
    await db.userReservationFavorite.count({
      where: { userId: visitor.viewer.user!.id },
    }),
    0,
  );
});

test("soft deletion hides favorites, restoration restores visibility, and permanent deletion cascades", async () => {
  const owner = await account(),
    other = await account(),
    r = await reservation();
  for (const person of [owner, other])
    await setFavorite(person.viewer, r.id, true);
  await deleteReservation(r.id, actor);
  assert.equal((await listFavorites(owner.viewer)).total, 0);
  assert.equal(
    await db.userReservationFavorite.count({ where: { reservationId: r.id } }),
    2,
  );
  await assert.rejects(setFavorite(owner.viewer, r.id, true), { status: 404 });
  assert.deepEqual(await setFavorite(other.viewer, r.id, false), {
    saved: false,
  });
  await restoreReservation(r.id, actor);
  assert.equal((await listFavorites(owner.viewer)).items[0].id, r.id);
  assert.equal((await listFavorites(other.viewer)).total, 0);
  await deleteReservation(r.id, actor);
  await purgeReservation(r.id, actor);
  assert.equal(
    await db.userReservationFavorite.count({ where: { reservationId: r.id } }),
    0,
  );
  assert.deepEqual(await setFavorite(owner.viewer, r.id, false), {
    saved: false,
  });
});

test("favorites filter before pagination and expose only summaries, with Beijing date and availability semantics", async () => {
  const { viewer } = await account(),
    q = "Fav-filter-" + randomUUID();
  const now = new Date("2035-01-01T12:00:00Z");
  const rows = [
    { scheduledAt: new Date("2035-01-01T16:00:00Z") },
    { scheduledAt: new Date("2035-01-02T15:59:59Z") },
    { platform: "PS5" },
    { gameServer: "欧洲" },
    { status: "CANCELLED" },
    { scheduledAt: new Date("2035-01-02T16:00:00Z") },
    { registrationDeadline: new Date("2035-01-01T11:00:00Z") },
    { recruitmentPaused: true },
    { deletedAt: new Date() },
    { visibility: "INVITE" },
  ];
  const created: string[] = [];
  for (const [index, row] of rows.entries()) {
    const r = await db.gameReservation.create({
      data: {
        gameName: `${q}-${index}`,
        hostName: "收藏筛选队长",
        platform: "PC Windows",
        gameServer: "亚洲一区",
        maxPlayers: 3,
        scheduledAt: new Date("2035-01-02T00:00:00Z"),
        description: "private-description",
        meetingCipher: "private-meeting-cipher",
        hostTokenHash: "private-host-token",
        ...row,
      },
    });
    ids.push(r.id);
    created.push(r.id);
    await db.userReservationFavorite.create({
      data: { userId: viewer.user!.id, reservationId: r.id },
    });
  }
  const filters = {
    q,
    platform: " PC ",
    gameServer: " 亚洲 ",
    view: "available",
    date: "2035-01-02",
    pageSize: 1,
  };
  const first = await listFavorites(viewer, filters, now),
    second = await listFavorites(viewer, { ...filters, page: 2 }, now);
  assert.deepEqual(
    [first.total, first.pageCount, first.items[0].id, second.items[0].id],
    [2, 2, created[0], created[1]],
  );
  assert.equal(first.filters.platform, "PC");
  assert.equal(first.filters.gameServer, "亚洲");
  assert.equal(first.items[0].platform, "PC Windows");
  assert.equal(first.items[0].gameServer, "亚洲一区");
  assert.equal(first.items[0].status, "OPEN");
  assert.equal(
    /private-|userId|tokenHash|meetingCipher|participants|inviteCipher/.test(
      JSON.stringify(first),
    ),
    false,
  );
  const clamped = await listFavorites(viewer, { ...filters, page: 99 }, now);
  assert.deepEqual(
    [clamped.page, clamped.filters.page, clamped.items[0].id],
    [2, 2, created[1]],
  );
  assert.equal((await listFavorites(viewer, { q }, now)).total, 8);
  assert.equal(
    (await listFavorites(viewer, { q, view: "cancelled" }, now)).items[0].id,
    created[4],
  );
  const empty = await listFavorites(
    viewer,
    { q, platform: "不存在", page: 5 },
    now,
  );
  assert.deepEqual(
    [empty.total, empty.page, empty.pageCount, empty.items.length],
    [0, 1, 1, 0],
  );
});

test("favorite reads and writes reject guests and recheck expired, revoked, disabled or forced-password accounts", async () => {
  const r = await reservation();
  const denied = async (viewer: Viewer) => {
    for (const action of [
      () => listFavorites(viewer),
      () => setFavorite(viewer, r.id, true),
      () => setFavorite(viewer, r.id, false),
    ])
      await assert.rejects(action, { code: "USER_SESSION" });
  };
  for (const viewer of [
    await resolveViewer(),
    await resolveViewer(undefined, guest()),
    await resolveViewer("invalid"),
  ])
    await denied(viewer);
  for (const state of [
    "expired",
    "revoked",
    "version",
    "disabled",
    "password",
  ]) {
    const { viewer, cookie } = await account();
    await setFavorite(viewer, r.id, true);
    if (state === "expired")
      await db.userSession.update({
        where: { id: viewer.sessionHash! },
        data: { expiresAt: new Date(0) },
      });
    else if (state === "revoked")
      await db.userSession.delete({ where: { id: viewer.sessionHash! } });
    else
      await db.user.update({
        where: { id: viewer.user!.id },
        data:
          state === "version"
            ? { version: { increment: 1 } }
            : state === "disabled"
              ? { isActive: false }
              : { mustChangePassword: true },
      });
    await denied(viewer);
    await denied(await resolveViewer(cookie.split("=")[1]));
    assert.equal(
      await db.userReservationFavorite.count({
        where: { userId: viewer.user!.id },
      }),
      1,
    );
  }
});

test("favorites reject invalid IDs and list parameters before revealing records", async () => {
  const { viewer } = await account();
  for (const id of ["", "../other", "x".repeat(129), ["one", "two"]])
    await assert.rejects(setFavorite(viewer, id, true), { name: "ZodError" });
  for (const input of [
    { platform: "x".repeat(81) },
    { gameServer: ["a", "b"] },
    { page: 0 },
    { pageSize: 49 },
    { date: "2035-02-30" },
  ])
    await assert.rejects(listFavorites(viewer, input), { name: "ZodError" });
  assert.equal((await listFavorites(viewer)).total, 0);
});
