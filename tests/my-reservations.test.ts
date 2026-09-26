import "./support/isolated";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../server/db";
import {
  listMyReservations,
  listReservations,
} from "../server/reservation-list";
import {
  createReservation,
  joinReservation,
  leaveReservation,
  cancelReservation,
  deleteReservation,
  restoreReservation,
  hashToken,
} from "../server/reservations";
import {
  myReservationListSchema,
  reservationListUrl,
} from "../lib/reservation-list";

const createdIds: string[] = [];
after(async () => {
  await db.gameReservation.deleteMany({ where: { id: { in: createdIds } } });
  await db.$disconnect();
});

test("personal membership follows create, leave, rejoin, cancel, trash and restore", async () => {
  const owner = randomBytes(32).toString("hex");
  const guest = randomBytes(32).toString("hex");
  const game = await createReservation(
    {
      gameName: randomUUID(),
      hostName: "Host",
      scheduledAt: new Date(Date.now() + 86400000).toISOString(),
      maxPlayers: 3,
    },
    owner,
  );
  createdIds.push(game.id);
  const ids = async (token: string, tab = "joined") =>
    (await listMyReservations({ tab }, token)).items.map((r) => r.id);
  assert.deepEqual(await ids(owner), [game.id]);
  assert.deepEqual(await ids(owner, "hosted"), [game.id]);
  assert.deepEqual(await ids(guest), []);
  await joinReservation(game.id, { name: "Guest" }, guest);
  assert.deepEqual(await ids(guest), [game.id]);
  assert.deepEqual(await ids(guest, "hosted"), []);
  await leaveReservation(game.id, owner);
  assert.deepEqual(await ids(owner), []);
  assert.deepEqual(await ids(owner, "hosted"), [game.id]);
  await joinReservation(game.id, { name: "Host" }, owner);
  await cancelReservation(game.id, { reason: "计划调整" }, owner);
  assert.equal(
    (await listMyReservations({ view: "cancelled" }, owner)).total,
    1,
  );
  const actor = { id: 2, username: "test_admin" };
  await deleteReservation(game.id, actor);
  assert.deepEqual(await ids(owner), []);
  assert.deepEqual(await ids(owner, "hosted"), []);
  await restoreReservation(game.id, actor);
  assert.deepEqual(await ids(owner), [game.id]);
  assert.deepEqual(await ids(guest), [game.id]);
});

test("personal scope is applied before counts, mixed-time pagination and Beijing date filtering", async () => {
  const owner = randomBytes(32).toString("hex");
  const other = randomBytes(32).toString("hex");
  const q = randomUUID();
  const now = new Date("2030-01-02T00:00:00Z");
  const records = [
    ["past", "2030-01-01T16:00:00Z", owner, "OPEN"],
    ["future", "2030-01-02T01:00:00Z", owner, "OPEN"],
    ["cancelled", "2030-01-02T02:00:00Z", owner, "CANCELLED"],
    ["previous-day", "2030-01-01T15:59:59Z", owner, "OPEN"],
    ["other", "2030-01-02T00:30:00Z", other, "OPEN"],
  ];
  for (const [id, time, token, status] of records) {
    createdIds.push(q + id);
    await db.gameReservation.create({
      data: {
        id: q + id,
        gameName: q,
        hostName: "Host",
        hostTokenHash: hashToken(token),
        scheduledAt: new Date(time),
        maxPlayers: 3,
        status,
        participants: {
          create: {
            name: "Host",
            nameKey: "host",
            tokenHash: hashToken(token),
          },
        },
      },
    });
  }
  for (const tab of ["joined", "hosted"]) {
    const input = { q, tab, date: "2030-01-02", pageSize: 2 };
    const first = await listMyReservations(input, owner, now);
    assert.equal(first.total, 3);
    assert.deepEqual(
      first.items.map((r) => r.id),
      [q + "future", q + "cancelled"],
    );
    const last = await listMyReservations({ ...input, page: 999 }, owner, now);
    assert.equal(last.page, 2);
    assert.deepEqual(
      last.items.map((r) => r.id),
      [q + "past"],
    );
    for (const [view, total] of [
      ["upcoming", 1],
      ["started", 1],
      ["cancelled", 1],
    ] as const) {
      assert.equal(
        (await listMyReservations({ ...input, view }, owner, now)).total,
        total,
      );
    }
  }
  assert.equal((await listReservations({ q }, now)).total, 5);
  for (const token of [undefined, "", "invalid"]) {
    const empty = await listMyReservations(
      { page: 99, token: owner, hostTokenHash: hashToken(owner) },
      token,
      now,
    );
    assert.deepEqual(
      [empty.total, empty.page, empty.pageCount, empty.items.length],
      [0, 1, 1, 0],
    );
  }
  const result = JSON.stringify(await listMyReservations({ q }, owner, now));
  assert.equal(result.includes(owner), false);
  assert.equal(result.includes(hashToken(owner)), false);
});

test("personal URLs preserve filters and category while resetting the page", () => {
  const parsed = myReservationListSchema.parse({
    tab: "hosted",
    q: "test",
    page: 8,
    view: "cancelled",
  });
  assert.equal(
    reservationListUrl("/my-reservations", parsed, 1, "joined"),
    "/my-reservations?tab=joined&q=test&view=cancelled",
  );
  assert.equal(myReservationListSchema.parse({}).tab, "joined");
  assert.equal(
    myReservationListSchema.safeParse({ tab: "all" }).success,
    false,
  );
  assert.equal(
    myReservationListSchema.safeParse({ tab: ["hosted", "joined"] }).success,
    false,
  );
});

test(
  "personal server page uses only the cookie identity and does not cache or expose tokens",
  { skip: !process.env.TEST_BASE_URL },
  async () => {
    const base = process.env.TEST_BASE_URL!;
    const owner = randomBytes(32).toString("hex");
    const other = randomBytes(32).toString("hex");
    const gameName = "private-list-" + randomUUID();
    const game = await createReservation(
      {
        gameName,
        hostName: "Host",
        scheduledAt: new Date(Date.now() + 86400000).toISOString(),
        maxPlayers: 3,
      },
      owner,
    );
    createdIds.push(game.id);
    for (const cookie of [
      "",
      "party_identity=invalid",
      "party_identity=" + other,
      "party_identity=" + owner,
    ]) {
      const response = await fetch(
        `${base}/my-reservations?token=${owner}&hostTokenHash=${hashToken(owner)}`,
        { headers: { Cookie: cookie } },
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("set-cookie"), null);
      assert.match(
        response.headers.get("cache-control") || "",
        /no-store|private/,
      );
      const html = await response.text();
      assert.equal(
        html.includes(gameName),
        cookie === "party_identity=" + owner,
      );
      // Request URLs can be included in Next's router payload; inspect a clean URL separately.
    }
    const own = await (
      await fetch(`${base}/my-reservations`, {
        headers: { Cookie: "party_identity=" + owner },
      })
    ).text();
    assert.equal(own.includes(owner), false);
    assert.equal(own.includes(hashToken(owner)), false);
    const invalid = await (
      await fetch(`${base}/my-reservations?tab=invalid`)
    ).text();
    assert.ok(invalid.includes("筛选条件无效"));
  },
);
