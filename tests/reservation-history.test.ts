import "./support/isolated";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../server/db";
import {
  reservationHistory,
  historyCursor,
} from "../server/reservation-history";
import { catchUpHistory, type HistoryPage } from "../lib/reservation-history";
import {
  createReservation,
  editReservation,
  cancelReservation,
  joinReservation,
  joinWaitlist,
  deleteReservation,
  restoreReservation,
  purgeReservation,
} from "../server/reservations";

const token = () => randomBytes(32).toString("hex");
const ids: string[] = [];
const actor = { id: 2, username: "private-history-admin" };
const input = () => ({
  gameName: "秘密游戏旧值",
  hostName: "秘密昵称",
  description: "秘密备注",
  maxPlayers: 2,
  scheduledAt: new Date(Date.now() + 86400000).toISOString(),
});
async function fixture() {
  const owner = token(),
    data = input();
  const r = await createReservation(data, owner);
  ids.push(r.id);
  return { r, data, owner };
}
after(async () => {
  await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
  await db.adminAuditLog.deleteMany({ where: { targetId: { in: ids } } });
  await db.$disconnect();
});

test("history records normalized actual changes and roles without storing sensitive text", async () => {
  const { r, data, owner } = await fixture();
  assert.deepEqual(await reservationHistory(r.id), {
    items: [],
    nextBefore: null,
  });
  const same = await editReservation(
    r.id,
    { ...data, hostName: ` ${data.hostName} `, editVersion: 0 },
    owner,
  );
  assert.equal(same.editVersion, 1);
  assert.equal((await reservationHistory(r.id)).items.length, 0);
  const changed = {
    ...data,
    gameName: "新的秘密游戏",
    hostName: "新的秘密昵称",
    description: "新的秘密备注",
    maxPlayers: 3,
    scheduledAt: new Date(Date.now() + 172800000).toISOString(),
  };
  await editReservation(r.id, { ...changed, editVersion: 1 }, owner);
  const [item] = (await reservationHistory(r.id)).items;
  assert.deepEqual(item.fields, [
    "gameName",
    "hostName",
    "description",
    "scheduledAt",
    "maxPlayers",
  ]);
  assert.equal(item.actorRole, "HOST");
  assert.equal(item.maxPlayersBefore, 2);
  assert.equal(item.maxPlayersAfter, 3);
  assert.equal(item.scheduledAtBefore, data.scheduledAt);
  assert.equal(item.scheduledAtAfter, changed.scheduledAt);
  await assert.rejects(
    editReservation(r.id, { ...data, editVersion: 1 }, owner),
    { code: "EDIT_CONFLICT" },
  );
  await assert.rejects(
    editReservation(r.id, { ...data, editVersion: 2 }, token()),
    { code: "FORBIDDEN" },
  );
  await assert.rejects(
    editReservation(r.id, { ...changed, maxPlayers: 1, editVersion: 2 }, owner),
  );
  await editReservation(
    r.id,
    { ...changed, description: "管理员秘密备注", editVersion: 2 },
    owner,
    actor,
  );
  await cancelReservation(r.id, { reason: "秘密取消原因" }, owner, actor);
  const history = await reservationHistory(r.id);
  assert.equal(history.items.length, 3);
  assert.equal(history.items[0].action, "CANCEL");
  assert.deepEqual(history.items[0].fields, []);
  assert.equal(history.items[1].actorRole, "ADMIN");
  const stored = JSON.stringify(
    await db.reservationChange.findMany({ where: { reservationId: r.id } }),
  );
  for (const secret of [
    owner,
    actor.username,
    data.gameName,
    data.hostName,
    data.description,
    changed.gameName,
    changed.hostName,
    changed.description,
    "管理员秘密备注",
    "秘密取消原因",
    "tokenHash",
    "actorId",
  ])
    assert.equal(stored.includes(secret), false, secret);
});

test("history failure rolls back edit, host rename, promotion and audit, and cancellation", async () => {
  const { r, data, owner } = await fixture();
  await joinReservation(r.id, { name: "Guest" }, token());
  await joinWaitlist(r.id, { name: "Waiter" }, token());
  const snapshot = () =>
    db.gameReservation.findUnique({
      where: { id: r.id },
      include: {
        participants: { orderBy: { id: "asc" } },
        waitlist: { orderBy: { id: "asc" } },
      },
    });
  const before = await snapshot();
  const trigger = "history_fail_" + randomUUID().replaceAll("-", "");
  await db.$executeRawUnsafe(
    `CREATE TRIGGER ${trigger} BEFORE INSERT ON ReservationChange WHEN NEW.reservationId = '${r.id}' BEGIN SELECT RAISE(ABORT, 'simulated history failure'); END`,
  );
  try {
    await assert.rejects(
      editReservation(
        r.id,
        { ...data, maxPlayers: 4, hostName: "Renamed", editVersion: 0 },
        owner,
        actor,
      ),
    );
    assert.deepEqual(await snapshot(), before);
    await assert.rejects(
      cancelReservation(r.id, { reason: "cancel" }, owner, actor),
    );
    assert.deepEqual(await snapshot(), before);
    assert.equal(
      await db.adminAuditLog.count({ where: { targetId: r.id } }),
      0,
    );
    assert.equal((await reservationHistory(r.id)).items.length, 0);
  } finally {
    await db.$executeRawUnsafe(`DROP TRIGGER ${trigger}`);
  }
});

