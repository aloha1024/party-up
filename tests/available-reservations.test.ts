import "./support/isolated";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "../server/db";
import {
  listReservations,
  listMyReservations,
} from "../server/reservation-list";
import {
  createReservation,
  joinReservation,
  leaveReservation,
  editReservation,
  deleteReservation,
  restoreReservation,
  hashToken,
} from "../server/reservations";
import {
  reservationListSchema,
  reservationListUrl,
} from "../lib/reservation-list";
const ids: string[] = [];
after(async () => {
  await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});

test("available filtering precedes pagination and respects capacity, time, date and personal scope", async () => {
  const q = randomUUID();
  const owner = randomBytes(32).toString("hex");
  const now = new Date("2030-01-01T16:00:00Z");
  for (const [suffix, count, offset, status, deleted] of [
    ["a", 0, 1, "OPEN", false],
    ["b", 2, 2, "OPEN", false],
    ["c", 1, 3, "OPEN", false],
    ["d", 3, 4, "OPEN", false],
    ["e", 0, 5, "CANCELLED", false],
    ["f", 0, 6, "OPEN", true],
    ["g", 0, 0, "OPEN", false],
    ["h", 0, -1, "OPEN", false],
    ["i", 1, 86400000, "OPEN", false],
  ] as const) {
    ids.push(q + suffix);
    await db.gameReservation.create({
      data: {
        id: q + suffix,
        gameName: q,
        hostName: "Host",
        hostTokenHash: hashToken(owner),
        maxPlayers: 2,
        scheduledAt: new Date(now.getTime() + offset),
        status,
        deletedAt: deleted ? now : null,
        participants: {
          create: Array.from({ length: count }, (_, i) => ({
            name: "P" + i,
            nameKey: "p" + i,
            tokenHash: i === 0 ? hashToken(owner) : "other" + i,
          })),
        },
      },
    });
  }
  const input = { q, view: "available", pageSize: 1, date: "2030-01-02" };
  for (const [page, id] of [
    [1, "a"],
    [2, "c"],
    [999, "c"],
  ] as const) {
    const result = await listReservations({ ...input, page }, now);
    assert.equal(result.total, 2);
    assert.equal(result.page, Math.min(page, 2));
    assert.deepEqual(
      result.items.map((r) => r.id),
      [q + id],
    );
    assert.equal(result.items[0].status, "OPEN");
  }
  assert.equal(
    (await listMyReservations({ ...input, tab: "hosted" }, owner, now)).total,
    2,
  );
  const joined = await listMyReservations(
    { ...input, tab: "joined" },
    owner,
    now,
  );
  assert.deepEqual(
    joined.items.map((r) => r.id),
    [q + "c"],
  );
  assert.equal((await listMyReservations(input, "invalid", now)).total, 0);
  assert.equal(
    (await listMyReservations(input, randomBytes(32).toString("hex"), now))
      .total,
    0,
  );
  assert.equal(
    (await listReservations({ ...input, date: "2030-01-03" }, now)).total,
    1,
  );
  const serialized = JSON.stringify(joined);
  assert.equal(serialized.includes(hashToken(owner)), false);
  assert.equal(serialized.includes('"participants"'), false);
});

test("available SQL search matches Prisma contains including wildcard, quotes and normalization", async () => {
  const now = new Date("2040-01-01T00:00:00Z");
  for (const value of [
    "Alpha中文",
    "ALPHA",
    "percent%_",
    "quote' OR 1=1 --",
    "slash\\x",
    "éÉ",
    "全角Ａ",
  ]) {
    const row = await db.gameReservation.create({
      data: {
        gameName: value,
        hostName: value,
        maxPlayers: 2,
        scheduledAt: new Date(now.getTime() + 1000),
      },
    });
    ids.push(row.id);
  }
  for (const q of [
    "alpha",
    "中文",
    "%",
    "_",
    "' OR 1=1 --",
    "\\",
    "é",
    "Ａ",
    "not-found",
  ]) {
    const input = { q, pageSize: 48, date: "2040-01-01" };
    const expected = await listReservations(
      { ...input, view: "upcoming" },
      now,
    );
    const actual = await listReservations({ ...input, view: "available" }, now);
    assert.deepEqual(actual.items, expected.items, q);
    assert.equal(actual.total, expected.total, q);
  }
});

