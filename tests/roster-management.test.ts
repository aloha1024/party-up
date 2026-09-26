import "./support/isolated";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../server/db";
import {
  createReservation,
  joinReservation,
  joinWaitlist,
  leaveReservation,
  renameRosterEntry,
  removeRosterEntry,
  editReservation,
  deleteReservation,
  restoreReservation,
  purgeReservation,
  cancelReservation,
  detail,
} from "../server/reservations";
import { rosterRemovals, removalQuery } from "../server/roster-removals";
import { reservationHistory } from "../server/reservation-history";
import { ADMIN_COOKIE, createAdminSession } from "../server/admin-auth";
const token = () => randomBytes(32).toString("hex");
const ids: string[] = [];
const actor = {
  id: 1000001,
  username: "private-roster-manager",
  sessionVersion: 0,
};
const input = () => ({
  gameName: "名单管理",
  hostName: "Host",
  maxPlayers: 2,
  description: "",
  scheduledAt: new Date(Date.now() + 86400000).toISOString(),
});
async function fixture() {
  const owner = token(),
    guest = token(),
    waiter = token(),
    data = input();
  const r = await createReservation(data, owner);
  ids.push(r.id);
  await joinReservation(r.id, { name: "Guest" }, guest);
  await joinWaitlist(r.id, { name: "Waiter" }, waiter);
  return { id: r.id, owner, guest, waiter, data };
}
async function row(
  id: string,
  viewer: string,
  kind: "participants" | "waitlist",
) {
  const value = (await detail(id, viewer))[kind].find((p) => p.isMe)!;
  return { entryId: String(value.id), expectedName: value.name };
}
after(async () => {
  await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
  await db.adminAuditLog.deleteMany({ where: { targetId: { in: ids } } });
  await db.adminCredential.deleteMany({ where: { id: actor.id } });
  await db.$disconnect();
});

test("self rename preserves membership/order, normalizes names, isolates identities and syncs host history/version", async () => {
  const f = await fixture();
  const guest = await row(f.id, f.guest, "participants");
  const before = await detail(f.id, f.guest);
  await assert.rejects(
    renameRosterEntry(
      f.id,
      "participants",
      { ...guest, name: "Other" },
      token(),
    ),
    { code: "ROSTER_CHANGED" },
  );
  await assert.rejects(
    renameRosterEntry(
      f.id,
      "participants",
      { ...guest, name: "Ｗａｉｔｅｒ" },
      f.guest,
    ),
    { code: "DUPLICATE" },
  );
  const changed = await renameRosterEntry(
    f.id,
    "participants",
    { ...guest, name: " ＮｅｗＧｕｅｓｔ " },
    f.guest,
  );
  assert.equal(changed.participants.find((p) => p.isMe)!.name, "NewGuest");
  assert.deepEqual(
    changed.participants.map((p) => [p.id, p.joinedAt]),
    before.participants.map((p) => [p.id, p.joinedAt]),
  );
  assert.equal(changed.editVersion, 0);
  assert.equal((await reservationHistory(f.id)).items.length, 0);
  await renameRosterEntry(
    f.id,
    "participants",
    { ...guest, name: "NewGuest" },
    f.guest,
  );
  await assert.rejects(
    renameRosterEntry(
      f.id,
      "participants",
      { ...guest, name: "Next" },
      f.guest,
    ),
    { code: "ROSTER_CHANGED" },
  );
  const waiting = await row(f.id, f.waiter, "waitlist");
  const queue = (await detail(f.id)).waitlist;
  await renameRosterEntry(
    f.id,
    "waitlist",
    { ...waiting, name: "NewWaiter" },
    f.waiter,
  );
  assert.deepEqual(
    (await detail(f.id)).waitlist.map((p) => [p.id, p.joinedAt]),
    queue.map((p) => [p.id, p.joinedAt]),
  );
  const host = await row(f.id, f.owner, "participants");
  const renamedHost = await renameRosterEntry(
    f.id,
    "participants",
    { ...host, name: "NewHost" },
    f.owner,
  );
  assert.equal(renamedHost.hostName, "NewHost");
  assert.equal(renamedHost.editVersion, 1);
  assert.deepEqual((await reservationHistory(f.id)).items[0].fields, [
    "hostName",
  ]);
  await assert.rejects(
    editReservation(f.id, { ...f.data, editVersion: 0 }, f.owner),
    { code: "EDIT_CONFLICT" },
  );
  await renameRosterEntry(
    f.id,
    "participants",
    { ...host, name: "NewHost" },
    f.owner,
  );
  assert.equal((await reservationHistory(f.id)).items.length, 1);
  await leaveReservation(f.id, f.owner);
  await joinWaitlist(f.id, { name: "NewHost" }, f.owner);
  await renameRosterEntry(
    f.id,
    "waitlist",
    { ...(await row(f.id, f.owner, "waitlist")), name: "QueuedHost" },
    f.owner,
  );
  assert.equal((await detail(f.id)).hostName, "QueuedHost");
});

