import "./support/isolated";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { db } from "../server/db";
import { reservationTemplate } from "../server/reservation-template";
import {
  createReservation,
  joinReservation,
  leaveReservation,
  joinWaitlist,
  leaveWaitlist,
  editReservation,
  cancelReservation,
  deleteReservation,
  restoreReservation,
  purgeReservation,
  detail,
  hashToken,
  AppError,
} from "../server/reservations";
import {
  listMyReservations,
  listReservations,
} from "../server/reservation-list";

const token = () => randomBytes(32).toString("hex");
const ids: string[] = [];
const actor = { id: 2, username: "waitlist-admin" };
const code = (expected: string) => (e: unknown) =>
  e instanceof AppError && e.code === expected;
async function fixture() {
  const host = token(),
    guest = token();
  const input = {
    gameName: "候补测试" + token().slice(0, 6),
    hostName: "Host",
    maxPlayers: 2,
    scheduledAt: new Date(Date.now() + 86400000).toISOString(),
    description: "",
  };
  const r = await createReservation(input, host);
  ids.push(r.id);
  await joinReservation(r.id, { name: "Guest" }, guest);
  return { id: r.id, host, guest, input };
}
after(async () => {
  await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});

test("waitlist is explicit, unique across rosters, bounded, private and FIFO after rejoining", async () => {
  const { id, host, guest, input } = await fixture();
  const first = token(),
    second = token();
  await assert.rejects(
    joinReservation(id, { name: "First" }, first),
    code("FULL"),
  );
  assert.equal((await detail(id)).waitlist.length, 0);
  await assert.rejects(
    joinWaitlist(id, { name: " ＨＯＳＴ " }, first),
    code("DUPLICATE"),
  );
  await assert.rejects(
    joinWaitlist(id, { name: "Other" }, host),
    code("DUPLICATE"),
  );
  await joinWaitlist(id, { name: "First" }, first);
  await assert.rejects(
    joinWaitlist(id, { name: "Different" }, first),
    code("DUPLICATE"),
  );
  await assert.rejects(
    joinWaitlist(id, { name: " FIRST " }, second),
    code("DUPLICATE"),
  );
  await assert.rejects(joinWaitlist(id, { name: "X", position: 1 }, second));
  await joinWaitlist(id, { name: "Second" }, second);
  await assert.rejects(
    editReservation(id, { ...input, hostName: "second", editVersion: 0 }, host),
    code("DUPLICATE"),
  );
  const before = (await detail(id, first)).waitlist[0];
  assert.equal(before.isMe, true);
  assert.deepEqual(Object.keys(before).sort(), [
    "id",
    "isHost",
    "isMe",
    "joinedAt",
    "name",
  ]);
  await leaveWaitlist(id, first);
  await joinWaitlist(id, { name: "First" }, first);
  const queued = await detail(id);
  assert.deepEqual(
    queued.waitlist.map((p) => p.name),
    ["Second", "First"],
  );
  assert.ok(queued.waitlist[1].id > before.id);
  await db.waitlistEntry.createMany({
    data: Array.from({ length: 98 }, (_, i) => ({
      reservationId: id,
      name: `W${i}`,
      nameKey: `w${i}`,
      tokenHash: hashToken(token()),
    })),
  });
  await assert.rejects(
    joinWaitlist(id, { name: "Over" }, token()),
    code("WAITLIST_FULL"),
  );
  const promoted = await leaveReservation(id, guest);
  assert.deepEqual(
    promoted.participants.map((p) => p.name),
    ["Host", "Second"],
  );
  assert.equal(promoted.waitlist.length, 99);
  await assert.rejects(leaveWaitlist(id, second), code("PROMOTED"));
  assert.equal(
    (await detail(id, second)).participants.some((p) => p.isMe),
    true,
  );
});

