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

test("notification migration preserves old reservations and backups; recipient events and read state survive restore", () => {
  const root = mkdtempSync(join(tmpdir(), "party-notifications-migration-")),
    data = join(root, "data"),
    backups = join(root, "backups"),
    env = join(root, ".env");
  const migration = "20261008000200_notifications";
  const sql = readFileSync(
    `prisma/migrations/${migration}/migration.sql`,
    "utf8",
  );
  const withDatabase = <T>(run: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(join(data, "reservations.db"));
    try {
      return run(db);
    } finally {
      db.close();
    }
  };
  const legacyRows = (db: DatabaseSync) =>
    ["GameReservation", "Participant", "WaitlistEntry", "CreationRequest"].map(
      (table) => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
    );
  const notifications = (db: DatabaseSync) =>
    db.prepare("SELECT * FROM Notification ORDER BY id").all();
  try {
    mkdirSync(data);
    writeFileSync(env, "APP_PORT=3001\n");
    const original = withDatabase((db) => {
      db.exec(
        "CREATE TABLE _prisma_migrations(migration_name TEXT,checksum TEXT,finished_at TEXT,rolled_back_at TEXT)",
      );
      for (const name of readdirSync("prisma/migrations")
        .filter((name) => /^\d/.test(name) && name < migration)
        .sort()) {
        const source = readFileSync(
          `prisma/migrations/${name}/migration.sql`,
          "utf8",
        );
        db.exec(source);
        db.prepare(
          "INSERT INTO _prisma_migrations VALUES(?,?,'2026-10-08',NULL)",
        ).run(name, createHash("sha256").update(source).digest("hex"));
      }
      db.exec(`
        INSERT INTO GameReservation(id,gameName,hostName,hostTokenHash,scheduledAt,maxPlayers,updatedAt,platform,gameServer,meetingCipher,meetingVersion)
          VALUES('legacy','原有预约','队长','owner',2000000000000,3,1900000000000,'PC','亚服','preserved-meeting-cipher',5);
        INSERT INTO Participant(id,reservationId,name,nameKey,tokenHash)
          VALUES('participant','legacy','隊友','隊友','member');
        INSERT INTO WaitlistEntry(reservationId,name,nameKey,tokenHash)
          VALUES('legacy','候补队友','候补队友','waiting');
        INSERT INTO CreationRequest(id,ownerTokenHash,key,inputHash,reservationId)
          VALUES('request','owner','request-key','input-hash','legacy');
      `);
      return legacyRows(db);
    });
    const old = createSnapshot(data, backups, env);
    assert.equal(verifySnapshot(old).version, 2);
    withDatabase((db) => {
      db.exec(sql);
      assert.deepEqual(legacyRows(db), original);
      assert.deepEqual(notifications(db), []);
      db.prepare(
        "INSERT INTO _prisma_migrations VALUES(?,?,'2026-10-08',NULL)",
      ).run(migration, createHash("sha256").update(sql).digest("hex"));
      const insert = db.prepare(
        "INSERT INTO Notification(reservationId,recipientHash,eventKey,kind,createdAt,readAt) VALUES(?,?,?,?,?,?)",
      );
      insert.run(
        "legacy",
        "member",
        "reschedule-event",
        "RESCHEDULED",
        1900000000000,
        null,
      );
      insert.run(
        "legacy",
        "waiting",
        "reschedule-event",
        "RESCHEDULED",
        1900000000000,
        1900000001000,
      );
      insert.run(
        "legacy",
        "member",
        "meeting-event",
        "MEETING_UPDATED",
        1900000002000,
        1900000003000,
      );
      assert.throws(
        () =>
          insert.run(
            "legacy",
            "member",
            "reschedule-event",
            "RESCHEDULED",
            1900000004000,
            null,
          ),
        /UNIQUE constraint failed/,
      );
    });
    const before = withDatabase(notifications);
    const snapshot = createSnapshot(data, backups, env);
    const manifest = verifySnapshot(snapshot);
    assert.ok(
      manifest.migrations.some(
        (row: { name: string }) => row.name === migration,
      ),
    );
    withDatabase((db) => {
      db.exec(
        "UPDATE Notification SET readAt=1900000005000; DELETE FROM Notification WHERE recipientHash='waiting'",
      );
    });
    restoreSnapshot(snapshot, data);
    withDatabase((db) => {
      assert.deepEqual(notifications(db), before);
      assert.deepEqual(legacyRows(db), original);
      db.exec(
        "PRAGMA foreign_keys=ON; DELETE FROM GameReservation WHERE id='legacy'",
      );
      assert.deepEqual(notifications(db), []);
    });
    restoreSnapshot(snapshot, data);
    withDatabase((db) => db.exec("DROP TABLE Notification"));
    assert.throws(() => createSnapshot(data, backups, env), /提醒数据表/);
    const columns = [
      "id",
      "reservationId",
      "recipientHash",
      "eventKey",
      "kind",
      "createdAt",
      "readAt",
    ];
    for (const missing of columns) {
      restoreSnapshot(snapshot, data);
      withDatabase((db) => {
        const retained = columns
          .filter((column) => column !== missing)
          .map((column) => `"${column}"`)
          .join(",");
        // Rebuild the damaged table so primary-key, unique and foreign-key
        // constraints do not prevent testing each required field independently.
        db.exec(`
          CREATE TABLE BrokenNotification AS SELECT ${retained} FROM Notification;
          DROP TABLE Notification;
          ALTER TABLE BrokenNotification RENAME TO Notification;
        `);
      });
      assert.throws(() => createSnapshot(data, backups, env), /提醒字段/);
    }

    restoreSnapshot(old, data);
    withDatabase((db) => {
      assert.deepEqual(legacyRows(db), original);
      assert.equal(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='Notification'",
          )
          .get(),
        undefined,
      );
      db.exec(sql);
      assert.deepEqual(notifications(db), []);
      assert.deepEqual(legacyRows(db), original);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