test("removal promotes FIFO, is idempotent, permits rejoining and never removes a new record", async () => {
  const f = await fixture();
  const guest = await row(f.id, f.guest, "participants");
  const command = {
    ...guest,
    kind: "participants",
    reason: "  私密移除原因  ",
  };
  await assert.rejects(removeRosterEntry(f.id, command, f.waiter), {
    code: "FORBIDDEN",
  });
  await assert.rejects(
    removeRosterEntry(
      f.id,
      { ...command, ...(await row(f.id, f.owner, "participants")) },
      f.owner,
      actor,
    ),
    { code: "FORBIDDEN" },
  );
  await assert.rejects(removeRosterEntry(f.id, command, f.guest, actor), {
    code: "FORBIDDEN",
  });
  const removed = await removeRosterEntry(f.id, command, f.owner, actor);
  assert.equal(removed.waitlist.length, 0);
  assert.equal(removed.participants[1].name, "Waiter");
  assert.equal(
    (await rosterRemovals(f.id, f.guest)).items[0].reason,
    "私密移除原因",
  );
  assert.equal((await rosterRemovals(f.id, f.waiter)).items.length, 0);
  assert.equal((await reservationHistory(f.id)).items.length, 0);
  await removeRosterEntry(f.id, command, f.owner, actor);
  assert.equal(
    await db.rosterRemoval.count({ where: { reservationId: f.id } }),
    1,
  );
  assert.equal(await db.adminAuditLog.count({ where: { targetId: f.id } }), 1);
  await joinWaitlist(f.id, { name: "Guest" }, f.guest);
  await leaveReservation(f.id, f.waiter);
  const newRow = await row(f.id, f.guest, "participants");
  assert.notEqual(newRow.entryId, guest.entryId);
  await removeRosterEntry(f.id, command, f.owner);
  assert.equal(
    (await detail(f.id, f.guest)).participants.some((p) => p.isMe),
    true,
  );
  await assert.rejects(
    renameRosterEntry(f.id, "participants", { ...guest, name: "Bad" }, f.guest),
    { code: "ROSTER_CHANGED" },
  );
});

test("stale names and promoted waiters conflict; concurrent renames/removal preserve atomic membership", async () => {
  const f = await fixture();
  const old = await row(f.id, f.waiter, "waitlist");
  await renameRosterEntry(
    f.id,
    "waitlist",
    { ...old, name: "Renamed" },
    f.waiter,
  );
  await assert.rejects(
    removeRosterEntry(
      f.id,
      { ...old, kind: "waitlist", reason: "stale" },
      f.owner,
    ),
    { code: "ROSTER_CHANGED" },
  );
  await leaveReservation(f.id, f.guest);
  await assert.rejects(
    removeRosterEntry(
      f.id,
      { ...old, expectedName: "Renamed", kind: "waitlist", reason: "promoted" },
      f.owner,
    ),
    { code: "ROSTER_CHANGED" },
  );
  await assert.rejects(
    renameRosterEntry(f.id, "waitlist", { ...old, name: "Again" }, f.waiter),
    { code: "ROSTER_CHANGED" },
  );
  const target = await row(f.id, f.waiter, "participants");
  const race = await Promise.allSettled([
    renameRosterEntry(
      f.id,
      "participants",
      { ...target, name: "Racing" },
      f.waiter,
    ),
    removeRosterEntry(
      f.id,
      { ...target, kind: "participants", reason: "race" },
      f.owner,
    ),
  ]);
  assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
  const remaining = await detail(f.id, f.waiter);
  assert.ok(remaining.participants.length <= remaining.maxPlayers);
  assert.equal(
    await db.rosterRemoval.count({ where: { reservationId: f.id } }),
    remaining.participants.some((p) => p.isMe) ? 0 : 1,
  );
});

