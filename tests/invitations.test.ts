import "./support/isolated";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../server/db";
import {
  createReservation,
  detail,
  joinReservation,
  joinWaitlist,
  leaveReservation,
  leaveWaitlist,
  editReservation,
  removeRosterEntry,
  deleteReservation,
  restoreReservation,
  purgeReservation,
  hashToken,
} from "../server/reservations";
import {
  currentInvitation,
  acceptInvitation,
  rotateInvitation,
} from "../server/reservation-invitations";
import {
  listReservations,
  listAdminReservations,
  listMyReservations,
} from "../server/reservation-list";
import { reservationHistory } from "../server/reservation-history";
import { rosterRemovals } from "../server/roster-removals";
import { calendarReservation } from "../server/reservation-calendar";
import { reservationTemplate } from "../server/reservation-template";
import {
  newInvitation,
  decryptInvitation,
} from "../server/invitation-credential";
import { ADMIN_COOKIE, createAdminSession } from "../server/admin-auth";
import { creationInputSchema, creationFingerprint } from "../lib/validation";
const token = () => randomBytes(32).toString("hex");
const ids: string[] = [];
const actor = { id: 200001, username: "invite-admin", sessionVersion: 0 };
const data = () => ({
  gameName: "Invitation-" + randomUUID(),
  hostName: "Host",
  maxPlayers: 2,
  description: "Private note",
  scheduledAt: new Date(Date.now() + 86400000).toISOString(),
});
async function fixture() {
  const owner = token(),
    input = data();
  const r = await createReservation({ ...input, visibility: "INVITE" }, owner);
  ids.push(r.id);
  const invitation = await currentInvitation(r.id, owner);
  return {
    r,
    owner,
    input,
    invitation,
    secret: invitation.path.split("#invite=")[1],
  };
}
after(async () => {
  await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
  await db.adminAuditLog.deleteMany({ where: { targetId: { in: ids } } });
  await db.adminCredential.deleteMany({ where: { id: actor.id } });
  await db.$disconnect();
});
test("invites are excluded before public counts/pagination and all related reads enforce access", async () => {
  const f = await fixture(),
    visitor = token();
  for (const view of ["all", "available", "upcoming"]) {
    assert.equal(
      (await listReservations({ q: f.input.gameName, view })).total,
      0,
    );
    assert.equal(
      (await listAdminReservations({ q: f.input.gameName, view })).total,
      1,
    );
  }
  assert.equal(
    (await listMyReservations({ tab: "hosted" }, f.owner)).items.some(
      (r) => r.id === f.r.id,
    ),
    true,
  );
  for (const read of [
    () => detail(f.r.id),
    () => detail(f.r.id, visitor),
    () => reservationHistory(f.r.id),
    () => rosterRemovals(f.r.id, visitor),
    () => calendarReservation(f.r.id, visitor),
  ])
    await assert.rejects(read, { status: 404 });
  await assert.rejects(currentInvitation(f.r.id, visitor), { status: 403 });
  await assert.rejects(acceptInvitation(f.r.id, { token: token() }, visitor), {
    code: "INVITATION_INVALID",
  });
  await assert.rejects(joinReservation(f.r.id, { name: "Visitor" }, visitor), {
    status: 404,
  });
  assert.equal((await detail(f.r.id, undefined, true)).id, f.r.id);
  await acceptInvitation(f.r.id, { token: f.secret }, visitor);
  const visible = await detail(f.r.id, visitor);
  assert.equal(visible.description, f.input.description);
  assert.equal(
    /inviteHash|inviteCipher|tokenHash/.test(JSON.stringify(visible)),
    false,
  );
  assert.equal(
    (await reservationHistory(f.r.id, undefined, visitor)).items.length,
    0,
  );
  await assert.rejects(
    editReservation(
      f.r.id,
      { ...f.input, visibility: "PUBLIC", editVersion: 0 },
      f.owner,
    ),
  );
});
test("rotation revokes nonmembers; current and historical members retain reads but rejoining requires a current grant", async () => {
  const f = await fixture(),
    guest = token(),
    waiter = token(),
    visitor = token();
  for (const who of [guest, waiter, visitor])
    await acceptInvitation(f.r.id, { token: f.secret }, who);
  await joinReservation(f.r.id, { name: "Guest" }, guest);
  await joinWaitlist(f.r.id, { name: "Waiter" }, waiter);
  await rotateInvitation(f.r.id, { expectedVersion: 1 }, f.owner);
  await assert.rejects(
    rotateInvitation(f.r.id, { expectedVersion: 1 }, f.owner),
    { code: "INVITATION_CHANGED" },
  );
  await assert.rejects(detail(f.r.id, visitor), { status: 404 });
  await assert.rejects(acceptInvitation(f.r.id, { token: f.secret }, visitor), {
    status: 404,
  });
  await detail(f.r.id, guest);
  await detail(f.r.id, waiter);
  await leaveReservation(f.r.id, guest);
  assert.equal(
    (await detail(f.r.id, waiter)).participants.some((p) => p.isMe),
    true,
  );
  await assert.rejects(joinWaitlist(f.r.id, { name: "Guest" }, guest), {
    status: 404,
  });
  const latest = await currentInvitation(f.r.id, f.owner);
  await acceptInvitation(
    f.r.id,
    { token: latest.path.split("#invite=")[1] },
    guest,
  );
  await joinWaitlist(f.r.id, { name: "Guest" }, guest);
  await leaveWaitlist(f.r.id, guest);
  await detail(f.r.id, guest);
  const row = (await detail(f.r.id, f.owner)).participants.find(
    (p) => p.name === "Waiter",
  )!;
  await removeRosterEntry(
    f.r.id,
    {
      kind: "participants",
      entryId: row.id,
      expectedName: row.name,
      reason: "private reason",
    },
    f.owner,
  );
  assert.equal(
    (await rosterRemovals(f.r.id, waiter)).items[0].reason,
    "private reason",
  );
  await assert.rejects(joinReservation(f.r.id, { name: "Waiter" }, waiter), {
    status: 404,
  });
  await deleteReservation(f.r.id, actor);
  await assert.rejects(detail(f.r.id, f.owner), { status: 404 });
  await restoreReservation(f.r.id, actor);
  await detail(f.r.id, waiter);
  const template = await reservationTemplate(f.r.id, f.owner);
  assert.equal(template.visibility, "INVITE");
  const copy = await createReservation(
    { ...template, scheduledAt: f.input.scheduledAt },
    f.owner,
  );
  ids.push(copy.id);
  assert.notEqual(
    (await currentInvitation(copy.id, f.owner)).path,
    latest.path,
  );
  await assert.rejects(detail(copy.id, waiter), { status: 404 });
  await deleteReservation(f.r.id, actor);
  await purgeReservation(f.r.id, actor);
  assert.equal(
    await db.reservationAccess.count({ where: { reservationId: f.r.id } }),
    0,
  );
});
test("public legacy fingerprints survive upgrade and invitation grants roll back on failed joins", async () => {
  const input = data(),
    owner = token(),
    key = token();
  const first = await createReservation(input, owner, key);
  ids.push(first.id);
  assert.equal(
    creationFingerprint(creationInputSchema.parse(input)),
    JSON.stringify({
      gameName: input.gameName,
      hostName: input.hostName,
      scheduledAt: input.scheduledAt,
      maxPlayers: input.maxPlayers,
      description: input.description,
    }),
  );
  assert.equal(
    (
      await db.creationRequest.findUniqueOrThrow({
        where: {
          ownerTokenHash_key: { ownerTokenHash: hashToken(owner), key },
        },
      })
    ).inputHash,
    hashToken(
      JSON.stringify({
        gameName: input.gameName,
        hostName: input.hostName,
        scheduledAt: input.scheduledAt,
        maxPlayers: input.maxPlayers,
        description: input.description,
      }),
    ),
  );
  assert.equal(
    (await createReservation({ ...input, visibility: "PUBLIC" }, owner, key))
      .id,
    first.id,
  );
  await assert.rejects(
    createReservation({ ...input, visibility: "INVITE" }, owner, key),
    { code: "SUBMISSION_CHANGED" },
  );
  const f = await fixture(),
    guest = token();
  await acceptInvitation(f.r.id, { token: f.secret }, guest);
  await assert.rejects(joinReservation(f.r.id, { name: "Host" }, guest), {
    code: "DUPLICATE",
  });
  assert.equal(
    (
      await db.reservationAccess.findFirstOrThrow({
        where: { reservationId: f.r.id, tokenHash: hashToken(guest) },
      })
    ).hasJoined,
    false,
  );
  await db.$executeRawUnsafe(
    `CREATE TRIGGER fail_invite_member BEFORE UPDATE OF hasJoined ON ReservationAccess WHEN NEW.hasJoined = 1 BEGIN SELECT RAISE(ABORT, 'test rollback'); END`,
  );
  try {
    await assert.rejects(joinReservation(f.r.id, { name: "Guest" }, guest));
    assert.equal((await detail(f.r.id, f.owner)).participants.length, 1);
  } finally {
    await db.$executeRawUnsafe("DROP TRIGGER fail_invite_member");
  }
  const results = await Promise.allSettled([
    rotateInvitation(f.r.id, { expectedVersion: 1 }, f.owner),
    rotateInvitation(f.r.id, { expectedVersion: 1 }, f.owner),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
});
test(
  "HTTP invitation access, validation, origin and privacy",
  { skip: !process.env.TEST_BASE_URL },
  async () => {
    const f = await fixture(),
      visitor = token(),
      base = process.env.TEST_BASE_URL!;
    const headers = {
      cookie: `party_identity=${visitor}`,
      origin: base,
      "content-type": "application/json",
    };
    for (const suffix of ["", "/history", "/roster-removals", "/calendar"]) {
      const response = await fetch(
        `${base}/api/reservations/${f.r.id}${suffix}`,
        { headers },
      );
      assert.equal(response.status, 404);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal((await response.text()).includes(f.input.gameName), false);
    }
    const page = await fetch(`${base}/reservation/${f.r.id}`);
    assert.equal((await page.text()).includes(f.input.description), false);
    assert.equal(page.headers.get("set-cookie"), null);
    const url = `${base}/api/reservations/${f.r.id}/invitation/accept`;
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: { ...headers, origin: "https://invalid.test" },
          body: JSON.stringify({ token: f.secret }),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ token: f.secret, inviteVersion: 1 }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ token: f.secret }),
        })
      ).status,
      200,
    );
    const response = await fetch(`${base}/api/reservations/${f.r.id}`, {
      headers,
    });
    assert.equal(response.status, 200);
    assert.equal((await response.text()).includes(f.secret), false);
  },
);

