import "./support/isolated";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../server/db";
import {
  createReservation,
  deleteReservation,
  purgeReservation,
  AppError,
} from "../server/reservations";
import { lookupCreation } from "../server/creation-result";
const ids: string[] = [];
const input = () => ({
  gameName: "Creation result",
  hostName: "Host",
  maxPlayers: 3,
  scheduledAt: new Date(Date.now() + 3600000).toISOString(),
  description: "private notes",
});
after(async () => {
  await db.creationRequest.deleteMany({
    where: { reservationId: { in: ids } },
  });
  await db.adminAuditLog.deleteMany({ where: { targetId: { in: ids } } });
  await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});
test("creation lookup is identity-scoped, survives the start time, and preserves deleted submission tombstones", async () => {
  const token = randomBytes(32).toString("hex"),
    key = randomUUID();
  const reservation = await createReservation(input(), token, key);
  ids.push(reservation.id);
  await db.gameReservation.update({
    where: { id: reservation.id },
    data: { scheduledAt: new Date(0) },
  });
  const result = await lookupCreation(token, key);
  assert.equal(result.state, "found");
  if (result.state !== "found") throw new Error("expected result");
  assert.equal(result.reservation.id, reservation.id);
  assert.equal(result.reservation.scheduledAt, new Date(0).toISOString());
  assert.deepEqual(Object.keys(result.reservation).sort(), [
    "gameName",
    "id",
    "scheduledAt",
  ]);
  assert.deepEqual(await lookupCreation(randomBytes(32).toString("hex"), key), {
    state: "missing",
  });
  assert.deepEqual(await lookupCreation(token, randomUUID()), {
    state: "missing",
  });
  await assert.rejects(
    lookupCreation("", key),
    (e) => e instanceof AppError && e.code === "IDENTITY_REQUIRED",
  );
  const actor = { id: 1, username: "test" };
  await deleteReservation(reservation.id, actor);
  assert.deepEqual(await lookupCreation(token, key), { state: "removed" });
  await purgeReservation(reservation.id, actor);
  assert.deepEqual(await lookupCreation(token, key), { state: "removed" });
  assert.equal(
    await db.creationRequest.count({
      where: { reservationId: reservation.id },
    }),
    1,
  );
});
test(
  "HTTP creation lookup rejects missing identity and malformed keys without disclosing another browser's result",
  { skip: !process.env.TEST_BASE_URL },
  async () => {
    const token = randomBytes(32).toString("hex"),
      key = randomUUID();
    const reservation = await createReservation(input(), token, key);
    ids.push(reservation.id);
    const send = (cookie = token, requestKey: string = key) =>
      fetch(process.env.TEST_BASE_URL + "/api/reservations/submission", {
        headers: {
          Cookie: cookie ? "party_identity=" + cookie : "",
          "Idempotency-Key": requestKey,
        },
      });
    const own = await send();
    assert.equal(own.status, 200);
    assert.equal(own.headers.get("cache-control"), "no-store");
    assert.equal((await own.json()).data.reservation.id, reservation.id);
    assert.deepEqual(
      (await (await send(randomBytes(32).toString("hex"))).json()).data,
      { state: "missing" },
    );
    assert.equal((await send("")).status, 428);
    assert.equal((await send(token, "bad")).status, 400);
  },
);