test("removal/audit/history insert failures roll back membership, promotions, host nickname and version", async () => {
  const f = await fixture();
  const snapshot = () =>
    db.gameReservation.findUnique({
      where: { id: f.id },
      include: {
        participants: { orderBy: { id: "asc" } },
        waitlist: { orderBy: { id: "asc" } },
        removals: true,
        changes: true,
      },
    });
  const before = await snapshot();
  for (const table of ["RosterRemoval", "AdminAuditLog", "ReservationChange"]) {
    const trigger = "roster_failure_" + randomUUID().replaceAll("-", "");
    await db.$executeRawUnsafe(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'simulated'); END`,
    );
    try {
      if (table === "ReservationChange")
        await assert.rejects(
          renameRosterEntry(
            f.id,
            "participants",
            {
              ...(await row(f.id, f.owner, "participants")),
              name: "RollbackHost",
            },
            f.owner,
          ),
        );
      else
        await assert.rejects(
          removeRosterEntry(
            f.id,
            {
              ...(await row(f.id, f.guest, "participants")),
              kind: "participants",
              reason: "rollback",
            },
            f.owner,
            actor,
          ),
        );
      assert.deepEqual(await snapshot(), before);
      assert.equal(
        await db.adminAuditLog.count({ where: { targetId: f.id } }),
        0,
      );
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER ${trigger}`);
    }
  }
});

test("promotion racing queued removal or rename never targets the promoted entry; simultaneous duplicate removals record once", async () => {
  for (const operation of ["remove", "rename"] as const) {
    const f = await fixture();
    const second = token();
    await joinWaitlist(f.id, { name: "Second" }, second);
    const queued = await row(f.id, f.waiter, "waitlist");
    const [departure, modification] = await Promise.allSettled([
      leaveReservation(f.id, f.guest),
      operation === "remove"
        ? removeRosterEntry(
            f.id,
            { ...queued, kind: "waitlist", reason: "race promotion" },
            f.owner,
          )
        : renameRosterEntry(
            f.id,
            "waitlist",
            { ...queued, name: "RenamedWaiter" },
            f.waiter,
          ),
    ]);
    assert.equal(departure.status, "fulfilled");
    if (modification.status === "rejected")
      assert.equal(modification.reason.code, "ROSTER_CHANGED");
    const result = await detail(f.id, f.waiter);
    assert.equal(result.participants.length, 2);
    assert.equal(new Set(result.participants.map((p) => p.id)).size, 2);
    if (operation === "remove") {
      assert.equal(
        result.participants[1].name,
        modification.status === "fulfilled" ? "Second" : "Waiter",
      );
      assert.equal(
        await db.rosterRemoval.count({ where: { reservationId: f.id } }),
        modification.status === "fulfilled" ? 1 : 0,
      );
    } else {
      assert.equal(
        result.participants[1].name,
        modification.status === "fulfilled" ? "RenamedWaiter" : "Waiter",
      );
      assert.equal(result.waitlist.length, 1);
    }
  }
  const f = await fixture();
  const command = {
    ...(await row(f.id, f.guest, "participants")),
    kind: "participants",
    reason: "duplicate",
  };
  const results = await Promise.allSettled([
    removeRosterEntry(f.id, command, f.owner, actor),
    removeRosterEntry(f.id, command, f.owner, actor),
  ]);
  assert.ok(results.every((r) => r.status === "fulfilled"));
  assert.equal(
    await db.rosterRemoval.count({ where: { reservationId: f.id } }),
    1,
  );
  assert.equal(await db.adminAuditLog.count({ where: { targetId: f.id } }), 1);
});