test("expansion promotes multiple; shrinking and rejected joins roll back all changes", async () => {
  const { id, host, input } = await fixture();
  const a = token(),
    b = token(),
    c = token();
  for (const [name, t] of [
    ["A", a],
    ["B", b],
    ["C", c],
  ])
    await joinWaitlist(id, { name }, t);
  const edited = await editReservation(
    id,
    { ...input, maxPlayers: 4, editVersion: 0 },
    host,
  );
  assert.deepEqual(
    edited.participants.map((p) => p.name),
    ["Host", "Guest", "A", "B"],
  );
  assert.deepEqual(
    edited.waitlist.map((p) => p.name),
    ["C"],
  );
  await assert.rejects(
    editReservation(id, { ...input, maxPlayers: 3, editVersion: 1 }, host),
    code("CAPACITY"),
  );
  // Simulate a restored legacy vacancy with queued people. A rejected ordinary
  // join must not commit the promotion performed earlier in that transaction.
  await db.gameReservation.update({ where: { id }, data: { maxPlayers: 5 } });
  const snapshot = await detail(id);
  await assert.rejects(
    joinReservation(id, { name: "Jump" }, token()),
    code("FULL"),
  );
  assert.deepEqual(await detail(id), snapshot);
  await assert.rejects(
    joinWaitlist(id, { name: "New" }, token()),
    code("AVAILABLE"),
  );
  await db.gameReservation.update({ where: { id }, data: { maxPlayers: 6 } });
  await assert.rejects(
    joinReservation(id, { name: "c" }, token()),
    code("DUPLICATE"),
  );
  assert.equal((await detail(id)).waitlist.length, 1);
  const result = await joinReservation(id, { name: "Last" }, token());
  assert.deepEqual(
    result.participants.slice(-2).map((p) => p.name),
    ["C", "Last"],
  );
  assert.equal(result.waitlist.length, 0);
});

test("started/cancelled retain waiting membership; deleted queues restore or cascade", async () => {
  for (const state of ["future", "started", "cancelled"]) {
    const { id, host } = await fixture();
    const waiter = token();
    await joinWaitlist(id, { name: "Waiter" }, waiter);
    if (state === "started")
      await db.gameReservation.update({
        where: { id },
        data: { scheduledAt: new Date(0) },
      });
    if (state === "cancelled")
      await cancelReservation(id, { reason: "取消" }, host);
    await deleteReservation(id, actor);
    await assert.rejects(
      joinWaitlist(id, { name: "X" }, token()),
      code("NOT_FOUND"),
    );
    await assert.rejects(leaveWaitlist(id, waiter), code("NOT_FOUND"));
    assert.equal(
      (await listMyReservations({ tab: "waiting" }, waiter)).total,
      0,
    );
    await db.gameReservation.update({ where: { id }, data: { maxPlayers: 3 } });
    await restoreReservation(id, actor);
    const restored = await detail(id);
    assert.equal(restored.waitlist.length, state === "future" ? 0 : 1);
    if (state !== "future") {
      assert.equal(
        (await listMyReservations({ tab: "waiting" }, waiter)).total,
        1,
      );
      await assert.rejects(
        joinWaitlist(id, { name: "X" }, token()),
        code(state === "started" ? "STARTED" : "CANCELLED"),
      );
      await leaveWaitlist(id, waiter);
    }
    await deleteReservation(id, actor);
    await purgeReservation(id, actor);
    assert.equal(
      await db.waitlistEntry.count({ where: { reservationId: id } }),
      0,
    );
  }
});

test("personal lists transition on promotion and keep filters, date, pagination and identity scopes", async () => {
  const waiter = token(),
    unrelated = token();
  const fixtures = await Promise.all([fixture(), fixture(), fixture()]);
  for (const f of fixtures)
    await joinWaitlist(f.id, { name: "Waiter" }, waiter);
  const filters = {
    tab: "waiting",
    view: "upcoming",
    q: "候补测试",
    pageSize: 2,
    page: 99,
  };
  const page = await listMyReservations(filters, waiter);
  assert.equal(page.total, 3);
  assert.equal(page.page, 2);
  assert.equal(page.items.length, 1);
  assert.equal((await listMyReservations(filters, unrelated)).total, 0);
  assert.equal((await listMyReservations(filters, "invalid")).total, 0);
  assert.equal((await listMyReservations({ tab: "joined" }, waiter)).total, 0);
  assert.equal(
    (await listMyReservations({ tab: "waiting", view: "available" }, waiter))
      .total,
    0,
  );
  const f = fixtures[0];
  await leaveReservation(f.id, f.guest);
  assert.equal((await listMyReservations({ tab: "waiting" }, waiter)).total, 2);
  assert.equal((await listMyReservations({ tab: "joined" }, waiter)).total, 1);
  assert.equal(
    (await listReservations({ view: "available", q: f.input.gameName })).total,
    0,
  );
  await leaveReservation(f.id, waiter);
  assert.equal(
    (await listReservations({ view: "available", q: f.input.gameName })).total,
    1,
  );
});

