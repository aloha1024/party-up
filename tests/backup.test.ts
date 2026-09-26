import {
  newInvitation,
  decryptInvitation,
} from "../server/invitation-credential";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSnapshot,
  verifySnapshot,
  restoreSnapshot,
  pruneSnapshots,
} from "../scripts/backup-data.mjs";
test("private roster removal backup round trip and migration-aware table checks", () => {
  const root = mkdtempSync(join(tmpdir(), "party-roster-backup-"));
  const data = join(root, "data"),
    backups = join(root, "backups"),
    env = join(root, ".env");
  mkdirSync(data);
  writeFileSync(env, "APP_PORT=3001\n");
  const open = () => new DatabaseSync(join(data, "reservations.db"));
  try {
    const db = open();
    for (const name of readdirSync("prisma/migrations")
      .filter((n) => /^\d/.test(n))
      .sort())
      db.exec(readFileSync(`prisma/migrations/${name}/migration.sql`, "utf8"));
    db.exec(`CREATE TABLE _prisma_migrations (migration_name TEXT, checksum TEXT, finished_at TEXT, rolled_back_at TEXT);
      INSERT INTO _prisma_migrations VALUES ('20260926000300_roster_management','${"c".repeat(64)}','2026-09-26',NULL);
      INSERT INTO GameReservation(id,gameName,hostName,scheduledAt,maxPlayers,updatedAt) VALUES ('r','Game','Host',2000000000000,2,CURRENT_TIMESTAMP);
      INSERT INTO RosterRemoval(reservationId,kind,entryId,targetTokenHash,targetName,reason,actorRole) VALUES ('r','participants','old','hash','Removed','Private reason','ADMIN');`);
    const before = db.prepare("SELECT * FROM RosterRemoval").all();
    db.close();
    const snapshot = createSnapshot(data, backups, env);
    const changed = open();
    changed.exec("DELETE FROM RosterRemoval");
    changed.close();
    restoreSnapshot(snapshot, data);
    const restored = open();
    assert.deepEqual(
      restored.prepare("SELECT * FROM RosterRemoval").all(),
      before,
    );
    restored.exec("DROP TABLE RosterRemoval");
    restored.close();
    assert.throws(
      () => createSnapshot(data, backups, env),
      /缺少报名移除记录表/,
    );
    const legacy = open();
    legacy.exec("DELETE FROM _prisma_migrations");
    legacy.close();
    assert.equal(verifySnapshot(createSnapshot(data, backups, env)).version, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("history backup restores events and conditionally requires the migrated table", () => {
  const root = mkdtempSync(join(tmpdir(), "party-history-backup-"));
  const data = join(root, "data"),
    backups = join(root, "backups"),
    env = join(root, ".env");
  mkdirSync(data);
  writeFileSync(env, "APP_PORT=3001\n");
  const open = () => new DatabaseSync(join(data, "reservations.db"));
  try {
    const db = open();
    for (const name of readdirSync("prisma/migrations")
      .filter((n) => /^\d/.test(n))
      .sort())
      db.exec(readFileSync(`prisma/migrations/${name}/migration.sql`, "utf8"));
    db.exec(`CREATE TABLE _prisma_migrations (migration_name TEXT, checksum TEXT, finished_at TEXT, rolled_back_at TEXT);
      INSERT INTO _prisma_migrations VALUES ('20260926000200_reservation_history','${"b".repeat(64)}','2026-09-26',NULL);
      INSERT INTO GameReservation(id,gameName,hostName,scheduledAt,maxPlayers,updatedAt) VALUES ('r','Game','Host',2000000000000,3,CURRENT_TIMESTAMP);
      INSERT INTO ReservationChange(reservationId,action,actorRole,fields,maxPlayersBefore,maxPlayersAfter) VALUES ('r','EDIT','HOST','["maxPlayers"]',2,3),('r','CANCEL','ADMIN','[]',NULL,NULL);`);
    const before = db
      .prepare("SELECT * FROM ReservationChange ORDER BY id")
      .all();
    db.close();
    const snapshot = createSnapshot(data, backups, env);
    const changed = open();
    changed.exec("DELETE FROM ReservationChange");
    changed.close();
    restoreSnapshot(snapshot, data);
    const restored = open();
    assert.deepEqual(
      restored.prepare("SELECT * FROM ReservationChange ORDER BY id").all(),
      before,
    );
    restored.exec("DROP TABLE ReservationChange");
    restored.close();
    assert.throws(
      () => createSnapshot(data, backups, env),
      /缺少预约变更记录表/,
    );
    const legacy = open();
    legacy.exec("DELETE FROM _prisma_migrations");
    legacy.close();
    assert.equal(verifySnapshot(createSnapshot(data, backups, env)).version, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("backup round trip preserves data and config; checksum failures never overwrite current data", () => {
  const root = mkdtempSync(join(tmpdir(), "party-backup-test-"));
  const data = join(root, "data"),
    backups = join(root, "backups"),
    env = join(root, ".env");
  mkdirSync(data);
  writeFileSync(env, "APP_PORT=3001\n");
  const config = {
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD_HASH: "scrypt:" + "a".repeat(32) + ":" + "b".repeat(128),
    ADMIN_SESSION_SECRET: "s".repeat(32),
  };
  writeFileSync(join(data, "admin-bootstrap.json"), JSON.stringify(config));
  function open() {
    return new DatabaseSync(join(data, "reservations.db"));
  }
  try {
    const db = open();
    db.exec(
      "CREATE TABLE GameReservation (id TEXT PRIMARY KEY, name TEXT); CREATE TABLE Participant (id TEXT); CREATE TABLE AdminCredential (id INTEGER); CREATE TABLE _prisma_migrations (id TEXT, migration_name TEXT, checksum TEXT, finished_at TEXT, rolled_back_at TEXT); INSERT INTO GameReservation VALUES ('one', '原始预约');",
    );
    db.prepare("INSERT INTO _prisma_migrations VALUES (?, ?, ?, ?, ?)").run(
      "applied",
      "20260923000100_example",
      "c".repeat(64),
      "2026-09-23T00:00:00Z",
      null,
    );
    db.prepare("INSERT INTO _prisma_migrations VALUES (?, ?, ?, ?, ?)").run(
      "failed",
      "20260923000200_failed",
      "d".repeat(64),
      null,
      null,
    );
    db.prepare("INSERT INTO _prisma_migrations VALUES (?, ?, ?, ?, ?)").run(
      "rolled-back",
      "20260923000300_rolled_back",
      "e".repeat(64),
      "2026-09-23T01:00:00Z",
      "2026-09-23T02:00:00Z",
    );
    db.close();
    const snapshot = createSnapshot(data, backups, env);
    const originalManifest = verifySnapshot(snapshot);
    assert.equal(originalManifest.version, 2);
    assert.equal(originalManifest.application.version, "1.0.0");
    assert.ok(originalManifest.application.node.startsWith("v"));
    assert.equal(originalManifest.application.prisma, "6.19.0");
    assert.deepEqual(originalManifest.migrations, [
      {
        name: "20260923000100_example",
        checksum: "c".repeat(64),
        finishedAt: "2026-09-23T00:00:00Z",
      },
    ]);
    const manifestPath = join(snapshot, "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({ ...originalManifest, migrations: [] }),
    );
    assert.throws(() => verifySnapshot(snapshot), /迁移信息无效/);
    // Existing version-one snapshots remain restorable.
    const legacyManifest = { ...originalManifest, version: 1 };
    delete legacyManifest.application;
    delete legacyManifest.migrations;
    writeFileSync(manifestPath, JSON.stringify(legacyManifest));
    assert.equal(verifySnapshot(snapshot).version, 1);
    assert.equal(
      readFileSync(join(snapshot, "server.env"), "utf8"),
      "APP_PORT=3001\n",
    );
    const changed = open();
    changed.exec("UPDATE GameReservation SET name='changed'");
    changed.close();
    const recovery = createSnapshot(data, backups, env, "pre-restore");
    restoreSnapshot(snapshot, data);
    const restored = open();
    assert.equal(
      restored.prepare("SELECT name FROM GameReservation").get()!.name,
      "原始预约",
    );
    restored.close();
    assert.deepEqual(
      JSON.parse(readFileSync(join(data, "admin-bootstrap.json"), "utf8")),
      config,
    );
    const second = createSnapshot(data, backups, env);
    pruneSnapshots(backups, 1);
    assert.equal(existsSync(second), true);
    assert.equal(existsSync(recovery), true);
    assert.equal(existsSync(snapshot), false);
    writeFileSync(join(second, "server.env"), "tampered");
    assert.throws(() => restoreSnapshot(second, data), /校验失败/);
    const preserved = open();
    assert.equal(
      preserved.prepare("SELECT name FROM GameReservation").get()!.name,
      "原始预约",
    );
    preserved.close();
    const manifest = JSON.parse(
      readFileSync(join(recovery, "manifest.json"), "utf8"),
    );
    manifest.files["../outside"] = "a".repeat(64);
    writeFileSync(join(recovery, "manifest.json"), JSON.stringify(manifest));
    assert.throws(() => verifySnapshot(recovery), /无效/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("waitlist backups restore queue data; completed migration requires its table", () => {
  const root = mkdtempSync(join(tmpdir(), "party-waitlist-backup-"));
  const data = join(root, "data"),
    backups = join(root, "backups"),
    env = join(root, ".env");
  mkdirSync(data);
  writeFileSync(env, "APP_PORT=3001\n");
  const open = () => new DatabaseSync(join(data, "reservations.db"));
  try {
    const db = open();
    for (const name of readdirSync("prisma/migrations")
      .filter((name) => /^\d/.test(name))
      .sort())
      db.exec(readFileSync(`prisma/migrations/${name}/migration.sql`, "utf8"));
    db.exec(`CREATE TABLE _prisma_migrations (migration_name TEXT, checksum TEXT, finished_at TEXT, rolled_back_at TEXT);
      INSERT INTO _prisma_migrations VALUES ('20260926000100_waitlist', '${"a".repeat(64)}', '2026-09-26', NULL);
      INSERT INTO GameReservation (id,gameName,hostName,scheduledAt,maxPlayers,updatedAt) VALUES ('r','Game','Host',2000000000000,2,CURRENT_TIMESTAMP);
      INSERT INTO WaitlistEntry (reservationId,name,nameKey,tokenHash) VALUES ('r','First','first','hash1'),('r','Second','second','hash2');`);
    const before = db.prepare("SELECT * FROM WaitlistEntry ORDER BY id").all();
    db.close();
    const snapshot = createSnapshot(data, backups, env);
    assert.equal(verifySnapshot(snapshot).version, 2);
    const changed = open();
    changed.exec("DELETE FROM WaitlistEntry");
    changed.close();
    restoreSnapshot(snapshot, data);
    const restored = open();
    assert.deepEqual(
      restored.prepare("SELECT * FROM WaitlistEntry ORDER BY id").all(),
      before,
    );
    restored.exec("DROP TABLE WaitlistEntry");
    restored.close();
    assert.throws(() => createSnapshot(data, backups, env), /缺少候补数据表/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invitation backup preserves encrypted credentials, grants and matching server key; old snapshots remain accepted", () => {
  const root = mkdtempSync(join(tmpdir(), "party-invite-backup-"));
  const data = join(root, "data"),
    backups = join(root, "backups"),
    env = join(root, ".env");
  mkdirSync(data);
  writeFileSync(
    env,
    "ADMIN_SESSION_SECRET=" + process.env.ADMIN_SESSION_SECRET + "\n",
  );
  const open = () => new DatabaseSync(join(data, "reservations.db"));
  try {
    const db = open();
    const migrations = readdirSync("prisma/migrations")
      .filter((name) => /^\d/.test(name))
      .sort();
    for (const name of migrations)
      db.exec(readFileSync(`prisma/migrations/${name}/migration.sql`, "utf8"));
    db.exec(`CREATE TABLE _prisma_migrations (migration_name TEXT, checksum TEXT, finished_at TEXT, rolled_back_at TEXT);
  INSERT INTO _prisma_migrations VALUES ('20260926000400_invitations','${"a".repeat(64)}','2026-09-26',NULL);
  INSERT INTO GameReservation(id,gameName,hostName,scheduledAt,maxPlayers,updatedAt,visibility,inviteVersion,inviteHash,inviteCipher) VALUES ('invite','Private','Host',2000000000000,2,CURRENT_TIMESTAMP,'INVITE',3,'digest','encrypted-credential');
  INSERT INTO ReservationAccess(reservationId,tokenHash,inviteVersion,hasJoined) VALUES ('invite','member',2,1),('invite','visitor',3,0);`);
    const credential = newInvitation();
    const plaintext = decryptInvitation(credential.inviteCipher);
    db.prepare("UPDATE GameReservation SET inviteHash=?,inviteCipher=?").run(
      credential.inviteHash,
      credential.inviteCipher,
    );
    const original = db.prepare("SELECT * FROM GameReservation").all(),
      grants = db.prepare("SELECT * FROM ReservationAccess ORDER BY id").all();
    db.close();
    const snapshot = createSnapshot(data, backups, env);
    verifySnapshot(snapshot);
    const changed = open();
    changed.exec(
      "DELETE FROM ReservationAccess; UPDATE GameReservation SET inviteVersion=4, inviteCipher='other'",
    );
    changed.close();
    restoreSnapshot(snapshot, data);
    const restored = open();
    assert.deepEqual(
      restored.prepare("SELECT * FROM GameReservation").all(),
      original,
    );
    assert.deepEqual(
      restored.prepare("SELECT * FROM ReservationAccess ORDER BY id").all(),
      grants,
    );
    assert.equal(
      readFileSync(join(snapshot, "server.env"), "utf8"),
      readFileSync(env, "utf8"),
    );
    assert.equal(
      decryptInvitation(
        String(
          restored.prepare("SELECT inviteCipher FROM GameReservation").get()!
            .inviteCipher,
        ),
      ),
      plaintext,
    );
    restored.exec("DROP TABLE ReservationAccess");
    restored.close();
    assert.throws(() => createSnapshot(data, backups, env), /缺少邀请授权表/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("attendance and completion backup round trip checks fields only after its migration", () => {
  const root = mkdtempSync(join(tmpdir(), "party-attendance-backup-")),
    data = join(root, "data"),
    backups = join(root, "backups"),
    env = join(root, ".env");
  mkdirSync(data);
  writeFileSync(env, "APP_PORT=3001\n");
  const open = () => new DatabaseSync(join(data, "reservations.db"));
  try {
    const db = open();
    for (const name of readdirSync("prisma/migrations")
      .filter((name) => /^\d/.test(name))
      .sort())
      db.exec(readFileSync(`prisma/migrations/${name}/migration.sql`, "utf8"));
    db.exec(`CREATE TABLE _prisma_migrations (migration_name TEXT, checksum TEXT, finished_at TEXT, rolled_back_at TEXT);
  INSERT INTO _prisma_migrations VALUES ('20260926000500_attendance_completion','${"a".repeat(64)}','2026-09-26',NULL);
  INSERT INTO GameReservation(id,gameName,hostName,scheduledAt,maxPlayers,updatedAt,status,endedAt) VALUES ('r','Game','Host',2000000000000,2,CURRENT_TIMESTAMP,'ENDED',2000000001000);
  INSERT INTO Participant(id,reservationId,name,nameKey,tokenHash,checkedInAt,attendanceVersion) VALUES ('p','r','Host','host','host',2000000000000,3);`);
    const reservation = db.prepare("SELECT * FROM GameReservation").all(),
      roster = db.prepare("SELECT * FROM Participant").all();
    db.close();
    const snapshot = createSnapshot(data, backups, env);
    verifySnapshot(snapshot);
    const changed = open();
    changed.exec(
      "UPDATE GameReservation SET status='OPEN',endedAt=NULL; UPDATE Participant SET checkedInAt=NULL,attendanceVersion=4",
    );
    changed.close();
    restoreSnapshot(snapshot, data);
    const restored = open();
    assert.deepEqual(
      restored.prepare("SELECT * FROM GameReservation").all(),
      reservation,
    );
    assert.deepEqual(
      restored.prepare("SELECT * FROM Participant").all(),
      roster,
    );
    restored.exec("ALTER TABLE Participant DROP COLUMN checkedInAt");
    restored.close();
    assert.throws(
      () => createSnapshot(data, backups, env),
      /缺少到场或结束状态字段/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
