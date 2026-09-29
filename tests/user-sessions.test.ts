import "./support/isolated";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../server/db";
import {
  registerUser,
  loginUser,
  manageUser,
  changeUserPassword,
} from "../server/user-accounts";
import { listUserSessions, revokeUserSession } from "../server/user-sessions";
import { digest, resolveViewer, viewerContext } from "../server/user-identity";
import { createReservation } from "../server/reservations";
import { sessionDevice } from "../lib/user-sessions";
import { routeLabel } from "../server/request-log";

const users: string[] = [];
const password = "session-test-password";
async function account() {
  const username = "s_" + randomUUID().replaceAll("-", "").slice(0, 20);
  const auth = await registerUser(
    { username, nickname: "Member", password },
    "Mozilla/5.0 (Windows NT 10.0) Chrome/134.0 Safari/537.36",
  );
  const viewer = await resolveViewer(auth.token);
  users.push(viewer.user!.id);
  return { ...auth, username, viewer };
}
after(async () => {
  await db.adminAuditLog.deleteMany({ where: { actorId: 990032 } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

test("session list pages only current account/version and never exposes credential hashes", async () => {
  const a = await account(),
    b = await account();
  const now = new Date();
  await db.userSession.update({
    where: { id: a.viewer.sessionHash },
    data: { createdAt: now },
  });
  await db.userSession.createMany({
    data: Array.from({ length: 24 }, (_, i) => ({
      id: digest(randomBytes(32).toString("hex")),
      userId: a.viewer.user!.id,
      version: 0,
      expiresAt: new Date(now.getTime() + 86400000),
      createdAt: i === 23 ? null : new Date(now.getTime() - 1000),
    })),
  });
  await db.userSession.createMany({
    data: [
      {
        id: "expired-" + randomUUID(),
        userId: a.viewer.user!.id,
        version: 0,
        expiresAt: now,
      },
      {
        id: "old-version-" + randomUUID(),
        userId: a.viewer.user!.id,
        version: 1,
        expiresAt: new Date(now.getTime() + 86400000),
      },
    ],
  });
  const first = await listUserSessions(a.viewer, undefined, now);
  assert.equal(first.total, 25);
  assert.equal(first.items.length, 20);
  assert.equal(first.pageCount, 2);
  assert.equal(first.items[0].current, true);
  assert.equal(first.items[0].browser, "Chrome");
  assert.equal(first.items[0].os, "Windows");
  const last = await listUserSessions(a.viewer, "999", now);
  assert.equal(last.page, 2);
  assert.equal(last.items.length, 5);
  assert.equal(last.items.at(-1)!.createdAt, null);
  const all = [...first.items, ...last.items];
  assert.equal(new Set(all.map((row) => row.id)).size, 25);
  assert.deepEqual(
    all.slice(1, -1).map((row) => row.id),
    all
      .slice(1, -1)
      .map((row) => row.id)
      .sort(),
  );
  assert.deepEqual(Object.keys(all[0]).sort(), [
    "browser",
    "createdAt",
    "current",
    "expiresAt",
    "id",
    "os",
  ]);
  for (const secret of [
    a.token,
    a.viewer.sessionHash!,
    a.viewer.token!,
    a.viewer.user!.identityKey,
    b.viewer.sessionHash!,
  ])
    assert.equal(JSON.stringify(first).includes(secret), false);
  assert.equal((await listUserSessions(b.viewer)).total, 1);
  for (const page of ["0", "-1", "1.2", "01", "1e2", "100001", ["1", "2"]])
    await assert.rejects(listUserSessions(a.viewer, page));
});

test("single revocation is scoped, idempotent and preserves other logins and user version", async () => {
  const a = await account(),
    b = await account();
  const second = await loginUser(
    { username: a.username, password },
    "Mozilla/5.0 (X11; Linux) Firefox/140.0",
  );
  const v2 = await resolveViewer(second.token);
  const target = (await listUserSessions(a.viewer)).items.find(
    (row) => !row.current,
  )!;
  assert.equal(target.browser, "Firefox");
  const foreign = (await listUserSessions(b.viewer)).items[0].id;
  assert.deepEqual(await revokeUserSession(a.viewer, foreign), {
    revoked: true,
    current: false,
  });
  assert.deepEqual(await revokeUserSession(a.viewer, randomUUID()), {
    revoked: true,
    current: false,
  });
  assert.equal((await resolveViewer(b.token)).mode, "user");
  await assert.rejects(revokeUserSession(a.viewer, a.viewer.sessionHash));
  const results = await Promise.all([
    revokeUserSession(a.viewer, target.id),
    revokeUserSession(a.viewer, target.id),
  ]);
  assert.deepEqual(results, [
    { revoked: true, current: false },
    { revoked: true, current: false },
  ]);
  assert.equal((await resolveViewer(second.token)).mode, "invalid");
  assert.equal((await resolveViewer(a.token)).mode, "user");
  assert.equal(
    (await db.user.findUniqueOrThrow({ where: { id: a.viewer.user!.id } }))
      .version,
    0,
  );
  await assert.rejects(listUserSessions(v2), { code: "USER_SESSION" });
  await assert.rejects(
    viewerContext.run(v2, () =>
      createReservation(
        {
          gameName: "Revoked",
          hostName: "Member",
          maxPlayers: 2,
          scheduledAt: new Date(Date.now() + 86400000).toISOString(),
        },
        v2.token!,
      ),
    ),
    { code: "USER_SESSION" },
  );
  const current = (await listUserSessions(a.viewer)).items[0];
  assert.deepEqual(await revokeUserSession(a.viewer, current.id), {
    revoked: true,
    current: true,
  });
  assert.equal((await resolveViewer(a.token)).mode, "invalid");
});

test("session reads and revocations reject guest, forced change, disabled and expired identities", async () => {
  for (const viewer of [
    await resolveViewer(),
    await resolveViewer(undefined, randomBytes(32).toString("hex")),
    await resolveViewer("bad-cookie"),
  ]) {
    await assert.rejects(listUserSessions(viewer), { code: "USER_SESSION" });
    await assert.rejects(revokeUserSession(viewer, randomUUID()), {
      code: "USER_SESSION",
    });
  }
  const a = await account();
  const own = (await listUserSessions(a.viewer)).items[0].id;
  await db.userSession.update({
    where: { id: a.viewer.sessionHash },
    data: { expiresAt: new Date(0) },
  });
  await assert.rejects(listUserSessions(a.viewer), { code: "USER_SESSION" });
  await assert.rejects(revokeUserSession(a.viewer, own), {
    code: "USER_SESSION",
  });
  const b = await account();
  await manageUser(
    b.viewer.user!.id,
    { action: "disable", version: 0 },
    { id: 990032, username: "manager" },
  );
  await assert.rejects(revokeUserSession(b.viewer, randomUUID()), {
    code: "USER_SESSION",
  });
  await assert.rejects(listUserSessions(b.viewer), { code: "USER_SESSION" });
  const c = await account();
  await manageUser(
    c.viewer.user!.id,
    { action: "reset", version: 0, password },
    { id: 990032, username: "manager" },
  );
  const limited = await resolveViewer(
    (await loginUser({ username: c.username, password })).token,
  );
  await assert.rejects(listUserSessions(limited), { code: "USER_SESSION" });
  await assert.rejects(revokeUserSession(limited, randomUUID()), {
    code: "USER_SESSION",
  });
});

test("concurrent password reset and single revocation leave no active stale sessions", async () => {
  const a = await account();
  const second = await loginUser({ username: a.username, password });
  const target = (await listUserSessions(a.viewer)).items.find(
    (row) => !row.current,
  )!;
  const results = await Promise.allSettled([
    changeUserPassword(a.viewer, {
      currentPassword: password,
      password: password + "new",
    }),
    revokeUserSession(a.viewer, target.id),
  ]);
  assert.equal(results[0].status, "fulfilled");
  if (results[1].status === "rejected")
    assert.equal(results[1].reason.code, "USER_SESSION");
  assert.equal((await resolveViewer(a.token)).mode, "invalid");
  assert.equal((await resolveViewer(second.token)).mode, "invalid");
  assert.equal(
    await db.userSession.count({ where: { userId: a.viewer.user!.id } }),
    0,
  );
});

test("single revocation failure rolls back without removing other sessions", async () => {
  const a = await account();
  const target = (await listUserSessions(a.viewer)).items[0].id;
  await db.$executeRawUnsafe(
    "CREATE TRIGGER fail_session_delete BEFORE DELETE ON UserSession BEGIN SELECT RAISE(ABORT, 'test'); END",
  );
  try {
    await assert.rejects(revokeUserSession(a.viewer, target));
    assert.equal((await resolveViewer(a.token)).mode, "user");
  } finally {
    await db.$executeRawUnsafe("DROP TRIGGER fail_session_delete");
  }
});

test("device labels are bounded categories and route logs omit management IDs", () => {
  assert.deepEqual(sessionDevice("secret cookie=PASSWORD"), {
    browser: null,
    os: null,
  });
  assert.deepEqual(
    sessionDevice("Mozilla/5.0 (iPhone) Version/18.0 Mobile Safari/604.1"),
    { browser: "Safari", os: "iOS" },
  );
  assert.deepEqual(
    sessionDevice("Mozilla/5.0 (Android) Chrome/120 Safari/537 EdgA/120"),
    { browser: "Edge", os: "Android" },
  );
  assert.deepEqual(sessionDevice("x".repeat(1024) + "Chrome/120 Windows"), {
    browser: null,
    os: null,
  });
  assert.equal(
    routeLabel("/api/user/sessions/" + randomUUID()),
    "/api/user/sessions/:id",
  );
  assert.equal(routeLabel("/api/user/sessions/all"), "/api/user/sessions/all");
});