test("invitation encryption is authenticated and requires the matching server key", () => {
  const secret = process.env.ADMIN_SESSION_SECRET;
  try {
    const value = newInvitation(),
      plain = decryptInvitation(value.inviteCipher);
    assert.match(plain, /^[a-f0-9]{64}$/);
    assert.equal(hashToken(plain), value.inviteHash);
    assert.ok(!value.inviteCipher.includes(plain));
    process.env.ADMIN_SESSION_SECRET = token();
    assert.throws(() => decryptInvitation(value.inviteCipher), {
      code: "INVITATION_KEY",
    });
    process.env.ADMIN_SESSION_SECRET = "";
    assert.throws(() => newInvitation(), { code: "INVITATION_CONFIG" });
  } finally {
    if (secret === undefined) delete process.env.ADMIN_SESSION_SECRET;
    else process.env.ADMIN_SESSION_SECRET = secret;
  }
});
test("rotation and redemption/signup races serialize; cancelled and started invitations can still rotate", async () => {
  const f = await fixture(),
    visitor = token();
  const attempts = await Promise.allSettled([
    acceptInvitation(f.r.id, { token: f.secret }, visitor),
    rotateInvitation(f.r.id, { expectedVersion: 1 }, f.owner),
  ]);
  assert.equal(attempts[1].status, "fulfilled");
  await assert.rejects(detail(f.r.id, visitor), { status: 404 });
  const next = await currentInvitation(f.r.id, f.owner);
  await acceptInvitation(
    f.r.id,
    { token: next.path.split("#invite=")[1] },
    visitor,
  );
  const joined = await Promise.allSettled([
    joinReservation(f.r.id, { name: "Race" }, visitor),
    rotateInvitation(f.r.id, { expectedVersion: 2 }, f.owner),
  ]);
  assert.equal(joined[1].status, "fulfilled");
  const count = await db.participant.count({
    where: { reservationId: f.r.id },
  });
  assert.equal(count, joined[0].status === "fulfilled" ? 2 : 1);
  if (joined[0].status === "fulfilled") await detail(f.r.id, visitor);
  else await assert.rejects(detail(f.r.id, visitor), { status: 404 });
  await db.gameReservation.update({
    where: { id: f.r.id },
    data: { scheduledAt: new Date(0) },
  });
  await rotateInvitation(f.r.id, { expectedVersion: 3 }, f.owner);
  await db.gameReservation.update({
    where: { id: f.r.id },
    data: { status: "CANCELLED" },
  });
  await rotateInvitation(f.r.id, { expectedVersion: 4 }, f.owner);
  assert.equal((await currentInvitation(f.r.id, f.owner)).version, 5);
});
test(
  "HTTP administrators manage invitations with fresh sessions but do not receive signup grants; accepting uses independent quota",
  { skip: !process.env.TEST_BASE_URL },
  async () => {
    const f = await fixture(),
      base = process.env.TEST_BASE_URL!,
      visitor = token();
    await db.adminCredential.create({
      data: {
        id: actor.id,
        username: actor.username,
        passwordHash: "unused",
        mustChangePassword: false,
        isActive: true,
      },
    });
    const cookie = `party_identity=${visitor}; ${ADMIN_COOKIE}=${createAdminSession(actor.id, 0)}`;
    const headers = {
        cookie,
        origin: base,
        "content-type": "application/json",
      },
      root = `${base}/api/reservations/${f.r.id}`;
    assert.equal((await fetch(root, { headers })).status, 200);
    const management = await fetch(root + "/invitation", { headers });
    assert.equal(management.status, 200);
    assert.equal(
      (
        await fetch(root + "/participants", {
          method: "POST",
          headers,
          body: JSON.stringify({ name: "Admin" }),
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(root + "/invitation", {
          method: "POST",
          headers,
          body: JSON.stringify({ expectedVersion: 1 }),
        })
      ).status,
      200,
    );
    assert.equal(
      (await db.adminAuditLog.findFirstOrThrow({ where: { targetId: f.r.id } }))
        .action,
      "RESERVATION_INVITE_ROTATE",
    );
    await db.adminCredential.update({
      where: { id: actor.id },
      data: { sessionVersion: 1 },
    });
    assert.equal((await fetch(root, { headers })).status, 404);
    assert.equal((await fetch(root + "/invitation", { headers })).status, 403);
    const limited = token(),
      visitorHeaders = { ...headers, cookie: `party_identity=${limited}` };
    for (let i = 0; i < 10; i++)
      assert.equal(
        (
          await fetch(root + "/invitation/accept", {
            method: "POST",
            headers: visitorHeaders,
            body: JSON.stringify({ token: token() }),
          })
        ).status,
        404,
      );
    assert.equal(
      (
        await fetch(root + "/invitation/accept", {
          method: "POST",
          headers: visitorHeaders,
          body: JSON.stringify({ token: token() }),
        })
      ).status,
      429,
    );
    // The separate invitation budget does not consume the existing roster budget.
    assert.equal(
      (
        await fetch(root + "/participants", {
          method: "POST",
          headers: visitorHeaders,
          body: JSON.stringify({ name: "Guest" }),
        })
      ).status,
      404,
    );
  },
);

test("failed authorization and admin audit writes roll back invitation version, credential and revision", async () => {
  const f = await fixture(),
    visitor = token();
  const original = await db.gameReservation.findUniqueOrThrow({
    where: { id: f.r.id },
  });
  await db.$executeRawUnsafe(
    `CREATE TRIGGER fail_invite_grant BEFORE INSERT ON ReservationAccess BEGIN SELECT RAISE(ABORT, 'test grant rollback'); END`,
  );
  try {
    await assert.rejects(
      acceptInvitation(f.r.id, { token: f.secret }, visitor),
    );
    assert.equal(
      await db.reservationAccess.count({
        where: { reservationId: f.r.id, tokenHash: hashToken(visitor) },
      }),
      0,
    );
    assert.deepEqual(
      await db.gameReservation.findUniqueOrThrow({ where: { id: f.r.id } }),
      original,
    );
  } finally {
    await db.$executeRawUnsafe("DROP TRIGGER fail_invite_grant");
  }
  await db.$executeRawUnsafe(
    `CREATE TRIGGER fail_invite_audit BEFORE INSERT ON AdminAuditLog BEGIN SELECT RAISE(ABORT, 'test audit rollback'); END`,
  );
  try {
    await assert.rejects(
      rotateInvitation(f.r.id, { expectedVersion: 1 }, visitor, actor),
    );
    assert.deepEqual(
      await db.gameReservation.findUniqueOrThrow({ where: { id: f.r.id } }),
      original,
    );
  } finally {
    await db.$executeRawUnsafe("DROP TRIGGER fail_invite_audit");
  }
});
