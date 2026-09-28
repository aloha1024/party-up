import "./support/isolated";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../server/db";
import {
  registerUser,
  loginUser,
  changeUserPassword,
  rotateRecovery,
  recoverUser,
  manageUser,
  revokeUserSessions,
  updateProfile,
} from "../server/user-accounts";
import {
  resolveViewer,
  publicViewer,
  viewerContext,
  digest,
} from "../server/user-identity";
import { previewGuestClaim, claimGuestRecords } from "../server/guest-claims";
import {
  createReservation,
  joinReservation,
  joinWaitlist,
  leaveReservation,
  detail,
  removeRosterEntry,
} from "../server/reservations";
import { reservationTemplate } from "../server/reservation-template";
import { calendarReservation } from "../server/reservation-calendar";
import {
  currentInvitation,
  rotateInvitation,
  acceptInvitation,
} from "../server/reservation-invitations";
import { listMyReservations } from "../server/reservation-list";
import { rosterRemovals } from "../server/roster-removals";
const guest = () => randomBytes(32).toString("hex");
const password = "test-account-password-2026";
const ids: string[] = [],
  users: string[] = [];
const actor = { id: 990021, username: "user-manager" };
const input = () => ({
  gameName: "Account-" + randomUUID(),
  hostName: "Host",
  scheduledAt: new Date(Date.now() + 86400000).toISOString(),
  maxPlayers: 2,
});
async function account(token?: string) {
  const username = "u_" + randomUUID().replaceAll("-", "").slice(0, 22);
  const auth = await registerUser({ username, nickname: "Nick", password });
  const viewer = await resolveViewer(auth.token, token);
  users.push(viewer.user!.id);
  return { ...auth, username, viewer };
}
async function create(token: string, visibility = "PUBLIC") {
  const r = await createReservation({ ...input(), visibility }, token);
  ids.push(r.id);
  return r;
}
after(async () => {
  await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
  await db.adminAuditLog.deleteMany({ where: { actorId: actor.id } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});
test("accounts: registration, shared device identity, recovery, password reset, disable and revocation", async () => {
  const a = await account();
  await assert.rejects(
    registerUser({
      username: a.username.toUpperCase(),
      nickname: "Another",
      password,
    }),
    { code: "USERNAME_TAKEN" },
  );
  for (const username of [a.username, "no_such_account"])
    await assert.rejects(
      loginUser({ username, password: "incorrect-password" }),
      { code: "USER_CREDENTIALS" },
    );
  const second = await loginUser({ username: a.username, password });
  const v2 = await resolveViewer(second.token);
  assert.equal(v2.token, a.viewer.token);
  assert.notEqual(v2.scope, a.viewer.scope);
  assert.equal(v2.storageKey, a.viewer.storageKey);
  assert.equal(JSON.stringify(publicViewer(v2)).includes(v2.token!), false);
  const r = await create(a.viewer.token!, "INVITE");
  await updateProfile(a.viewer, { nickname: "Changed default" });
  assert.equal((await detail(r.id, a.viewer.token)).hostName, "Host");
  assert.equal(
    (await detail(r.id, a.viewer.token)).participants[0].name,
    "Host",
  );
  assert.equal(
    (await listMyReservations({ tab: "hosted" }, v2.token)).items.some(
      (x) => x.id === r.id,
    ),
    true,
  );
  await manageUser(a.viewer.user!.id, { action: "disable", version: 0 }, actor);
  assert.equal((await resolveViewer(second.token)).mode, "invalid");
  await assert.rejects(
    viewerContext.run(v2, () =>
      joinReservation(r.id, { name: "No" }, v2.token!),
    ),
    { code: "USER_SESSION" },
  );
  assert.equal(
    await db.participant.count({ where: { reservationId: r.id } }),
    1,
  );
  await manageUser(
    a.viewer.user!.id,
    { action: "reset", version: 1, password: "temporary-password" },
    actor,
  );
  await assert.rejects(
    loginUser({ username: a.username, password: "temporary-password" }),
  );
  await manageUser(a.viewer.user!.id, { action: "enable", version: 2 }, actor);
  const login = await loginUser({
    username: a.username,
    password: "temporary-password",
  });
  const limited = await resolveViewer(login.token);
  assert.equal(publicViewer(limited).ready, false);
  await assert.rejects(reservationTemplate(r.id, limited.token), {
    code: "REGISTRATION_REQUIRED",
  });
  await changeUserPassword(limited, {
    currentPassword: "temporary-password",
    password,
  });
  assert.equal((await resolveViewer(login.token)).mode, "invalid");
  const fresh = await resolveViewer(
    (await loginUser({ username: a.username, password })).token,
  );
  const recovery = await rotateRecovery(fresh, { password });
  await assert.rejects(
    recoverUser({
      username: a.username,
      recoveryCode: a.recoveryCode,
      password,
    }),
  );
  await recoverUser({
    username: a.username,
    recoveryCode: recovery.recoveryCode,
    password: password + "new",
  });
  await assert.rejects(
    recoverUser({
      username: a.username,
      recoveryCode: recovery.recoveryCode,
      password,
    }),
  );
  const final = await resolveViewer(
    (await loginUser({ username: a.username, password: password + "new" }))
      .token,
  );
  await revokeUserSessions(final);
  assert.equal(
    await db.userSession.count({ where: { userId: final.user!.id } }),
    0,
  );
});
test("guest capabilities preserve public hosting, membership and existing invitation management", async () => {
  const token = guest();
  const r = await create(token);
  await assert.rejects(
    createReservation({ ...input(), visibility: "INVITE" }, token),
    { code: "REGISTRATION_REQUIRED" },
  );
  await assert.rejects(reservationTemplate(r.id, token), {
    code: "REGISTRATION_REQUIRED",
  });
  await assert.rejects(calendarReservation(r.id, token), {
    code: "REGISTRATION_REQUIRED",
  });
  const { newInvitation } = await import("../server/invitation-credential");
  await db.gameReservation.update({
    where: { id: r.id },
    data: { visibility: "INVITE", ...newInvitation() },
  });
  const invitation = await currentInvitation(r.id, token);
  const visitor = guest();
  await acceptInvitation(
    r.id,
    { token: invitation.path.split("#invite=")[1] },
    visitor,
  );
  await joinReservation(r.id, { name: "Guest" }, visitor);
  assert.equal((await detail(r.id, visitor)).participants.length, 2);
});
test("claims preserve IDs, attendance, private history and creation results; stale requests and retries are safe", async () => {
  const g = guest(),
    oldViewer = await resolveViewer(undefined, g),
    a = await account(g);
  const r = await create(g);
  await db.participant.updateMany({
    where: { reservationId: r.id },
    data: { checkedInAt: new Date(), attendanceVersion: 3 },
  });
  await db.rosterRemoval.create({
    data: {
      reservationId: r.id,
      kind: "participants",
      entryId: "removed",
      targetTokenHash: digest(g),
      targetName: "Old",
      reason: "Private reason",
      actorRole: "HOST",
    },
  });
  const before = await detail(r.id, g),
    preview = await previewGuestClaim(a.viewer);
  const submission = {
    key: randomUUID(),
    fingerprint: preview.fingerprint,
    ids: [r.id],
  };
  const result = await claimGuestRecords(a.viewer, submission);
  assert.equal(result.retired, true);
  assert.deepEqual(await claimGuestRecords(a.viewer, submission), result);
  const after = await detail(r.id, a.viewer.token);
  assert.equal(after.isHost, true);
  assert.deepEqual(after.participants, before.participants);
  assert.equal(
    (await rosterRemovals(r.id, a.viewer.token)).items[0].reason,
    "Private reason",
  );
  assert.equal((await rosterRemovals(r.id, g)).items.length, 0);
  assert.equal((await resolveViewer(undefined, g)).mode, "anonymous");
  await assert.rejects(
    viewerContext.run(oldViewer, () => createReservation(input(), g)),
    { code: "IDENTITY_CHANGED" },
  );
  assert.equal(
    (
      await db.creationRequest.findFirstOrThrow({
        where: { reservationId: r.id },
      })
    ).ownerTokenHash,
    digest(a.viewer.token!),
  );
});
test("claims explicitly exclude duplicate historic memberships and serialize against guest changes", async () => {
  const g = guest(),
    a = await account(g),
    r = await create(g),
    other = await create(g);
  await joinReservation(r.id, { name: "Account member" }, a.viewer.token!);
  await db.gameReservation.update({
    where: { id: r.id },
    data: { scheduledAt: new Date(0) },
  });
  const preview = await previewGuestClaim(a.viewer);
  assert.ok(preview.items.find((i) => i.id === r.id)!.conflict);
  await assert.rejects(
    claimGuestRecords(a.viewer, {
      key: randomUUID(),
      fingerprint: preview.fingerprint,
      ids: [r.id, other.id],
    }),
    { code: "CLAIM_CONFLICT" },
  );
  const result = await claimGuestRecords(a.viewer, {
    key: randomUUID(),
    fingerprint: preview.fingerprint,
    ids: [other.id],
  });
  assert.equal(result.retired, false);
  assert.equal((await detail(r.id, g)).isHost, true);
  assert.equal((await detail(other.id, a.viewer.token)).isHost, true);
  const fresh = await previewGuestClaim(a.viewer),
    newR = await create(g);
  await assert.rejects(
    claimGuestRecords(a.viewer, {
      key: randomUUID(),
      fingerprint: fresh.fingerprint,
      ids: [r.id],
    }),
    { code: "CLAIM_STALE" },
  );
});
test("claim storage failure rolls back every ownership update; invitation version remains revoked", async () => {
  const owner = await account(),
    r = await create(owner.viewer.token!, "INVITE"),
    g = guest(),
    target = await account(g);
  const invitation = await currentInvitation(r.id, owner.viewer.token!);
  await acceptInvitation(
    r.id,
    { token: invitation.path.split("#invite=")[1] },
    g,
  );
  await rotateInvitation(
    r.id,
    { expectedVersion: invitation.version },
    owner.viewer.token!,
  );
  const owned = await create(g),
    preview = await previewGuestClaim(target.viewer);
  await db.$executeRawUnsafe(
    "CREATE TRIGGER fail_guest_claim BEFORE INSERT ON GuestClaim BEGIN SELECT RAISE(ABORT, 'test failure'); END",
  );
  try {
    await assert.rejects(
      claimGuestRecords(target.viewer, {
        key: randomUUID(),
        fingerprint: preview.fingerprint,
        ids: [owned.id, r.id],
      }),
    );
  } finally {
    await db.$executeRawUnsafe("DROP TRIGGER fail_guest_claim");
  }
  assert.equal((await detail(owned.id, g)).isHost, true);
  const next = await previewGuestClaim(target.viewer);
  await claimGuestRecords(target.viewer, {
    key: randomUUID(),
    fingerprint: next.fingerprint,
    ids: [owned.id, r.id],
  });
  await assert.rejects(detail(r.id, target.viewer.token), {
    code: "INVITATION_REQUIRED",
  });
});

test("claim races with guest join, leave, creation and waitlist promotion without splitting ownership", async () => {
  for (const action of ["join", "leave", "create", "promote"] as const) {
    const g = guest(),
      owner = guest(),
      a = await account(g),
      old = await resolveViewer(undefined, g);
    const owned = await create(g),
      r = await create(owner);
    if (action === "leave") await joinReservation(r.id, { name: "Guest" }, g);
    if (action === "promote") {
      await joinReservation(r.id, { name: "Other" }, guest());
      await joinWaitlist(r.id, { name: "Guest" }, g);
    }
    const preview = await previewGuestClaim(a.viewer);
    const claim = {
      key: randomUUID(),
      fingerprint: preview.fingerprint,
      ids: preview.items.map((i) => i.id),
    };
    const mutation = () =>
      action === "join"
        ? joinReservation(r.id, { name: "Guest" }, g)
        : action === "leave"
          ? leaveReservation(r.id, g)
          : action === "promote"
            ? leaveReservation(r.id, owner)
            : create(g);
    const [linked, changed] = await Promise.allSettled([
      claimGuestRecords(a.viewer, claim),
      action === "promote" ? mutation() : viewerContext.run(old, mutation),
    ]);
    const all = await db.participant.findMany({
      where: { reservationId: r.id },
    });
    const waiting = await db.waitlistEntry.findMany({
      where: { reservationId: r.id },
    });
    assert.ok(all.length <= 2);
    assert.equal(
      new Set([...all, ...waiting].map((p) => p.tokenHash)).size,
      all.length + waiting.length,
    );
    if (linked.status === "fulfilled") {
      assert.equal((await detail(owned.id, a.viewer.token)).isHost, true);
      assert.equal(
        [...all, ...waiting].some((p) => p.tokenHash === digest(g)),
        false,
      );
      if (action !== "promote") assert.equal(changed.status, "rejected");
    } else {
      assert.ok(["CLAIM_STALE", "BUSY"].includes(linked.reason.code));
      assert.equal((await detail(owned.id, g)).isHost, true);
    }
  }
});

test("admin reset audit failure rolls back credentials, session and recovery; expired sessions cannot fall back to guests", async () => {
  const a = await account(guest());
  const before = await db.user.findUniqueOrThrow({
    where: { id: a.viewer.user!.id },
  });
  await db.$executeRawUnsafe(
    "CREATE TRIGGER fail_user_audit BEFORE INSERT ON AdminAuditLog BEGIN SELECT RAISE(ABORT, 'test failure'); END",
  );
  try {
    await assert.rejects(
      manageUser(
        before.id,
        { action: "reset", version: 0, password: "temporary-password" },
        actor,
      ),
    );
  } finally {
    await db.$executeRawUnsafe("DROP TRIGGER fail_user_audit");
  }
  assert.deepEqual(
    await db.user.findUniqueOrThrow({ where: { id: before.id } }),
    before,
  );
  assert.equal(
    (await resolveViewer(a.token, a.viewer.guestToken)).mode,
    "user",
  );
  await db.userSession.update({
    where: { id: digest(a.token) },
    data: { expiresAt: new Date(0) },
  });
  const invalid = await resolveViewer(a.token, a.viewer.guestToken);
  assert.equal(invalid.mode, "invalid");
  assert.equal(invalid.token, undefined);
  await assert.rejects(
    viewerContext.run(a.viewer, () =>
      createReservation(input(), a.viewer.token!),
    ),
    { code: "USER_SESSION" },
  );
});

test("claims retain soft-deleted records and creation tombstones and reject colliding submission keys", async () => {
  const g = guest(),
    a = await account(g),
    r = await create(g),
    tombstone = await create(g);
  await db.gameReservation.update({
    where: { id: r.id },
    data: { deletedAt: new Date() },
  });
  await db.gameReservation.delete({ where: { id: tombstone.id } });
  const old = await db.creationRequest.findFirstOrThrow({
    where: { reservationId: r.id },
  });
  const collision = await db.creationRequest.create({
    data: {
      ownerTokenHash: digest(a.viewer.token!),
      key: old.key,
      inputHash: old.inputHash,
      reservationId: randomUUID(),
    },
  });
  const blocked = await previewGuestClaim(a.viewer);
  assert.equal(
    blocked.items.find((i) => i.id === r.id)?.conflict,
    "创建提交编号冲突",
  );
  await db.creationRequest.delete({ where: { id: collision.id } });
  const preview = await previewGuestClaim(a.viewer);
  assert.equal(preview.items.length, 2);
  assert.ok(preview.items.every((i) => !i.canOpen));
  const submission = {
    key: randomUUID(),
    fingerprint: preview.fingerprint,
    ids: [r.id, tombstone.id],
  };
  await claimGuestRecords(a.viewer, submission);
  assert.equal(
    (await db.gameReservation.findUniqueOrThrow({ where: { id: r.id } }))
      .hostTokenHash,
    digest(a.viewer.token!),
  );
  assert.equal(
    await db.creationRequest.count({
      where: {
        reservationId: { in: submission.ids },
        ownerTokenHash: digest(a.viewer.token!),
      },
    }),
    2,
  );
  await assert.rejects(
    claimGuestRecords(a.viewer, { ...submission, ids: [r.id] }),
    { code: "CLAIM_CHANGED" },
  );
});