test("concurrent edits keep one winner and one history entry; lifecycle and copy isolate history", async () => {
  const { r, data, owner } = await fixture();
  const results = await Promise.allSettled(
    [3, 4].map((maxPlayers) =>
      editReservation(r.id, { ...data, maxPlayers, editVersion: 0 }, owner),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await reservationHistory(r.id)).items.length, 1);
  const copied = await createReservation(data, owner);
  ids.push(copied.id);
  assert.equal((await reservationHistory(copied.id)).items.length, 0);
  await deleteReservation(r.id, actor);
  await assert.rejects(reservationHistory(r.id), { code: "NOT_FOUND" });
  assert.equal(
    await db.reservationChange.count({ where: { reservationId: r.id } }),
    1,
  );
  await restoreReservation(r.id, actor);
  assert.equal((await reservationHistory(r.id)).items.length, 1);
  await deleteReservation(r.id, actor);
  await purgeReservation(r.id, actor);
  assert.equal(
    await db.reservationChange.count({ where: { reservationId: r.id } }),
    0,
  );
  await assert.rejects(reservationHistory(r.id), { code: "NOT_FOUND" });
});

test("cursor pagination is reservation scoped, stable at identical timestamps and catches gaps larger than ten", async () => {
  const { r } = await fixture();
  const create = (count: number) =>
    db.reservationChange.createMany({
      data: Array.from({ length: count }, () => ({
        reservationId: r.id,
        action: "EDIT",
        actorRole: "HOST",
        fields: '["description"]',
        createdAt: new Date("2026-09-26T00:00:00Z"),
      })),
    });
  await create(25);
  const first = await reservationHistory(r.id);
  const second = await reservationHistory(r.id, first.nextBefore!);
  assert.equal(first.items.length, 10);
  assert.equal(second.items.length, 10);
  const existing: HistoryPage = {
    items: [...first.items, ...second.items],
    nextBefore: second.nextBefore,
  };
  await create(23);
  const latest = await reservationHistory(r.id);
  let calls = 0;
  const combined = await catchUpHistory(latest, existing, async (before) => {
    calls++;
    return reservationHistory(r.id, before);
  });
  assert.equal(calls, 2);
  assert.equal(combined.items.length, 43);
  const tail = await reservationHistory(r.id, combined.nextBefore!);
  assert.equal(tail.items.length, 5);
  assert.equal(tail.nextBefore, null);
  assert.equal(
    new Set([...combined.items, ...tail.items].map((r) => r.id)).size,
    48,
  );
  await assert.rejects(
    catchUpHistory(latest, existing, async () => {
      throw new Error("offline");
    }),
    /offline/,
  );
  assert.equal(existing.items.length, 20);
  await assert.rejects(
    catchUpHistory(latest, existing, async () => latest),
    /分页异常/,
  );
  const other = await fixture();
  assert.deepEqual(await reservationHistory(other.r.id, latest.items[0].id), {
    items: [],
    nextBefore: null,
  });
  for (const query of [
    "before=",
    "before=0",
    "before=-1",
    "before=1.2",
    "before=1&before=2",
    "before=01",
    "before=1e2",
    "before=99999999999999999999",
  ])
    assert.throws(() => historyCursor(new URLSearchParams(query)), {
      status: 400,
    });
  assert.equal(historyCursor(new URLSearchParams()), undefined);
  assert.equal(historyCursor(new URLSearchParams("before=12")), 12);
});

test(
  "HTTP history is public, no-store, bounded, validates cursors and never creates identity",
  { skip: !process.env.TEST_BASE_URL },
  async () => {
    const { r, data, owner } = await fixture();
    await editReservation(
      r.id,
      { ...data, maxPlayers: 3, editVersion: 0 },
      owner,
    );
    const url = `${process.env.TEST_BASE_URL}/api/reservations/${r.id}/history`;
    for (const cookie of [
      "",
      "party_identity=invalid",
      `party_identity=${token()}`,
    ]) {
      const response = await fetch(url + `?identity=${owner}&actor=ADMIN`, {
        headers: { Cookie: cookie },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("set-cookie"), null);
      assert.match(response.headers.get("cache-control") || "", /no-store/);
      assert.ok(response.headers.get("x-request-id"));
      const json = await response.json();
      assert.deepEqual(json.data, await reservationHistory(r.id));
      assert.equal(JSON.stringify(json).includes(owner), false);
    }
    for (const query of [
      "before=0",
      "before=1&before=2",
      "before=abc",
      "before=2147483648",
    ])
      assert.equal((await fetch(url + "?" + query)).status, 400);
    await deleteReservation(r.id, actor);
    assert.equal((await fetch(url)).status, 404);
    assert.equal(
      (
        await fetch(
          `${process.env.TEST_BASE_URL}/api/reservations/missing/history`,
        )
      ).status,
      404,
    );
  },
);