test("private pagination filters before paging, scopes change with permissions, and lifecycle/copy preserve privacy", async () => {
  const f = await fixture();
  for (let i = 0; i < 25; i++)
    await db.rosterRemoval.create({
      data: {
        reservationId: f.id,
        kind: "participants",
        entryId: `fixture-${i}`,
        targetTokenHash: (await db.participant.findUnique({
          where: {
            id: (await row(f.id, i % 2 ? f.guest : f.owner, "participants"))
              .entryId,
          },
        }))!.tokenHash,
        targetName: "Private",
        reason: `reason-${i}`,
        actorRole: "HOST",
      },
    });
  const own = await rosterRemovals(f.id, f.guest);
  assert.equal(own.items.length, 10);
  const tail = await rosterRemovals(f.id, f.guest, null, own.nextBefore!);
  assert.equal(tail.items.length, 2);
  assert.ok(
    [...own.items, ...tail.items].every(
      (item) => Number(item.reason.split("-")[1]) % 2 === 1,
    ),
  );
  const host = await rosterRemovals(f.id, f.owner);
  assert.equal(host.items.length, 10);
  const admin = await rosterRemovals(f.id, f.guest, actor);
  await assert.rejects(
    rosterRemovals(f.id, f.guest, null, undefined, admin.scope),
    { code: "VIEWER_CHANGED" },
  );
  assert.notEqual(own.scope, admin.scope);
  for (const identity of [undefined, "invalid", token()])
    assert.equal((await rosterRemovals(f.id, identity)).items.length, 0);
  const encoded = JSON.stringify(own.items);
  for (const key of [
    f.owner,
    f.guest,
    "targetTokenHash",
    "entryId",
    actor.username,
  ])
    assert.equal(encoded.includes(key), false);
  const copied = await createReservation(f.data, f.owner);
  ids.push(copied.id);
  assert.equal((await rosterRemovals(copied.id, f.owner)).items.length, 0);
  await deleteReservation(f.id, actor);
  await assert.rejects(rosterRemovals(f.id, f.owner), { code: "NOT_FOUND" });
  await restoreReservation(f.id, actor);
  assert.equal((await rosterRemovals(f.id, f.guest)).items.length, 10);
  await deleteReservation(f.id, actor);
  await purgeReservation(f.id, actor);
  assert.equal(
    await db.rosterRemoval.count({ where: { reservationId: f.id } }),
    0,
  );
  for (const query of [
    "before=0",
    "before=1&before=2",
    "scope=invalid",
    `scope=${own.scope}&scope=${own.scope}`,
  ])
    assert.throws(() => removalQuery(new URLSearchParams(query)), {
      status: 400,
    });
});

test("started/cancelled/deleted reservations reject management; queue removal preserves order", async () => {
  const f = await fixture();
  const second = token();
  await joinWaitlist(f.id, { name: "Second" }, second);
  await removeRosterEntry(
    f.id,
    {
      ...(await row(f.id, f.waiter, "waitlist")),
      kind: "waitlist",
      reason: "queue",
    },
    f.owner,
  );
  assert.deepEqual(
    (await detail(f.id)).waitlist.map((p) => p.name),
    ["Second"],
  );
  await joinWaitlist(f.id, { name: "Waiter" }, f.waiter);
  assert.deepEqual(
    (await detail(f.id)).waitlist.map((p) => p.name),
    ["Second", "Waiter"],
  );
  const target = await row(f.id, f.guest, "participants");
  const blocked = async (code: string) => {
    await assert.rejects(
      renameRosterEntry(
        f.id,
        "participants",
        { ...target, name: "No" },
        f.guest,
      ),
      { code },
    );
    await assert.rejects(
      removeRosterEntry(
        f.id,
        { ...target, kind: "participants", reason: "No" },
        f.owner,
      ),
      { code },
    );
  };
  await db.gameReservation.update({
    where: { id: f.id },
    data: { scheduledAt: new Date() },
  });
  await blocked("STARTED");
  await db.gameReservation.update({
    where: { id: f.id },
    data: { scheduledAt: new Date(f.data.scheduledAt) },
  });
  await cancelReservation(f.id, { reason: "cancel" }, f.owner);
  await blocked("CANCELLED");
  await deleteReservation(f.id, actor);
  await blocked("NOT_FOUND");
});

