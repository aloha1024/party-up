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
import {
  createSnapshot,
  restoreSnapshot,
  verifySnapshot,
} from "../scripts/backup-data.mjs";

test("schedule confirmation migration keeps legacy memberships confirmed and restores generations, responses and waitlist acceptance without changing old backups", () => {
  const root = mkdtempSync(
      join(tmpdir(), "party-schedule-confirmation-migration-"),
    ),
    data = join(root, "data"),
    backups = join(root, "backups"),
    env = join(root, ".env");
  const migration = "20261008000600_schedule_confirmation",
    sql = readFileSync(`prisma/migrations/${migration}/migration.sql`, "utf8");
  const withDatabase = <T>(run: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(join(data, "reservations.db"));
    try {
      db.exec("PRAGMA foreign_keys=ON");
      return run(db);
    } finally {
      db.close();
    }
  };
  const apply = (db: DatabaseSync, name: string, source: string) => {
    db.exec(source);
    db.prepare(
      "INSERT INTO _prisma_migrations VALUES(?,?,'2026-10-08',NULL)",
    ).run(name, createHash("sha256").update(source).digest("hex"));
  };
  const tables = [
    "User",
    "GameReservation",
    "Participant",
    "WaitlistEntry",
    "UserReservationFavorite",
    "ReservationChange",
  ];
  const rows = (db: DatabaseSync) =>
    Object.fromEntries(
      tables.map((table) => [
        table,
        db
          .prepare(`SELECT * FROM "${table}" ORDER BY 1`)
          .all()
          .map((r) => ({ ...r })),
      ]),
    );
  try {
    mkdirSync(data);
    writeFileSync(env, "APP_PORT=3001\n");
    const original = withDatabase((db) => {
      db.exec(
        "CREATE TABLE _prisma_migrations(migration_name TEXT,checksum TEXT,finished_at TEXT,rolled_back_at TEXT)",
      );
      for (const name of readdirSync("prisma/migrations")
        .filter((name) => /^\d/.test(name) && name < migration)
        .sort())
        apply(
          db,
          name,
          readFileSync(`prisma/migrations/${name}/migration.sql`, "utf8"),
        );
      db.exec(`
        INSERT INTO User(id,username,nickname,passwordHash,identityKey) VALUES('account','schedule_owner','Host','unused','owner-key');
        INSERT INTO GameReservation(id,gameName,hostName,hostTokenHash,scheduledAt,maxPlayers,updatedAt,status,editVersion) VALUES
          ('open','Open','Host','owner-hash',2000000000000,2,1900000000000,'OPEN',4),
          ('cancelled','Cancelled','Host','owner-hash',2000000000001,2,1900000000000,'CANCELLED',3),
          ('ended','Ended','Host','owner-hash',1800000000000,2,1900000000000,'ENDED',5);
        INSERT INTO Participant(id,reservationId,name,nameKey,tokenHash,checkedInAt,attendanceVersion,joinedAt) VALUES
          ('host','open','Host','host','owner-hash',1900000000000,2,1800000000000),
          ('member','open','Member','member','member-hash',NULL,0,1800000000001),
          ('cancelled-host','cancelled','Host','host','owner-hash',NULL,0,1800000000000),
          ('ended-host','ended','Host','host','owner-hash',1900000000000,1,1800000000000);
        INSERT INTO WaitlistEntry(reservationId,name,nameKey,tokenHash,joinedAt) VALUES('open','Waiting','waiting','waiter-hash',1800000000002);
        INSERT INTO UserReservationFavorite(userId,reservationId,createdAt) VALUES('account','open',1800000000003);
        INSERT INTO ReservationChange(reservationId,action,actorRole,fields,scheduledAtBefore,scheduledAtAfter) VALUES('open','EDIT','HOST','["scheduledAt"]',1900000000000,2000000000000);
      `);
      return rows(db);
    });
    const old = createSnapshot(data, backups, env);
    assert.equal(verifySnapshot(old).version, 2);
    withDatabase((db) => {
      apply(db, migration, sql);
      const expected = {
        ...original,
        GameReservation: original.GameReservation.map((r) => ({
          ...r,
          scheduleVersion: 0,
        })),
        Participant: original.Participant.map((r) => ({
          ...r,
          acceptedScheduleVersion: 0,
          scheduleConfirmedAt: null,
        })),
        WaitlistEntry: original.WaitlistEntry.map((r) => ({
          ...r,
          acceptedScheduleVersion: 0,
        })),
      };
      assert.deepEqual(rows(db), expected);
      db.exec(`UPDATE GameReservation SET scheduleVersion=3 WHERE id='open';
        UPDATE Participant SET acceptedScheduleVersion=3,scheduleConfirmedAt=1900000000100 WHERE id='host';
        UPDATE Participant SET acceptedScheduleVersion=2,scheduleConfirmedAt=1900000000090 WHERE id='member';
        UPDATE WaitlistEntry SET acceptedScheduleVersion=2;
      `);
    });
    const before = withDatabase(rows),
      snapshot = createSnapshot(data, backups, env);
    assert.ok(
      verifySnapshot(snapshot).migrations.some(
        (row: { name: string }) => row.name === migration,
      ),
    );
    withDatabase((db) =>
      db.exec(
        "UPDATE GameReservation SET scheduleVersion=0; UPDATE Participant SET acceptedScheduleVersion=0,scheduleConfirmedAt=NULL; DELETE FROM WaitlistEntry",
      ),
    );
    restoreSnapshot(snapshot, data);
    assert.deepEqual(withDatabase(rows), before);
    for (const [table, column] of [
      ["GameReservation", "scheduleVersion"],
      ["Participant", "acceptedScheduleVersion"],
      ["Participant", "scheduleConfirmedAt"],
      ["WaitlistEntry", "acceptedScheduleVersion"],
    ]) {
      restoreSnapshot(snapshot, data);
      withDatabase((db) =>
        db.exec(`ALTER TABLE "${table}" DROP COLUMN "${column}"`),
      );
      assert.throws(() => createSnapshot(data, backups, env), /改期确认字段/);
    }
    restoreSnapshot(snapshot, data);
    withDatabase((db) => {
      db.exec("DELETE FROM GameReservation WHERE id='open'");
      assert.equal(
        db
          .prepare(
            "SELECT COUNT(*) n FROM Participant WHERE reservationId='open'",
          )
          .get()!.n,
        0,
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) n FROM WaitlistEntry").get()!.n,
        0,
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) n FROM UserReservationFavorite").get()!.n,
        0,
      );
    });
    restoreSnapshot(old, data);
    withDatabase((db) => {
      assert.deepEqual(rows(db), original);
      apply(db, migration, sql);
      assert.ok(
        db
          .prepare("SELECT scheduleVersion FROM GameReservation")
          .all()
          .every((row) => row.scheduleVersion === 0),
      );
      assert.ok(
        db
          .prepare(
            "SELECT acceptedScheduleVersion,scheduleConfirmedAt FROM Participant",
          )
          .all()
          .every(
            (row) =>
              row.acceptedScheduleVersion === 0 &&
              row.scheduleConfirmedAt === null,
          ),
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