test("concurrent enqueue, leave/join, expansion/enqueue and promotion/queue-exit remain atomic", async () => {
  const { id, host, guest, input } = await fixture();
  const people = Array.from({ length: 8 }, (_, i) => ({
    name: `W${i}`,
    token: token(),
  }));
  const results = await Promise.allSettled(
    people.map((p) => joinWaitlist(id, { name: p.name }, p.token)),
  );
  assert.ok(results.every((r) => r.status === "fulfilled"));
  const ordered = (await detail(id)).waitlist;
  const first = people.find((p) => p.name === ordered[0].name)!;
  const leaveJoin = await Promise.allSettled([
    leaveReservation(id, guest),
    joinReservation(id, { name: "Jumper" }, token()),
  ]);
  assert.equal(leaveJoin[0].status, "fulfilled");
  assert.equal(leaveJoin[1].status, "rejected");
  assert.equal(
    (await detail(id, first.token)).participants.some((p) => p.isMe),
    true,
  );
  const expansion = await Promise.allSettled([
    editReservation(id, { ...input, maxPlayers: 3, editVersion: 0 }, host),
    joinWaitlist(id, { name: "Later" }, token()),
  ]);
  assert.ok(expansion.every((r) => r.status === "fulfilled"));
  assert.deepEqual(
    (await detail(id)).participants.slice(-2).map((p) => p.name),
    ordered.slice(0, 2).map((p) => p.name),
  );
  const next = people.find((p) => p.name === ordered[2].name)!;
  const race = await Promise.allSettled([
    leaveReservation(id, first.token),
    leaveWaitlist(id, next.token),
  ]);
  assert.equal(race[0].status, "fulfilled");
  const final = await detail(id);
  assert.equal(final.participants.length, 3);
  const names = [...final.participants, ...final.waitlist].map((p) => p.name);
  assert.equal(new Set(names).size, names.length);
  if (race[1].status === "rejected") {
    assert.ok(code("PROMOTED")(race[1].reason));
    assert.ok(final.participants.some((p) => p.name === next.name));
  } else assert.equal(names.includes(next.name), false);
});

test("host rename checks both rosters, copy excludes queues, purge removes queued rows", async () => {
  const { id, host, input } = await fixture();
  const next = token();
  await joinWaitlist(id, { name: "Next" }, next);
  await leaveReservation(id, host);
  await joinWaitlist(id, { name: "Host" }, host);
  await assert.rejects(
    editReservation(id, { ...input, hostName: "next", editVersion: 0 }, host),
    code("DUPLICATE"),
  );
  await editReservation(
    id,
    { ...input, hostName: "New host", editVersion: 0 },
    host,
  );
  assert.equal((await detail(id)).waitlist[0].name, "New host");
  const template = await reservationTemplate(id, host);
  assert.deepEqual(Object.keys(template).sort(), [
    "description",
    "gameName",
    "hostName",
    "maxPlayers",
    "visibility",
  ]);
  const copy = await createReservation(
    { ...template, scheduledAt: input.scheduledAt },
    host,
  );
  ids.push(copy.id);
  assert.equal(copy.waitlist.length, 0);
  assert.equal(copy.participants.length, 1);
  await deleteReservation(id, actor);
  assert.equal(
    await db.waitlistEntry.count({ where: { reservationId: id } }),
    1,
  );
  await purgeReservation(id, actor);
  assert.equal(
    await db.waitlistEntry.count({ where: { reservationId: id } }),
    0,
  );
});

test("a failure during multi-person promotion restores capacity and both rosters", async () => {
  const { id, host, input } = await fixture();
  await joinWaitlist(id, { name: "A" }, token());
  await joinWaitlist(id, { name: "B" }, token());
  const before = await db.gameReservation.findUniqueOrThrow({
    where: { id },
    include: { participants: true, waitlist: true },
  });
  // Generated fixture identifiers only; simulate failure after the first promotion.
  const trigger = "promotion_fail_" + token().slice(0, 16);
  await db.$executeRawUnsafe(
    `CREATE TRIGGER ${trigger} BEFORE INSERT ON Participant WHEN NEW.reservationId = '${id}' AND NEW.name = 'B' BEGIN SELECT RAISE(ABORT, 'test'); END`,
  );
  try {
    await assert.rejects(
      editReservation(id, { ...input, maxPlayers: 4, editVersion: 0 }, host),
    );
    assert.deepEqual(
      await db.gameReservation.findUniqueOrThrow({
        where: { id },
        include: { participants: true, waitlist: true },
      }),
      before,
    );
  } finally {
    await db.$executeRawUnsafe(`DROP TRIGGER ${trigger}`);
  }
});