test(
  "HTTP management enforces origin/identity, private scopes, admin validity and roster rate budget",
  { skip: !process.env.TEST_BASE_URL },
  async () => {
    const f = await fixture(),
      base = process.env.TEST_BASE_URL!;
    const target = await row(f.id, f.guest, "participants");
    const url = `${base}/api/reservations/${f.id}/roster-removals`;
    const post = (
      cookie: string,
      origin = base,
      value = { ...target, kind: "participants", reason: "HTTP secret reason" },
    ) =>
      fetch(url, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(value),
      });
    assert.equal((await post("")).status, 428);
    assert.equal(
      (await post(`party_identity=${f.owner}`, "https://other.test")).status,
      403,
    );
    assert.equal((await post(`party_identity=${f.guest}`)).status, 403);
    const patch = await fetch(`${base}/api/reservations/${f.id}/participants`, {
      method: "PATCH",
      headers: {
        Cookie: `party_identity=${f.guest}`,
        Origin: base,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...target, name: "HTTPGuest" }),
    });
    assert.equal(patch.status, 200);
    assert.equal((await post(`party_identity=${f.owner}`)).status, 409);
    const root = await db.adminCredential.findUniqueOrThrow({
      where: { id: 1 },
    });
    await db.adminCredential.create({
      data: {
        id: actor.id,
        username: actor.username,
        passwordHash: root.passwordHash,
        mustChangePassword: false,
      },
    });
    const adminCookie = `party_identity=${token()}; ${ADMIN_COOKIE}=${createAdminSession(actor.id, 0)}`;
    assert.equal(
      (
        await post(adminCookie, base, {
          ...target,
          expectedName: "HTTPGuest",
          kind: "participants",
          reason: "HTTP secret reason",
        })
      ).status,
      200,
    );
    for (const [cookie, count] of [
      ["", 0],
      ["party_identity=invalid", 0],
      [`party_identity=${f.waiter}`, 0],
      [`party_identity=${f.guest}`, 1],
      [`party_identity=${f.owner}`, 1],
      [adminCookie, 1],
    ] as const) {
      const response = await fetch(url, { headers: { Cookie: cookie } });
      const value = await response.json();
      assert.equal(response.status, 200);
      assert.equal(value.data.items.length, count);
      assert.match(response.headers.get("cache-control") || "", /no-store/);
      assert.equal(response.headers.get("set-cookie"), null);
      for (const secret of [f.guest, "targetTokenHash", actor.username])
        assert.equal(JSON.stringify(value).includes(secret), false);
    }
    for (const update of [
      { isActive: false },
      { isActive: true, mustChangePassword: true },
      { mustChangePassword: false, sessionVersion: 1 },
    ]) {
      await db.adminCredential.update({
        where: { id: actor.id },
        data: update,
      });
      assert.equal(
        (await (await fetch(url, { headers: { Cookie: adminCookie } })).json())
          .data.items.length,
        0,
      );
      assert.equal((await post(adminCookie)).status, 403);
    }
    for (const query of ["before=abc", "before=1&before=2"])
      assert.equal((await fetch(url + "?" + query)).status, 400);
    const quotaCookie = `party_identity=${token()}`;
    for (let i = 0; i < 30; i++)
      assert.equal((await post(quotaCookie)).status, 403);
    assert.equal((await post(quotaCookie)).status, 429);
  },
);
