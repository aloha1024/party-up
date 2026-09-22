import "./support/isolated";
import { after, test } from "node:test";
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
import { editSchema } from "../lib/validation";

const ids: string[] = [];
const actor = { id: 42, username: "edit_conflict_admin" };
async function fixture() {
  const owner = randomUUID();
  const input = {
    gameName: "Conflict test",
    hostName: "Host",
    description: "original",
    maxPlayers: 3,
    scheduledAt: new Date(Date.now() + 3600000).toISOString(),
  };
  const reservation = await createReservation(input, owner);
  ids.push(reservation.id);
  return { owner, input, reservation };
}
const conflict = (e: unknown) =>
  e instanceof AppError && e.status === 409 && e.code === "EDIT_CONFLICT";
after(async () => {
  await db.adminAuditLog.deleteMany({ where: { targetId: { in: ids } } });
  await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});

test("stale admin and host edits cannot overwrite newer changes; reloading the version allows a new save", async () => {
  const { owner, input, reservation: r } = await fixture();
  assert.equal(r.editVersion, 0);
  const updated = await editReservation(
    r.id,
    {
      ...input,
      editVersion: 0,
      description: "Host notes",
      hostName: "New host",
    },
    owner,
  );
  assert.equal(updated.editVersion, 1);
  const before = await db.gameReservation.findUniqueOrThrow({
    where: { id: r.id },
  });
  await assert.rejects(
    editReservation(
      r.id,
      { ...input, editVersion: 0, maxPlayers: 8 },
      "admin",
      actor,
    ),
    conflict,
  );
  assert.deepEqual(
    await db.gameReservation.findUniqueOrThrow({ where: { id: r.id } }),
    before,
  );
  assert.deepEqual(await detail(r.id, owner), updated);
  assert.equal(await db.adminAuditLog.count({ where: { targetId: r.id } }), 0);
  const latest = await detail(r.id);
  const saved = await editReservation(
    r.id,
    {
      ...input,
      description: latest.description,
      hostName: latest.hostName,
      maxPlayers: 8,
      editVersion: latest.editVersion,
    },
    "admin",
    actor,
  );
  assert.equal(saved.editVersion, 2);
  assert.equal(saved.description, "Host notes");
  assert.equal(saved.participants[0].name, "New host");
  await assert.rejects(
    editReservation(r.id, { ...input, editVersion: 1 }, owner),
    conflict,
  );
  assert.equal(
    await db.adminAuditLog.count({
      where: { targetId: r.id, action: "RESERVATION_EDIT" },
    }),
    1,
  );
});

test("simultaneous host and admin saves from one version commit exactly one edit", async () => {
  const { owner, input, reservation: r } = await fixture();
  const results = await Promise.allSettled([
    editReservation(
      r.id,
      { ...input, editVersion: 0, description: "Host wins" },
      owner,
    ),
    editReservation(
      r.id,
      { ...input, editVersion: 0, description: "Admin wins" },
      "admin",
      actor,
    ),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = results.find(
    (r) => r.status === "rejected",
  ) as PromiseRejectedResult;
  assert.ok(conflict(rejected.reason));
  const current = await detail(r.id);
  const row = await db.gameReservation.findUniqueOrThrow({
    where: { id: r.id },
  });
  assert.equal(current.editVersion, 1);
  assert.equal(row.revision, 1);
  assert.equal(
    current.description,
    results[0].status === "fulfilled" ? "Host wins" : "Admin wins",
  );
  assert.equal(
    await db.adminAuditLog.count({ where: { targetId: r.id } }),
    results[1].status === "fulfilled" ? 1 : 0,
  );
});

test("joining and leaving do not invalidate editor versions; live capacity and nickname checks still apply", async () => {
  const { owner, input, reservation: r } = await fixture();
  const guest = randomUUID();
  const joined = await joinReservation(r.id, { name: "Guest" }, guest);
  assert.equal(joined.editVersion, 0);
  await assert.rejects(
    editReservation(
      r.id,
      { ...input, editVersion: 0, hostName: "Guest" },
      owner,
    ),
    (e) => e instanceof AppError && e.code === "DUPLICATE",
  );
  assert.equal((await detail(r.id)).editVersion, 0);
  const saved = await editReservation(
    r.id,
    { ...input, editVersion: 0, description: "While guest joined" },
    owner,
  );
  assert.equal(saved.editVersion, 1);
  const left = await leaveReservation(r.id, guest);
  assert.equal(left.editVersion, 1);
  assert.equal(
    (await editReservation(r.id, { ...input, editVersion: 1 }, owner))
      .editVersion,
    2,
  );
});

test("failed audit writes roll back the edit version, reservation fields and host nickname", async () => {
  const { input, reservation: r } = await fixture();
  const trigger = "edit_fail_" + randomUUID().replaceAll("-", "");
  const before = await db.gameReservation.findUniqueOrThrow({
    where: { id: r.id },
  });
  await db.$executeRawUnsafe(
    `CREATE TRIGGER ${trigger} BEFORE INSERT ON AdminAuditLog WHEN NEW.targetId = '${r.id}' BEGIN SELECT RAISE(ABORT, 'simulated audit failure'); END`,
  );
  try {
    await assert.rejects(
      editReservation(
        r.id,
        {
          ...input,
          editVersion: 0,
          hostName: "Changed",
          description: "Changed",
        },
        "admin",
        actor,
      ),
    );
    assert.deepEqual(
      await db.gameReservation.findUniqueOrThrow({ where: { id: r.id } }),
      before,
    );
    assert.equal((await detail(r.id)).participants[0].name, "Host");
    assert.equal(
      await db.adminAuditLog.count({ where: { targetId: r.id } }),
      0,
    );
  } finally {
    await db.$executeRawUnsafe("DROP TRIGGER " + trigger);
  }
  assert.equal(
    (await editReservation(r.id, { ...input, editVersion: 0 }, "admin", actor))
      .editVersion,
    1,
  );
});

test("editing requires a bounded integer version and rejects missing or forged future versions", async () => {
  const { owner, input, reservation: r } = await fixture();
  for (const editVersion of [
    undefined,
    null,
    -1,
    0.5,
    "0",
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    const payload = { ...input, editVersion };
    assert.equal(editSchema.safeParse(payload).success, false);
    await assert.rejects(editReservation(r.id, payload, owner));
  }
  await assert.rejects(
    editReservation(r.id, { ...input, editVersion: 99 }, owner),
    conflict,
  );
  const current = await db.gameReservation.findUniqueOrThrow({
    where: { id: r.id },
  });
  assert.equal(current.editVersion, 0);
  assert.equal(current.revision, 0);
});
