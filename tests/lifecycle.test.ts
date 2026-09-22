import "./support/isolated";
import { listDeletedReservations } from "../server/reservation-trash";
import { listReservations } from "../server/reservation-list";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "../server/db";
import {
  createReservation,
  detail,
  joinReservation,
  leaveReservation,
  editReservation,
  cancelReservation,
  deleteReservation,
  restoreReservation,
  purgeReservation,
  AppError,
} from "../server/reservations";
const actor = { id: 2, username: "test_service_admin" };
const ids: string[] = [];
const input = () => ({
  gameName: "生命周期测试",
  hostName: "Alex",
  maxPlayers: 3,
  scheduledAt: new Date(Date.now() + 3600000).toISOString(),
  description: "",
});
const code = (expected: string) => (e: unknown) =>
  e instanceof AppError && e.code === expected;
async function create() {
  const token = randomUUID();
  const r = await createReservation(input(), token);
  ids.push(r.id);
  return { r, token };
}
after(async () => {
  await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});
test("cancellation authorizes owner/admin, validates reason and freezes original roster", async () => {
  const { r, token } = await create();
  await assert.rejects(
    cancelReservation(r.id, { reason: "取消" }, "stranger"),
    code("FORBIDDEN"),
  );
  for (const reason of [" ", "a".repeat(301)])
    await assert.rejects(cancelReservation(r.id, { reason }, token));
  const cancelled = await cancelReservation(
    r.id,
    { reason: "  临时有事  " },
    token,
  );
  assert.equal(cancelled.status, "CANCELLED");
  assert.equal(cancelled.cancellationReason, "临时有事");
  assert.deepEqual(cancelled.participants, r.participants);
  await assert.rejects(
    joinReservation(r.id, { name: "Guest" }, randomUUID()),
    code("CANCELLED"),
  );
  await assert.rejects(leaveReservation(r.id, token), code("CANCELLED"));
  await assert.rejects(
    editReservation(r.id, input(), token, actor),
    code("CANCELLED"),
  );
  const another = await create();
  assert.equal(
    (
      await cancelReservation(
        another.r.id,
        { reason: "管理员取消" },
        "admin",
        actor,
      )
    ).status,
    "CANCELLED",
  );
});
test("recycle bin hides every public operation, restore preserves identity/order/cancellation, purge cascades", async () => {
  const { r, token } = await create();
  await joinReservation(r.id, { name: "Guest" }, randomUUID());
  const cancelled = await cancelReservation(
    r.id,
    { reason: "择日再约" },
    token,
  );
  await assert.rejects(purgeReservation(r.id, actor), code("NOT_DELETED"));
  await deleteReservation(r.id, actor);
  assert.equal(
    (await listReservations()).items.some((row) => row.id === r.id),
    false,
  );
  assert.equal(
    (await listDeletedReservations({ q: r.id })).items.find(
      (row) => row.id === r.id,
    )?.participantCount,
    2,
  );
  await assert.rejects(detail(r.id), code("NOT_FOUND"));
  await assert.rejects(
    joinReservation(r.id, { name: "Later" }, randomUUID()),
    code("NOT_FOUND"),
  );
  await assert.rejects(leaveReservation(r.id, token), code("NOT_FOUND"));
  await assert.rejects(
    editReservation(r.id, input(), token, actor),
    code("NOT_FOUND"),
  );
  await assert.rejects(
    cancelReservation(r.id, { reason: "again" }, token),
    code("NOT_FOUND"),
  );
  await restoreReservation(r.id, actor);
  assert.deepEqual(await detail(r.id, token), cancelled);
  await assert.rejects(restoreReservation(r.id, actor), code("NOT_DELETED"));
  await deleteReservation(r.id, actor);
  await purgeReservation(r.id, actor);
  assert.equal(await db.gameReservation.count({ where: { id: r.id } }), 0);
  assert.equal(
    await db.participant.count({ where: { reservationId: r.id } }),
    0,
  );
});
test("restoring an expired reservation does not reopen registration", async () => {
  const { r } = await create();
  await deleteReservation(r.id, actor);
  await db.gameReservation.update({
    where: { id: r.id },
    data: { scheduledAt: new Date(0) },
  });
  await restoreReservation(r.id, actor);
  assert.equal((await detail(r.id)).status, "STARTED");
  await assert.rejects(
    cancelReservation(r.id, { reason: "late" }, "admin", actor),
    code("STARTED"),
  );
  await assert.rejects(
    joinReservation(r.id, { name: "Late" }, randomUUID()),
    code("STARTED"),
  );
});
test("concurrent cancellation and deletion retain consistent rosters and never allow later joins", async () => {
  for (const action of ["cancel", "delete"]) {
    const { r, token } = await create();
    const results = await Promise.allSettled([
      action === "cancel"
        ? cancelReservation(r.id, { reason: "取消" }, token)
        : deleteReservation(r.id, actor),
      ...Array.from({ length: 5 }, (_, i) =>
        joinReservation(r.id, { name: "Race" + i }, randomUUID()),
      ),
    ]);
    assert.equal(results[0].status, "fulfilled");
    const row = await db.gameReservation.findUniqueOrThrow({
      where: { id: r.id },
      include: { participants: true },
    });
    assert.ok(row.participants.length <= row.maxPlayers);
    assert.ok(action === "cancel" ? row.status === "CANCELLED" : row.deletedAt);
    await assert.rejects(
      joinReservation(r.id, { name: "Late" }, randomUUID()),
      code(action === "cancel" ? "CANCELLED" : "NOT_FOUND"),
    );
  }
});
