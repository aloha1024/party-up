import "./support/isolated";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "../server/db";
import { listDeletedReservations } from "../server/reservation-trash";
import { restoreReservation, purgeReservation } from "../server/reservations";
import {
  reservationTrashSchema,
  reservationTrashUrl,
} from "../lib/reservation-trash";
import { listSearchParams } from "../lib/reservation-list";
const ids: string[] = [];
const actor = { id: 2, username: "trash_test_admin" };
after(async () => {
  await db.adminAuditLog.deleteMany({ where: { targetId: { in: ids } } });
  await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});
test("trash pagination is bounded and stable; restore/purge clamp pages and retain audit records", async () => {
  const q = "trash-" + randomUUID();
  for (let i = 0; i < 6; i++) {
    const id = q + i;
    ids.push(id);
    await db.gameReservation.create({
      data: {
        id,
        gameName: q,
        hostName: "Host",
        maxPlayers: 3,
        scheduledAt: new Date("2030-01-01T00:00:00Z"),
        deletedAt:
          i === 5
            ? null
            : new Date(
                i === 4 ? "2030-03-01T00:00:00Z" : "2030-03-02T00:00:00Z",
              ),
        description: "private-note",
        hostTokenHash: "private-host",
        participants: {
          create: {
            name: "Private player",
            nameKey: "private player",
            tokenHash: "private-token",
          },
        },
      },
    });
  }
  const pages = await Promise.all(
    [1, 2, 3].map((page) => listDeletedReservations({ q, page, pageSize: 2 })),
  );
  assert.deepEqual(
    pages.flatMap((p) => p.items.map((r) => r.id)),
    [0, 1, 2, 3, 4].map((i) => q + i),
  );
  assert.deepEqual(
    pages.map((p) => p.items.length),
    [2, 2, 1],
  );
  assert.equal(pages[0].total, 5);
  assert.equal(pages[0].items[0].participantCount, 1);
  assert.deepEqual(Object.keys(pages[0].items[0]).sort(), [
    "deletedAt",
    "gameName",
    "hostName",
    "id",
    "participantCount",
  ]);
  await restoreReservation(q + 4, actor);
  const clamped = await listDeletedReservations({ q, page: 3, pageSize: 2 });
  assert.deepEqual(
    [clamped.total, clamped.page, clamped.pageCount, clamped.filters.page],
    [4, 2, 2, 2],
  );
  assert.equal(
    await db.participant.count({ where: { reservationId: q + 4 } }),
    1,
  );
  await assert.rejects(purgeReservation(q + 4, actor), { code: "NOT_DELETED" });
  assert.equal(await db.adminAuditLog.count({ where: { targetId: q + 4 } }), 1);
  await purgeReservation(q + 3, actor);
  assert.equal((await listDeletedReservations({ q })).total, 3);
  assert.equal(
    await db.participant.count({ where: { reservationId: q + 3 } }),
    0,
  );
  assert.equal(
    await db.adminAuditLog.count({
      where: { targetId: q + 3, action: "RESERVATION_PURGE" },
    }),
    1,
  );
  const empty = await listDeletedReservations({ q: q + 3, page: 9 });
  assert.deepEqual(
    [empty.total, empty.page, empty.pageCount, empty.items.length],
    [0, 1, 1, 0],
  );
});
test("trash filters use deletion date at Beijing midnight and match host or reservation ID", async () => {
  const q = "trash-date-" + randomUUID();
  const times = [
    "2030-03-01T15:59:59.999Z",
    "2030-03-01T16:00:00.000Z",
    "2030-03-02T15:59:59.999Z",
    "2030-03-02T16:00:00.000Z",
  ];
  for (let i = 0; i < times.length; i++) {
    const id = q + i;
    ids.push(id);
    await db.gameReservation.create({
      data: {
        id,
        gameName: "Game",
        hostName: q,
        maxPlayers: 2,
        scheduledAt: new Date("2031-01-01T00:00:00Z"),
        deletedAt: new Date(times[i]),
        status: i === 2 ? "CANCELLED" : "OPEN",
      },
    });
  }
  const listing = await listDeletedReservations({ q, date: "2030-03-02" });
  assert.deepEqual(
    listing.items.map((r) => r.id),
    [q + 2, q + 1],
  );
  const byId = await listDeletedReservations({ q: q + 1 });
  assert.deepEqual(
    byId.items.map((r) => r.id),
    [q + 1],
  );
});
test("trash rejects malformed, duplicate and excessive query inputs and preserves encoded filters in links", () => {
  for (const input of [
    { page: 0 },
    { page: "1e2" },
    { page: 100001 },
    { pageSize: 49 },
    { date: "2030-02-30" },
    { q: "x".repeat(81) },
    listSearchParams(new URLSearchParams("page=1&page=2")),
    listSearchParams(new URLSearchParams("q=a&q=b")),
    listSearchParams(new URLSearchParams("date=2030-01-01&date=2030-01-02")),
  ])
    assert.equal(reservationTrashSchema.safeParse(input).success, false);
  assert.equal(reservationTrashSchema.parse({}).pageSize, 12);
  const filters = reservationTrashSchema.parse({
    q: " 游戏 & Host ",
    date: "2032-02-29",
    pageSize: 24,
  });
  const url = new URL(reservationTrashUrl(filters, 2), "http://localhost");
  assert.equal(url.pathname, "/admin/trash");
  assert.equal(url.searchParams.get("q"), "游戏 & Host");
  assert.equal(url.searchParams.get("date"), "2032-02-29");
  assert.equal(url.searchParams.get("pageSize"), "24");
  assert.equal(url.searchParams.get("page"), "2");
  assert.equal(
    reservationTrashUrl(reservationTrashSchema.parse({})),
    "/admin/trash",
  );
});
