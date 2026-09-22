import "./support/isolated";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "../server/db";
import { listReservations } from "../server/reservation-list";
import { deleteReservation } from "../server/reservations";
import {
  reservationListSchema,
  reservationListUrl,
  listSearchParams,
} from "../lib/reservation-list";
const actor = { id: 2, username: "test_service_admin" };
const ids: string[] = [];
after(async () => {
  await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});
test("list pagination crosses the upcoming/past boundary without duplicates, exposes only summaries and clamps missing pages", async () => {
  const q = "list-" + randomUUID();
  const now = new Date("2030-01-01T12:00:00Z");
  const fixtures = [
    { suffix: "a", offset: 1000, count: 1 },
    { suffix: "b", offset: 1000, count: 2 },
    { suffix: "c", offset: 2000, count: 1 },
    { suffix: "d", offset: -2000, count: 1 },
    { suffix: "e", offset: 0, count: 1 },
  ];
  for (const f of fixtures) {
    const id = q + f.suffix;
    ids.push(id);
    await db.gameReservation.create({
      data: {
        id,
        gameName: q,
        hostName: "Alex",
        hostTokenHash: "private-owner",
        description: "private-summary-omission",
        scheduledAt: new Date(now.getTime() + f.offset),
        maxPlayers: 2,
        participants: {
          create: Array.from({ length: f.count }, (_, i) => ({
            name: "Player" + i,
            nameKey: "player" + i,
            tokenHash: "secret" + i,
          })),
        },
      },
    });
  }
  const pages = await Promise.all(
    [1, 2, 3].map((page) => listReservations({ q, page, pageSize: 2 }, now)),
  );
  assert.deepEqual(
    pages.flatMap((page) => page.items.map((row) => row.id)),
    fixtures.map((f) => q + f.suffix),
  );
  assert.deepEqual(
    pages.map((page) => page.items.length),
    [2, 2, 1],
  );
  assert.equal(pages[0].total, 5);
  assert.equal(pages[0].pageCount, 3);
  assert.equal(pages[0].items[1].status, "FULL");
  assert.equal(pages[1].items[1].status, "STARTED");
  assert.equal(pages[2].items[0].status, "STARTED");
  assert.deepEqual(Object.keys(pages[0].items[0]).sort(), [
    "gameName",
    "hostName",
    "id",
    "maxPlayers",
    "participantCount",
    "scheduledAt",
    "status",
  ]);
  await deleteReservation(q + "e", actor);
  const clamped = await listReservations({ q, page: 99, pageSize: 2 }, now);
  assert.equal(clamped.page, 2);
  assert.equal(clamped.total, 4);
  assert.equal(
    clamped.items.some((row) => row.id === q + "e"),
    false,
  );
  assert.equal((await listReservations({ q, view: "upcoming" }, now)).total, 3);
  assert.equal((await listReservations({ q, view: "started" }, now)).total, 1);
});
test("search matches hosts; date filtering uses Beijing midnight and excludes soft-deleted rows and cancelled rows from active views", async () => {
  const q = "date-" + randomUUID();
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
        scheduledAt: new Date(times[i]),
        status: i === 2 ? "CANCELLED" : "OPEN",
      },
    });
  }
  const now = new Date("2030-01-01T00:00:00Z");
  const listing = await listReservations({ q, date: "2030-03-02" }, now);
  assert.deepEqual(
    listing.items.map((row) => row.id),
    [q + "1", q + "2"],
  );
  assert.equal(
    (await listReservations({ q, date: "2030-03-02", view: "upcoming" }, now))
      .total,
    1,
  );
  assert.deepEqual(
    (await listReservations({ q, view: "cancelled" }, now)).items.map(
      (row) => row.id,
    ),
    [q + "2"],
  );
  await deleteReservation(q + "2", actor);
  const empty = await listReservations({ q, view: "cancelled", page: 9 }, now);
  assert.deepEqual(
    [empty.total, empty.page, empty.pageCount, empty.items.length],
    [0, 1, 1, 0],
  );
});
test("list query validation bounds work and pagination URLs preserve encoded filters", () => {
  for (const query of [
    { page: 0 },
    { page: -1 },
    { page: 1.5 },
    { page: "1e2" },
    { pageSize: 49 },
    { q: "x".repeat(81) },
    { date: "2030-02-30" },
    { date: "2030-13-01" },
    { date: "not-a-date" },
    { view: "OPEN" },
    listSearchParams(new URLSearchParams("page=1&page=2")),
  ]) {
    assert.equal(
      reservationListSchema.safeParse(query).success,
      false,
      JSON.stringify(query),
    );
  }
  assert.equal(
    reservationListSchema.safeParse({ date: "2032-02-29" }).success,
    true,
  );
  const filters = reservationListSchema.parse({
    q: " 星露谷 & Friends ",
    view: "upcoming",
    date: "2030-03-02",
    pageSize: 24,
  });
  const url = new URL(
    reservationListUrl("/admin", filters, 2),
    "http://localhost",
  );
  assert.equal(url.pathname, "/admin");
  assert.equal(url.searchParams.get("q"), "星露谷 & Friends");
  assert.equal(url.searchParams.get("view"), "upcoming");
  assert.equal(url.searchParams.get("date"), "2030-03-02");
  assert.equal(url.searchParams.get("pageSize"), "24");
  assert.equal(url.searchParams.get("page"), "2");
});
