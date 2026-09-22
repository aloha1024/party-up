import "./support/isolated";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "../server/db";
import {
  createReservation,
  editReservation,
  cancelReservation,
  deleteReservation,
  restoreReservation,
  purgeReservation,
} from "../server/reservations";
import { auditQuerySchema } from "../lib/admin-audit";
const ids: string[] = [];
const actor = {
  id: 42,
  username: "audit_service_admin",
  passwordHash: "never-store-this-hash",
};
const input = () => ({
  gameName: "Audit game",
  hostName: "Host",
  scheduledAt: new Date(Date.now() + 3600000).toISOString(),
  maxPlayers: 3,
  description: "private-notes-do-not-log",
  editVersion: 0,
});
async function create() {
  const token = randomUUID(),
    data = input();
  const row = await createReservation(data, token);
  ids.push(row.id);
  return { row, token, data };
}
after(async () => {
  await db.adminAuditLog.deleteMany({ where: { targetId: { in: ids } } });
  await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});
test("admin reservation actions retain actor/object snapshots after purge without storing secrets or owner-only actions", async () => {
  const { row, token, data } = await create();
  await editReservation(row.id, data, token);
  assert.equal(
    await db.adminAuditLog.count({ where: { targetId: row.id } }),
    0,
  );
  await assert.rejects(editReservation(row.id, data, "outsider"));
  assert.equal(
    await db.adminAuditLog.count({ where: { targetId: row.id } }),
    0,
  );
  await editReservation(
    row.id,
    { ...data, editVersion: 1, gameName: "Audit renamed" },
    "admin",
    actor,
  );
  await deleteReservation(row.id, actor);
  await restoreReservation(row.id, actor);
  await cancelReservation(
    row.id,
    { reason: "private-cancellation-notes" },
    "admin",
    actor,
  );
  await deleteReservation(row.id, actor);
  await purgeReservation(row.id, actor);
  const rows = await db.adminAuditLog.findMany({ where: { targetId: row.id } });
  assert.equal(rows.length, 6);
  assert.equal(rows.filter((r) => r.action === "RESERVATION_TRASH").length, 2);
  for (const action of [
    "RESERVATION_EDIT",
    "RESERVATION_RESTORE",
    "RESERVATION_CANCEL",
    "RESERVATION_PURGE",
  ])
    assert.equal(rows.filter((row) => row.action === action).length, 1);
  assert.ok(
    rows.every(
      (row) =>
        row.actorId === actor.id &&
        row.actorName === actor.username &&
        row.targetLabel === "Audit renamed",
    ),
  );
  assert.equal(await db.gameReservation.count({ where: { id: row.id } }), 0);
  const serialized = JSON.stringify(rows);
  for (const secret of [
    token,
    data.description,
    actor.passwordHash,
    "private-cancellation-notes",
  ])
    assert.equal(serialized.includes(secret), false);
});
test("a failed audit insert rolls back reservation deletion and revision; concurrent deletion records one success", async () => {
  const { row } = await create();
  const trigger = "audit_fail_" + randomUUID().replaceAll("-", "");
  await db.$executeRawUnsafe(
    `CREATE TRIGGER ${trigger} BEFORE INSERT ON AdminAuditLog WHEN NEW.targetId = '${row.id}' BEGIN SELECT RAISE(ABORT, 'simulated audit storage failure'); END`,
  );
  try {
    await assert.rejects(deleteReservation(row.id, actor));
    const current = await db.gameReservation.findUniqueOrThrow({
      where: { id: row.id },
    });
    assert.equal(current.deletedAt, null);
    assert.equal(current.revision, 0);
    assert.equal(
      await db.adminAuditLog.count({ where: { targetId: row.id } }),
      0,
    );
  } finally {
    await db.$executeRawUnsafe("DROP TRIGGER " + trigger);
  }
  const results = await Promise.allSettled([
    deleteReservation(row.id, actor),
    deleteReservation(row.id, actor),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    await db.adminAuditLog.count({
      where: { targetId: row.id, action: "RESERVATION_TRASH" },
    }),
    1,
  );
});
test("audit filters reject invalid actions, unbounded queries and repeated page parameters", () => {
  for (const input of [
    { action: "DELETE_ALL" },
    { q: "x".repeat(81) },
    { page: 0 },
    { page: ["1", "2"] },
  ])
    assert.equal(auditQuerySchema.safeParse(input).success, false);
});
