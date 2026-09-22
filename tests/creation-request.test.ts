import "./support/isolated";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "../server/db";
import {
  createReservation,
  deleteReservation,
  purgeReservation,
  AppError,
} from "../server/reservations";
const ids: string[] = [];
after(async () => {
  await db.creationRequest.deleteMany({
    where: { reservationId: { in: ids } },
  });
  await db.adminAuditLog.deleteMany({ where: { targetId: { in: ids } } });
  await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});
const data = () => ({
  gameName: "Replay",
  hostName: "Host",
  maxPlayers: 3,
  scheduledAt: new Date(Date.now() + 3600000).toISOString(),
});
test("concurrent identical creation requests return one reservation with one host", async () => {
  const token = randomUUID(),
    key = randomUUID(),
    input = data();
  const rows = await Promise.all(
    Array.from({ length: 5 }, () => createReservation(input, token, key)),
  );
  ids.push(rows[0].id);
  assert.equal(new Set(rows.map((r) => r.id)).size, 1);
  assert.equal(
    await db.participant.count({ where: { reservationId: rows[0].id } }),
    1,
  );
  assert.equal(
    await db.creationRequest.count({ where: { reservationId: rows[0].id } }),
    1,
  );
  await assert.rejects(
    createReservation({ ...input, gameName: "different" }, token, key),
    (e) => e instanceof AppError && e.code === "SUBMISSION_CHANGED",
  );
  const other = await createReservation(input, randomUUID(), key);
  ids.push(other.id);
  assert.notEqual(other.id, rows[0].id);
});
test("replay returns original after time passes and never resurrects a removed reservation", async () => {
  const token = randomUUID(),
    key = randomUUID(),
    input = data(),
    actor = { id: 2, username: "test" };
  const r = await createReservation(input, token, key);
  ids.push(r.id);
  await db.gameReservation.update({
    where: { id: r.id },
    data: { scheduledAt: new Date(0) },
  });
  assert.equal((await createReservation(input, token, key)).id, r.id);
  await deleteReservation(r.id, actor);
  await assert.rejects(
    createReservation(input, token, key),
    (e) => e instanceof AppError && e.code === "REMOVED",
  );
  await purgeReservation(r.id, actor);
  await assert.rejects(
    createReservation(input, token, key),
    (e) => e instanceof AppError && e.code === "REMOVED",
  );
  assert.equal(await db.gameReservation.count({ where: { id: r.id } }), 0);
  assert.equal(
    await db.creationRequest.count({ where: { reservationId: r.id } }),
    1,
  );
});
test("invalid creation rolls back its submission claim", async () => {
  const token = randomUUID(),
    key = randomUUID(),
    input = data();
  await assert.rejects(
    createReservation(
      { ...input, scheduledAt: new Date(0).toISOString() },
      token,
      key,
    ),
  );
  const r = await createReservation(input, token, key);
  ids.push(r.id);
  assert.equal(r.participants.length, 1);
});
