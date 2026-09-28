import "./support/isolated";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "../server/db";
import { listMySchedule } from "../server/reservation-schedule";
import {
  personalPageSchema,
  personalPageUrl,
  scheduleBounds,
  scheduleWakeups,
} from "../lib/reservation-schedule";
import { digest, resolveViewer } from "../server/user-identity";
import { registeredToken, testCookie } from "./support/member";
import {
  createReservation,
  joinReservation,
  leaveReservation,
  joinWaitlist,
  leaveWaitlist,
  cancelReservation,
  deleteReservation,
  restoreReservation,
} from "../server/reservations";

const ids: string[] = [];
after(async () => {
  await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});
const token = () => randomBytes(32).toString("hex");
const now = new Date("2030-01-01T16:00:00Z");
async function seed(
  owner: string,
  options: {
    id?: string;
    host?: boolean;
    joined?: boolean;
    waiting?: boolean;
    status?: string;
    time?: string;
    checked?: boolean;
    deleted?: boolean;
    invite?: boolean;
  } = {},
) {
  const id = options.id ?? randomUUID();
  ids.push(id);
  return db.gameReservation.create({
    data: {
      id,
      gameName: "日程 " + id,
      hostName: "Host",
      hostTokenHash: digest(options.host ? owner : token()),
      scheduledAt: new Date(options.time ?? "2030-01-02T02:00:00Z"),
      maxPlayers: 4,
      status: options.status ?? "OPEN",
      visibility: options.invite ? "INVITE" : "PUBLIC",
      deletedAt: options.deleted ? now : null,
      participants: options.joined
        ? {
            create: {
              name: "本人",
              nameKey: "本人",
              tokenHash: digest(owner),
              checkedInAt: options.checked ? now : null,
            },
          }
        : undefined,
      waitlist: options.waiting
        ? {
            create: { name: "候补", nameKey: "候补", tokenHash: digest(owner) },
          }
        : undefined,
    },
  });
}

test("schedule URL validation preserves independent list state and uses Beijing calendar boundaries", () => {
  const f = personalPageSchema.parse({
    tab: "waiting",
    q: "中文 & Game",
    view: "cancelled",
    date: "2030-01-01",
    page: "7",
    pageSize: "24",
    layout: "schedule",
    range: "today",
    schedulePage: "3",
  });
  const u = new URL(personalPageUrl(f, { layout: "list" }), "http://local");
  assert.equal(u.searchParams.get("q"), f.q);
  assert.equal(u.searchParams.get("page"), "7");
  assert.equal(u.searchParams.get("tab"), "waiting");
  assert.equal(u.searchParams.get("date"), f.date);
  assert.equal(u.searchParams.get("schedulePage"), "3");
  assert.equal(u.searchParams.get("layout"), null);
  assert.equal(
    new URL(
      personalPageUrl(f, { range: "week", schedulePage: 1 }),
      "http://local",
    ).searchParams.get("schedulePage"),
    null,
  );
  for (const bad of [
    { layout: ["list", "schedule"] },
    { range: ["today", "week"] },
    { schedulePage: ["1", "2"] },
    { range: "month" },
    { layout: "grid" },
    { schedulePage: "0" },
    { schedulePage: "1.5" },
  ])
    assert.equal(personalPageSchema.safeParse(bad).success, false);
  assert.equal(personalPageSchema.parse({}).layout, "list");
  const week = scheduleBounds("week", new Date("2029-12-31T15:59:59.999Z"));
  assert.equal(week.day, "2029-12-31");
  assert.equal(week.end.toISOString(), "2030-01-06T16:00:00.000Z");
  assert.equal(
    scheduleBounds(
      "today",
      new Date("2029-12-31T16:00:00Z"),
    ).start.toISOString(),
    "2029-12-31T16:00:00.000Z",
  );
  assert.equal(
    scheduleBounds("week", new Date("2032-02-28T16:00:00Z")).end.toISOString(),
    "2032-03-06T16:00:00.000Z",
  );
});

test("schedule merges roles without duplication, isolates identities and exposes only summaries", async () => {
  const a = token(),
    b = token();
  const both = await seed(a, { host: true, joined: true, invite: true });
  const host = await seed(a, { host: true });
  const waiting = await seed(a, { waiting: true, invite: true });
  await seed(a, { joined: true, deleted: true });
  await seed(b, { host: true, joined: true });
  const acceptedOnly = await seed(a, { invite: true });
  await db.reservationAccess.create({
    data: {
      reservationId: acceptedOnly.id,
      tokenHash: digest(a),
      inviteVersion: 1,
      hasJoined: true,
    },
  });
  const result = await listMySchedule(
    {
      range: "today",
      tab: "waiting",
      view: "ended",
      q: "ignored",
      date: "2000-01-01",
    },
    a,
    now,
  );
  assert.equal(result.total, 3);
  const row = result.items.find((r) => r.id === both.id)!;
  assert.ok(row.isHost && row.isParticipant);
  assert.equal(row.isWaiting, false);
  assert.equal(result.items.find((r) => r.id === host.id)!.attendance, null);
  assert.equal(result.items.find((r) => r.id === waiting.id)!.isWaiting, true);
  assert.equal((await listMySchedule({}, b, now)).total, 1);
  for (const absent of [undefined, "invalid", ""]) {
    const empty = await listMySchedule(
      { schedulePage: 99, token: a },
      absent,
      now,
    );
    assert.deepEqual([empty.total, empty.page, empty.pageCount], [0, 1, 1]);
  }
  const encoded = JSON.stringify(result);
  for (const privateValue of [
    a,
    digest(a),
    "tokenHash",
    "participants",
    "inviteHash",
    "inviteCipher",
    "nameKey",
  ])
    assert.equal(encoded.includes(privateValue), false);
});

