import "./support/isolated";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "../server/db";
import { registeredToken, testCookie } from "./support/member";
import { resolveViewer } from "../server/user-identity";
import { listFavorites } from "../server/reservation-favorites";
import { listReservations } from "../server/reservation-list";

const ids: string[] = [],
  users: string[] = [];
after(async () => {
  await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

test("favorites match public list filters and stable cross-boundary pagination with bounded parameterized reads", async (t) => {
  const token = await registeredToken();
  const viewer = await resolveViewer(testCookie(token).split("=")[1]);
  users.push(viewer.user!.id);
  const q = "收藏查询-" + randomUUID();
  const now = new Date("2035-02-01T08:00:00Z");
  const cases = [
    { status: "OPEN", scheduledAt: new Date(now.getTime() + 60000) },
    { status: "OPEN", scheduledAt: new Date(now.getTime() + 60000) },
    {
      status: "FULL",
      scheduledAt: new Date(now.getTime() + 60000),
      full: true,
    },
    { status: "OPEN", scheduledAt: now },
    { status: "STARTED", scheduledAt: new Date(now.getTime() - 60000) },
    { status: "CANCELLED", scheduledAt: new Date(now.getTime() + 60000) },
    { status: "ENDED", scheduledAt: new Date(now.getTime() - 120000) },
    {
      status: "OPEN",
      scheduledAt: new Date(now.getTime() + 60000),
      recruitmentPaused: true,
    },
    {
      status: "OPEN",
      scheduledAt: new Date(now.getTime() + 60000),
      registrationDeadline: now,
    },
  ];
  for (const [i, item] of cases.entries()) {
    const { full, ...data } = item as typeof item & { full?: boolean };
    const r = await db.gameReservation.create({
      data: {
        id: randomUUID(),
        gameName: q,
        hostName: "host",
        platform: "Pc_%中文",
        gameServer: "asia_'区",
        hostTokenHash: "unused-" + i,
        maxPlayers: 2,
        ...data,
        participants: full
          ? {
              create: [0, 1].map((n) => ({
                name: "队员" + n,
                nameKey: "队员" + n,
                tokenHash: `member-${i}-${n}`,
              })),
            }
          : undefined,
        favorites: { create: { userId: viewer.user!.id } },
      },
    });
    ids.push(r.id);
  }
  for (const view of [
    "all",
    "upcoming",
    "available",
    "started",
    "cancelled",
    "ended",
  ]) {
    for (const page of [1, 2, 3, 99]) {
      const input = { q, view, page, pageSize: 2 };
      assert.deepEqual(
        await listFavorites(viewer, input, now),
        await listReservations(input, now),
      );
    }
  }
  for (const [platform, gameServer] of [
    ["pc", "ASIA"],
    ["_", "%"],
    ["中文", "_'"],
    ["' OR 1=1 --", ""],
  ]) {
    const input = { q, platform, gameServer, pageSize: 48 };
    assert.deepEqual(
      await listFavorites(viewer, input, now),
      await listReservations(input, now),
    );
  }

  const original = db.$transaction;
  const transaction = original.bind(db);
  const reads: string[] = [];
  const bound: { sql: string; values: unknown[] }[] = [];
  t.after(() => {
    db.$transaction = original;
  });
  db.$transaction = ((
    run: (tx: Prisma.TransactionClient) => Promise<unknown>,
    options?: object,
  ) =>
    transaction(
      async (tx) =>
        run(
          new Proxy(tx, {
            get(target, key, receiver) {
              const value = Reflect.get(target, key, receiver);
              if (key === "$queryRaw")
                return (query: Prisma.Sql) => {
                  reads.push("queryRaw");
                  bound.push({ sql: query.sql, values: query.values });
                  return Reflect.apply(value, target, [query]);
                };
              if (
                typeof value !== "object" ||
                value === null ||
                String(key).startsWith("$")
              )
                return value;
              return new Proxy(value, {
                get(delegate, method, object) {
                  const call = Reflect.get(delegate, method, object);
                  if (typeof call !== "function") return call;
                  return (...args: unknown[]) => {
                    reads.push(`${String(key)}.${String(method)}`);
                    return Reflect.apply(call, delegate, args);
                  };
                },
              });
            },
          }),
        ),
      options,
    )) as typeof db.$transaction;
  await listFavorites(viewer, { q, pageSize: 1 }, now);
  assert.deepEqual(reads, ["userSession.findFirst", "queryRaw", "queryRaw"]);
  assert.ok(
    bound.every(
      (query) => !query.sql.includes(q) && query.values.includes(`%${q}%`),
    ),
  );
  reads.length = 0;
  await listFavorites(viewer, { q, pageSize: 48 }, now);
  assert.deepEqual(reads, ["userSession.findFirst", "queryRaw", "queryRaw"]);
  reads.length = 0;
  await listFavorites(viewer, { q, platform: "no-match" }, now);
  assert.deepEqual(reads, ["userSession.findFirst", "queryRaw"]);
});
