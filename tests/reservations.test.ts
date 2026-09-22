import "./support/isolated";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { db } from "../server/db";
import {
  createReservation,
  joinReservation,
  leaveReservation,
  detail,
  AppError,
} from "../server/reservations";
import { createSchema, joinSchema } from "../lib/validation";
import { getStatus } from "../lib/status";
const ids: string[] = [];
const input = () => ({
  gameName: "测试游戏",
  hostName: "Alex",
  scheduledAt: new Date(Date.now() + 3600000).toISOString(),
  maxPlayers: 3,
  description: "",
});
async function create(maxPlayers = 3) {
  const host = randomUUID();
  const r = await createReservation({ ...input(), maxPlayers }, host);
  ids.push(r.id);
  return { r, host };
}
after(async () => {
  await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});
test("validation rejects empty, invalid, past and oversized input", () => {
  for (const patch of [
    { gameName: " " },
    { hostName: "" },
    { maxPlayers: 1 },
    { maxPlayers: 2.5 },
    { scheduledAt: new Date(0).toISOString() },
    { description: "x".repeat(1001) },
  ])
    assert.equal(
      createSchema.safeParse({ ...input(), ...patch }).success,
      false,
    );
  assert.equal(joinSchema.safeParse({ name: " ".repeat(4) }).success, false);
  assert.equal(joinSchema.safeParse({ name: "x".repeat(25) }).success, false);
});
test("dynamic status prioritizes cancellation and start", () => {
  const r = { ...input(), status: "OPEN" };
  assert.equal(getStatus(r, 1), "OPEN");
  assert.equal(getStatus(r, 3), "FULL");
  assert.equal(getStatus({ ...r, scheduledAt: new Date(0) }, 3), "STARTED");
  assert.equal(getStatus({ ...r, status: "CANCELLED" }, 1), "CANCELLED");
});
test("host joins, normalized duplicates fail, identity is private, leave frees seat", async () => {
  const { r, host } = await create(2);
  assert.equal(r.participants[0].isMe, true);
  await assert.rejects(
    joinReservation(r.id, { name: " ＡＬＥＸ " }, randomUUID()),
    (e: unknown) => e instanceof AppError && e.code === "DUPLICATE",
  );
  const token = randomUUID();
  const joined = await joinReservation(r.id, { name: "Mike" }, token);
  assert.equal(joined.status, "FULL");
  assert.deepEqual(
    joined.participants.map((p) => p.name),
    ["Alex", "Mike"],
  );
  assert.equal(JSON.stringify(joined).includes("tokenHash"), false);
  await assert.rejects(
    leaveReservation(r.id, randomUUID()),
    (e: unknown) => e instanceof AppError && e.status === 403,
  );
  assert.equal((await leaveReservation(r.id, token)).status, "OPEN");
  assert.equal((await detail(r.id, host)).participants.length, 1);
});
test("concurrent joins never exceed capacity", async () => {
  const { r } = await create(3);
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, (_, i) =>
      joinReservation(r.id, { name: `Player${i}` }, randomUUID()),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  assert.equal((await detail(r.id)).participants.length, 3);
});
test("started, cancelled and missing reservations reject mutations", async () => {
  const { r, host } = await create();
  await db.gameReservation.update({
    where: { id: r.id },
    data: { scheduledAt: new Date(0) },
  });
  await assert.rejects(
    joinReservation(r.id, { name: "Mike" }, randomUUID()),
    (e: unknown) => e instanceof AppError && e.code === "STARTED",
  );
  await assert.rejects(
    leaveReservation(r.id, host),
    (e: unknown) => e instanceof AppError && e.code === "STARTED",
  );
  await db.gameReservation.update({
    where: { id: r.id },
    data: { status: "CANCELLED" },
  });
  await assert.rejects(
    joinReservation(r.id, { name: "Mike" }, randomUUID()),
    (e: unknown) => e instanceof AppError && e.code === "CANCELLED",
  );
  await assert.rejects(
    detail("does-not-exist"),
    (e: unknown) => e instanceof AppError && e.status === 404,
  );
});
test("independent database clients obey reservation lock", async () => {
  const { r } = await create(2);
  const other = new PrismaClient();
  try {
    const results = await Promise.allSettled([
      joinReservation(r.id, { name: "One" }, randomUUID()),
      other.$transaction(async (tx) => {
        await tx.gameReservation.update({
          where: { id: r.id },
          data: { revision: { increment: 1 } },
        });
        const count = await tx.participant.count({
          where: { reservationId: r.id },
        });
        if (count >= 2) throw new Error("FULL");
        await tx.participant.create({
          data: {
            reservationId: r.id,
            name: "Two",
            nameKey: "two",
            tokenHash: randomUUID(),
          },
        });
      }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await detail(r.id)).participants.length, 2);
  } finally {
    await other.$disconnect();
  }
});