test("schedule date edges, closed states and exact attendance window use one supplied time", async () => {
  const a = token();
  const start = await seed(a, { joined: true, time: now.toISOString() });
  await seed(a, {
    host: true,
    time: new Date(now.getTime() - 1).toISOString(),
  });
  await seed(a, {
    host: true,
    time: new Date(now.getTime() + 7 * 86400000).toISOString(),
  });
  const last = await seed(a, {
    host: true,
    time: new Date(now.getTime() + 7 * 86400000 - 1).toISOString(),
  });
  const closed = await seed(a, {
    joined: true,
    checked: true,
    status: "ENDED",
  });
  const cancelled = await seed(a, { joined: true, status: "CANCELLED" });
  const opens = await seed(a, {
    joined: true,
    time: new Date(now.getTime() + 30 * 60000).toISOString(),
  });
  const notYet = await seed(a, {
    joined: true,
    time: new Date(now.getTime() + 30 * 60000 + 1).toISOString(),
  });
  const confirmed = await seed(a, { joined: true, checked: true });
  const result = await listMySchedule({}, a, now);
  assert.equal(result.total, 7);
  assert.ok(result.items.some((r) => r.id === last.id));
  const row = (id: string) => result.items.find((r) => r.id === id)!;
  assert.equal(row(start.id).status, "STARTED");
  assert.equal(row(start.id).attendance, "ready");
  assert.equal(row(opens.id).attendance, "ready");
  assert.equal(row(notYet.id).attendance, "waiting");
  assert.equal(row(closed.id).attendance, "closed");
  assert.equal(row(cancelled.id).attendance, "closed");
  assert.equal(row(confirmed.id).attendance, "confirmed");
  assert.equal(row(closed.id).checkedInAt, now.toISOString());
  assert.equal((await listMySchedule({ range: "today" }, a, now)).total, 6);
  assert.ok(scheduleWakeups(result).includes(result.midnight));
  assert.ok(scheduleWakeups(result).includes(now.toISOString()));
  const stable = await listMySchedule({}, a, new Date(now.getTime() + 100));
  assert.equal(
    stable.items.find((r) => r.id === notYet.id)!.attendance,
    "ready",
  );
});

test("schedule nearest and simultaneous hints include other pages with stable bounded reads", async (t) => {
  const a = token(),
    prefix = randomUUID();
  for (let i = 0; i < 13; i++)
    await seed(a, { id: prefix + String(i).padStart(2, "0"), joined: true });
  await seed(a, { joined: true, status: "CANCELLED" });
  await seed(a, { joined: true, status: "ENDED" });
  await seed(a, { waiting: true });
  await seed(a, { host: true });
  let counts: Record<string, number> = {};
  const original = db.$transaction;
  const transaction = original.bind(db);
  t.after(() => {
    db.$transaction = original;
  });
  db.$transaction = ((
    run: (tx: Prisma.TransactionClient) => Promise<unknown>,
    options: object,
  ) =>
    transaction(
      async (tx) =>
        run(
          new Proxy(tx, {
            get(target, key, receiver) {
              if (key !== "gameReservation")
                return Reflect.get(target, key, receiver);
              return new Proxy(tx.gameReservation, {
                get(delegate, method, receiver) {
                  const value = Reflect.get(delegate, method, receiver);
                  if (
                    !["count", "findMany", "findFirst", "groupBy"].includes(
                      String(method),
                    )
                  )
                    return value;
                  return (...args: unknown[]) => {
                    counts[String(method)] = (counts[String(method)] ?? 0) + 1;
                    return Reflect.apply(value, delegate, args);
                  };
                },
              });
            },
          }),
        ),
      options,
    )) as typeof db.$transaction;
  const first = await listMySchedule({}, a, now);
  assert.equal(first.total, 17);
  assert.equal(first.items.length, 12);
  assert.deepEqual(counts, { count: 1, findMany: 1, findFirst: 1, groupBy: 1 });
  const last = await listMySchedule({ schedulePage: 999 }, a, now);
  assert.equal(last.page, 2);
  assert.equal(last.items.length, 5);
  assert.equal(last.nearest!.id, prefix + "00");
  for (const row of [...first.items, ...last.items])
    assert.equal(
      row.simultaneous,
      row.isParticipant && !["CANCELLED", "ENDED"].includes(row.status),
    );
  assert.equal(
    new Set([...first.items, ...last.items].map((r) => r.id)).size,
    17,
  );
  counts = {};
  await listMySchedule({}, token(), now);
  assert.deepEqual(counts, { count: 1 });
  counts = {};
  await listMySchedule({}, undefined, now);
  assert.deepEqual(counts, {});
  const before = await listMySchedule({}, a, now);
  assert.deepEqual(
    before,
    await listMySchedule({}, a, new Date(now.getTime() + 1000)),
  );
});

