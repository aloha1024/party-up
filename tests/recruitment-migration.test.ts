import "./support/isolated";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createSnapshot, restoreSnapshot } from "../scripts/backup-data.mjs";
test("recruitment migration preserves old rows and old backups; new configuration and history survive restore", () => {
  const root = mkdtempSync(join(tmpdir(), "party-recruitment-migration-")),
    data = join(root, "data"),
    backups = join(root, "backups"),
    env = join(root, ".env");
  mkdirSync(data);
  writeFileSync(env, "APP_PORT=3001\n");
  const open = () => new DatabaseSync(join(data, "reservations.db"));
  const migration = "20260930000100_recruitment";
  const sql = readFileSync(
    `prisma/migrations/${migration}/migration.sql`,
    "utf8",
  );
  try {
    let db = open();
    for (const name of readdirSync("prisma/migrations")
      .filter((n) => /^\d/.test(n) && n < migration)
      .sort())
      db.exec(readFileSync(`prisma/migrations/${name}/migration.sql`, "utf8"));
    db.exec(`CREATE TABLE _prisma_migrations(migration_name TEXT,checksum TEXT,finished_at TEXT,rolled_back_at TEXT);
      INSERT INTO GameReservation(id,gameName,hostName,hostTokenHash,scheduledAt,maxPlayers,updatedAt) VALUES('legacy','Game','Host','owner',2000000000000,3,CURRENT_TIMESTAMP);
      INSERT INTO Participant(id,reservationId,name,nameKey,tokenHash) VALUES('member','legacy','Host','host','owner');`);
    const original = { ...db.prepare("SELECT * FROM GameReservation").get() };
    const member = db.prepare("SELECT * FROM Participant").get();
    db.close();
    const old = createSnapshot(data, backups, env);
    db = open();
    db.exec(sql);
    assert.deepEqual(
      { ...db.prepare("SELECT * FROM GameReservation").get() },
      { ...original, registrationDeadline: null, recruitmentPaused: 0 },
    );
    assert.deepEqual(db.prepare("SELECT * FROM Participant").get(), member);
    db.prepare(
      "INSERT INTO _prisma_migrations VALUES(?,?,'2026-09-30',NULL)",
    ).run(migration, createHash("sha256").update(sql).digest("hex"));
    db.exec(`UPDATE GameReservation SET registrationDeadline=1900000000000,recruitmentPaused=1;
      INSERT INTO ReservationChange(reservationId,action,actorRole,fields,registrationDeadlineBefore,registrationDeadlineAfter) VALUES('legacy','EDIT','HOST','["registrationDeadline"]',NULL,1900000000000);`);
    const before = db.prepare("SELECT * FROM GameReservation").get(),
      history = db.prepare("SELECT * FROM ReservationChange").get();
    db.close();
    const snapshot = createSnapshot(data, backups, env);
    db = open();
    db.exec(
      "UPDATE GameReservation SET registrationDeadline=NULL,recruitmentPaused=0; DELETE FROM ReservationChange;",
    );
    db.close();
    restoreSnapshot(snapshot, data);
    db = open();
    assert.deepEqual(db.prepare("SELECT * FROM GameReservation").get(), before);
    assert.deepEqual(
      db.prepare("SELECT * FROM ReservationChange").get(),
      history,
    );
    db.close();
    for (const [table, column] of [
      ["GameReservation", "registrationDeadline"],
      ["GameReservation", "recruitmentPaused"],
      ["ReservationChange", "registrationDeadlineBefore"],
      ["ReservationChange", "registrationDeadlineAfter"],
    ]) {
      restoreSnapshot(snapshot, data);
      db = open();
      db.exec(`ALTER TABLE "${table}" DROP COLUMN "${column}"`);
      db.close();
      assert.throws(() => createSnapshot(data, backups, env), /招募管理字段/);
    }
    restoreSnapshot(old, data);
    db = open();
    assert.deepEqual(
      { ...db.prepare("SELECT * FROM GameReservation").get() },
      original,
    );
    db.exec(sql);
    assert.equal(
      db.prepare("SELECT recruitmentPaused FROM GameReservation").get()!
        .recruitmentPaused,
      0,
    );
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