test("unchanged host label cannot overwrite a queued nickname after host rejoined under another name", async () => {
  const { id, host, guest, input } = await fixture();
  await leaveReservation(id, host);
  await joinReservation(id, { name: "Other host name" }, host);
  await joinWaitlist(id, { name: "Host" }, token());
  const before = await detail(id);
  await assert.rejects(
    editReservation(
      id,
      { ...input, description: "Edit notes only", editVersion: 0 },
      host,
    ),
    code("DUPLICATE"),
  );
  assert.deepEqual(await detail(id), before);
  await leaveReservation(id, guest);
  assert.equal((await detail(id)).waitlist.length, 0);
});

test("concurrent entrants cannot exceed 100 waiters or duplicate one browser", async () => {
  const { id } = await fixture();
  await db.waitlistEntry.createMany({
    data: Array.from({ length: 99 }, (_, i) => ({
      reservationId: id,
      name: `W${i}`,
      nameKey: `w${i}`,
      tokenHash: hashToken(token()),
    })),
  });
  const results = await Promise.allSettled([
    joinWaitlist(id, { name: "Last1" }, token()),
    joinWaitlist(id, { name: "Last2" }, token()),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await detail(id)).waitlist.length, 100);
  const second = await fixture(),
    same = token();
  const duplicate = await Promise.allSettled([
    joinWaitlist(second.id, { name: "One" }, same),
    joinWaitlist(second.id, { name: "Two" }, same),
  ]);
  assert.equal(duplicate.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await detail(second.id)).waitlist.length, 1);
});

test("exact start boundary rejects additions and preserves queue while allowing self exit", async (t) => {
  const { id, guest } = await fixture();
  const waiter = token();
  await joinWaitlist(id, { name: "Waiting" }, waiter);
  const boundary = Date.now() + 60000;
  await db.gameReservation.update({
    where: { id },
    data: { scheduledAt: new Date(boundary) },
  });
  t.mock.timers.enable({ apis: ["Date"], now: boundary });
  try {
    await assert.rejects(
      joinWaitlist(id, { name: "Late" }, token()),
      code("STARTED"),
    );
    await assert.rejects(leaveReservation(id, guest), code("STARTED"));
    assert.equal((await detail(id)).waitlist.length, 1);
    await leaveWaitlist(id, waiter);
    assert.equal((await detail(id)).waitlist.length, 0);
  } finally {
    t.mock.timers.reset();
  }
});

test("waiting scope combines Beijing date, cancelled state and future/past pagination", async () => {
  const waiter = token(),
    q = "wait-date-" + token().slice(0, 6);
  const times = [
    "2030-03-01T15:59:59.999Z",
    "2030-03-01T16:00:00.000Z",
    "2030-03-02T15:59:59.999Z",
    "2030-03-02T16:00:00.000Z",
  ];
  const fixtures = [];
  for (const time of times) {
    const f = await fixture();
    fixtures.push(f);
    await joinWaitlist(f.id, { name: "Waiting" }, waiter);
    await db.gameReservation.update({
      where: { id: f.id },
      data: { gameName: q, scheduledAt: new Date(time) },
    });
  }
  const now = new Date("2030-03-02T00:00:00Z");
  const page = await listMyReservations(
    { tab: "waiting", q, date: "2030-03-02" },
    waiter,
    now,
  );
  assert.deepEqual(
    page.items.map((r) => r.id),
    [fixtures[2].id, fixtures[1].id],
  );
  const next = await listMyReservations(
    { tab: "waiting", q, date: "2030-03-02", pageSize: 1, page: 2 },
    waiter,
    now,
  );
  assert.equal(next.items[0].id, fixtures[1].id);
  await db.gameReservation.update({
    where: { id: fixtures[2].id },
    data: { status: "CANCELLED" },
  });
  assert.equal(
    (
      await listMyReservations(
        { tab: "waiting", q, date: "2030-03-02", view: "cancelled" },
        waiter,
        now,
      )
    ).total,
    1,
  );
  // Available keeps its formal-count meaning even for a restored vacancy.
  await db.gameReservation.update({
    where: { id: fixtures[3].id },
    data: { maxPlayers: 3 },
  });
  assert.deepEqual(
    (
      await listMyReservations(
        { tab: "waiting", q, view: "available" },
        waiter,
        now,
      )
    ).items.map((r) => r.id),
    [fixtures[3].id],
  );
});