test("schedule follows joining, promotion, leaving, cancellation and deletion restoration", async () => {
  const host = token(),
    guest = token(),
    later = new Date(Date.now() + 3600000);
  const game = await createReservation(
    {
      gameName: "Schedule lifecycle",
      hostName: "Host",
      scheduledAt: later.toISOString(),
      maxPlayers: 2,
    },
    host,
  );
  ids.push(game.id);
  await joinReservation(game.id, { name: "Guest" }, guest);
  const waiting = token();
  await joinWaitlist(game.id, { name: "Waiting" }, waiting);
  assert.equal((await listMySchedule({}, waiting)).items[0].isWaiting, true);
  await leaveReservation(game.id, guest);
  assert.equal((await listMySchedule({}, guest)).total, 0);
  let row = (await listMySchedule({}, waiting)).items[0];
  assert.equal(row.isParticipant, true);
  assert.equal(row.isWaiting, false);
  await leaveReservation(game.id, waiting);
  await joinReservation(game.id, { name: "Again" }, guest);
  await joinWaitlist(game.id, { name: "Waiting" }, waiting);
  await leaveWaitlist(game.id, waiting);
  assert.equal((await listMySchedule({}, waiting)).total, 0);
  await cancelReservation(game.id, { reason: "测试取消" }, host);
  assert.equal((await listMySchedule({}, guest)).items[0].status, "CANCELLED");
  const actor = { id: 2, username: "test_admin" };
  await deleteReservation(game.id, actor);
  assert.equal((await listMySchedule({}, guest)).total, 0);
  await restoreReservation(game.id, actor);
  assert.equal((await listMySchedule({}, guest)).total, 1);
});

test("account schedule identity is shared across sessions and invalid sessions cannot fall back to guest records", async () => {
  const member = await registeredToken();
  const cookie = testCookie(member).split("=")[1];
  const user = await db.user.findUniqueOrThrow({
    where: { identityKey: member.slice(5) },
  });
  const second = token();
  await db.userSession.create({
    data: {
      id: digest(second),
      userId: user.id,
      version: user.version,
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  await seed(member, { joined: true, invite: true });
  const firstViewer = await resolveViewer(cookie),
    secondViewer = await resolveViewer(second);
  assert.deepEqual(
    await listMySchedule({}, firstViewer.token, now),
    await listMySchedule({}, secondViewer.token, now),
  );
  const guest = token();
  await seed(guest, { host: true });
  await db.user.update({ where: { id: user.id }, data: { isActive: false } });
  const invalid = await resolveViewer(second, guest);
  assert.equal(invalid.mode, "invalid");
  assert.equal((await listMySchedule({}, invalid.token, now)).total, 0);
});

test(
  "schedule server page preserves privacy and validates query parameters",
  { skip: !process.env.TEST_BASE_URL },
  async () => {
    const a = token();
    const r = await seed(a, {
      host: true,
      joined: true,
      invite: true,
      time: new Date(Date.now() + 3600000).toISOString(),
    });
    const base = process.env.TEST_BASE_URL!;
    for (const cookie of [
      "",
      "party_identity=invalid",
      "party_identity=" + token(),
      "party_identity=" + a,
    ]) {
      const response = await fetch(base + "/my-reservations?layout=schedule", {
        headers: { Cookie: cookie },
      });
      const html = await response.text();
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("set-cookie"), null);
      assert.equal(html.includes(r.gameName), cookie.endsWith(a));
      assert.equal(html.includes(digest(a)), false);
      assert.equal(html.includes(a), false);
      assert.match(
        response.headers.get("cache-control") ?? "",
        /private|no-store/,
      );
    }
    for (const query of [
      "layout=schedule&layout=list",
      "layout=schedule&range=bad",
      "layout=schedule&range=week&range=today",
      "layout=schedule&schedulePage=1&schedulePage=2",
    ]) {
      assert.match(
        await (await fetch(base + "/my-reservations?" + query)).text(),
        /筛选条件无效/,
      );
    }
    const injected = await (
      await fetch(
        base +
          `/my-reservations?layout=schedule&token=${a}&hostTokenHash=${digest(a)}`,
      )
    ).text();
    assert.equal(injected.includes(r.gameName), false);
  },
);
