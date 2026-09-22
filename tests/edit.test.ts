import "./support/isolated";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "../server/db";
import {
  createReservation,
  editReservation,
  joinReservation,
  leaveReservation,
  detail,
  AppError,
} from "../server/reservations";
const ids: string[] = [];
const data = () => ({
  gameName: "Edit test",
  hostName: "Alex",
  maxPlayers: 3,
  scheduledAt: new Date(Date.now() + 3600000).toISOString(),
  description: "",
});
after(async () => {
  await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});
test("only creator edits, ownership survives leaving, same URL and roster remain", async () => {
  const token = randomUUID();
  const input = data();
  const r = await createReservation(input, token);
  ids.push(r.id);
  assert.equal(r.isHost, true);
  assert.equal((await detail(r.id)).isHost, false);
  await assert.rejects(
    editReservation(r.id, input, randomUUID()),
    (e: unknown) => e instanceof AppError && e.status === 403,
  );
  const updated = await editReservation(
    r.id,
    {
      ...input,
      gameName: "Updated",
      hostName: "NewAlex",
      description: "new notes",
    },
    token,
  );
  assert.equal(updated.id, r.id);
  assert.equal(updated.participants[0].name, "NewAlex");
  assert.equal(updated.participants[0].joinedAt, r.participants[0].joinedAt);
  await leaveReservation(r.id, token);
  assert.equal((await editReservation(r.id, input, token)).isHost, true);
});
test("editing prevents overcapacity and nickname collisions and blocks started/legacy records", async () => {
  const token = randomUUID();
  const input = data();
  const r = await createReservation(input, token);
  ids.push(r.id);
  await joinReservation(r.id, { name: "Mike" }, randomUUID());
  await joinReservation(r.id, { name: "Jack" }, randomUUID());
  await assert.rejects(
    editReservation(r.id, { ...input, maxPlayers: 2 }, token),
  );
  await assert.rejects(
    editReservation(r.id, { ...input, hostName: "Mike" }, token),
  );
  assert.equal((await detail(r.id)).hostName, "Alex");
  assert.equal(
    (await editReservation(r.id, { ...input, maxPlayers: 4 }, token)).status,
    "OPEN",
  );
  await db.gameReservation.update({
    where: { id: r.id },
    data: { scheduledAt: new Date(0) },
  });
  await assert.rejects(
    editReservation(r.id, input, token),
    (e: unknown) => e instanceof AppError && e.code === "STARTED",
  );
  await db.gameReservation.update({
    where: { id: r.id },
    data: { hostTokenHash: null },
  });
  assert.equal((await detail(r.id, token)).isHost, false);
});
test("concurrent capacity reduction and join cannot overfill", async () => {
  const token = randomUUID();
  const input = data();
  const r = await createReservation(input, token);
  ids.push(r.id);
  await joinReservation(r.id, { name: "Mike" }, randomUUID());
  const results = await Promise.allSettled([
    editReservation(r.id, { ...input, maxPlayers: 2 }, token),
    joinReservation(r.id, { name: "Jack" }, randomUUID()),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const final = await detail(r.id);
  assert.ok(final.participants.length <= final.maxPlayers);
});