test("joining, leaving, capacity edits and trash restore update availability", async () => {
  const owner = randomBytes(32).toString("hex");
  const guest = randomBytes(32).toString("hex");
  const input = {
    gameName: randomUUID(),
    hostName: "Host",
    maxPlayers: 2,
    scheduledAt: new Date(Date.now() + 86400000).toISOString(),
    description: "",
  };
  const created = await createReservation(input, owner);
  ids.push(created.id);
  const count = async () =>
    (await listReservations({ q: input.gameName, view: "available" })).total;
  assert.equal(await count(), 1);
  await joinReservation(created.id, { name: "Guest" }, guest);
  assert.equal(await count(), 0);
  await leaveReservation(created.id, guest);
  assert.equal(await count(), 1);
  await joinReservation(created.id, { name: "Guest" }, guest);
  await editReservation(
    created.id,
    { ...input, maxPlayers: 3, editVersion: 0 },
    owner,
  );
  assert.equal(await count(), 1);
  const actor = { id: 2, username: "test_admin" };
  await deleteReservation(created.id, actor);
  assert.equal(await count(), 0);
  await restoreReservation(created.id, actor);
  assert.equal(await count(), 1);
});

test("available query uses one count and at most two page reads, with bound inputs", async (t) => {
  const row = await db.gameReservation.create({
    data: {
      gameName: "bounded-" + randomUUID(),
      hostName: "Host",
      maxPlayers: 2,
      scheduledAt: new Date(Date.now() + 86400000),
    },
  });
  ids.push(row.id);
  const original = db.$transaction;
  const transaction = original.bind(db);
  let sqlCalls = 0,
    reads = 0;
  db.$transaction = ((
    run: (tx: Prisma.TransactionClient) => Promise<unknown>,
    options: object,
  ) =>
    transaction(async (tx) => {
      const delegate = new Proxy(tx.gameReservation, {
        get(target, key, receiver) {
          if (key === "findMany")
            return (
              ...args: Parameters<typeof tx.gameReservation.findMany>
            ) => {
              reads++;
              return tx.gameReservation.findMany(...args);
            };
          return Reflect.get(target, key, receiver);
        },
      });
      return run(
        new Proxy(tx, {
          get(target, key, receiver) {
            if (key === "gameReservation") return delegate;
            if (key === "$queryRaw")
              return (query: Prisma.Sql) => {
                sqlCalls++;
                assert.equal(query.sql.includes(row.gameName), false);
                return tx.$queryRaw(query);
              };
            return Reflect.get(target, key, receiver);
          },
        }),
      );
    }, options)) as typeof db.$transaction;
  t.after(() => {
    db.$transaction = original;
  });
  await listReservations({ q: row.gameName, view: "available" });
  assert.deepEqual([sqlCalls, reads], [2, 1]);
  sqlCalls = reads = 0;
  const empty = await listReservations({
    q: "absent-" + row.gameName,
    view: "available",
    page: 999,
  });
  assert.deepEqual([sqlCalls, reads], [1, 0]);
  assert.deepEqual([empty.total, empty.page, empty.pageCount], [0, 1, 1]);
});

test(
  "HTTP available parameter and pagination links preserve the existing contract",
  { skip: !process.env.TEST_BASE_URL },
  async () => {
    const filters = reservationListSchema.parse({
      view: "available",
      q: "测试",
      page: 2,
    });
    assert.ok(
      reservationListUrl("/my-reservations", filters, 2, "hosted").includes(
        "view=available",
      ),
    );
    const base = process.env.TEST_BASE_URL!;
    const response = await fetch(base + "/api/reservations?view=available");
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data.filters.view, "available");
    assert.ok(
      data.items.every(
        (r: { status: string; participantCount: number; maxPlayers: number }) =>
          r.status === "OPEN" && r.participantCount < r.maxPlayers,
      ),
    );
    for (const query of ["view=available&view=all", "view=bad"])
      assert.equal(
        (await fetch(base + "/api/reservations?" + query)).status,
        400,
      );
  },
);
