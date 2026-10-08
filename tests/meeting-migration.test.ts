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
import { createHash, randomBytes } from "node:crypto";
import {
  createSnapshot,
  restoreSnapshot,
  verifySnapshot,
} from "../scripts/backup-data.mjs";
import { decryptPrivate, encryptPrivate } from "../server/private-value";

test("meeting migration preserves legacy data and backups; encrypted meeting details survive restore with their server key", () => {
  const root = mkdtempSync(join(tmpdir(), "party-meeting-migration-")),
    data = join(root, "data"),
    backups = join(root, "backups"),
    env = join(root, ".env");
  const migration = "20261008000100_meeting";
  const sql = readFileSync(
    `prisma/migrations/${migration}/migration.sql`,
    "utf8",
  );
  const previousSecret = process.env.ADMIN_SESSION_SECRET;
  const secret = randomBytes(32).toString("hex");
  const withDatabase = <T>(run: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(join(data, "reservations.db"));
    try {
      return run(db);
    } finally {
      db.close();
    }
  };
  const reservations = (db: DatabaseSync) =>
    db.prepare("SELECT * FROM GameReservation ORDER BY id").all();
  const related = (db: DatabaseSync) =>
    [
      "Participant",
      "WaitlistEntry",
      "ReservationAccess",
      "ReservationChange",
      "CreationRequest",
    ].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
  const withDefaults = (rows: ReturnType<typeof reservations>) =>
    rows.map((row) => ({
      ...row,
      platform: "",
      gameServer: "",
      meetingCipher: null,
      meetingVersion: 0,
    }));
  try {
    mkdirSync(data);
    process.env.ADMIN_SESSION_SECRET = secret;
    writeFileSync(env, `ADMIN_SESSION_SECRET=${secret}\nAPP_PORT=3001\n`);
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
          "INSERT INTO _prisma_migrations VALUES(?,?,'2026-10-07',NULL)",
        ).run(name, createHash("sha256").update(source).digest("hex"));
      }
      db.exec(`
        INSERT INTO GameReservation(id,gameName,hostName,hostTokenHash,scheduledAt,maxPlayers,description,updatedAt,visibility,inviteVersion,inviteHash,inviteCipher,registrationDeadline,recruitmentPaused,editVersion,revision)
          VALUES('legacy','旧游戏','队长','owner',2000000000000,3,'旧备注',1900000000000,'INVITE',2,'invite-hash','existing-invite-cipher',1999990000000,1,4,8);
        INSERT INTO GameReservation(id,gameName,hostName,scheduledAt,maxPlayers,updatedAt,status,deletedAt,cancellationReason)
          VALUES('removed','已移除游戏','旧队长',1800000000000,2,1800000001000,'CANCELLED',1800000001000,'保留原因');
        INSERT INTO Participant(id,reservationId,name,nameKey,tokenHash,checkedInAt,attendanceVersion)
          VALUES('member','legacy','队长','队长','owner',1999999000000,3);
        INSERT INTO WaitlistEntry(reservationId,name,nameKey,tokenHash)
          VALUES('legacy','候补','候补','waiting');
        INSERT INTO ReservationAccess(reservationId,tokenHash,inviteVersion,hasJoined)
          VALUES('legacy','owner',1,1);
        INSERT INTO ReservationChange(reservationId,action,actorRole,fields,maxPlayersBefore,maxPlayersAfter)
          VALUES('legacy','EDIT','HOST','["maxPlayers"]',2,3);
        INSERT INTO CreationRequest(id,ownerTokenHash,key,inputHash,reservationId)
          VALUES('request','owner','request-key','input-hash','legacy');
      `);
      return { reservations: reservations(db), related: related(db) };
    });
    const old = createSnapshot(data, backups, env);
    assert.equal(verifySnapshot(old).version, 2);
    withDatabase((db) => {
      db.exec(sql);
      assert.deepEqual(
        reservations(db).map((row) => ({ ...row })),
        withDefaults(original.reservations),
      );
      assert.deepEqual(related(db), original.related);
      db.prepare(
        "INSERT INTO _prisma_migrations VALUES(?,?,'2026-10-08',NULL)",
      ).run(migration, createHash("sha256").update(sql).digest("hex"));
    });

    const meeting = {
      roomName: "migration-private-room-4821",
      roomPassword: "migration-private-password-7316",
      voice: "https://voice.example.test/private-room-9342",
    };
    const ciphertext = encryptPrivate(JSON.stringify(meeting), "meeting");
    const before = withDatabase((db) => {
      db.prepare(
        "UPDATE GameReservation SET platform=?,gameServer=?,meetingCipher=?,meetingVersion=? WHERE id='legacy'",
      ).run("PC", "亚服", ciphertext, 7);
      return reservations(db);
    });
    const snapshot = createSnapshot(data, backups, env);
    const manifest = verifySnapshot(snapshot);
    assert.ok(
      manifest.migrations.some(
        (row: { name: string }) => row.name === migration,
      ),
    );
    assert.equal(
      readFileSync(join(snapshot, "server.env"), "utf8"),
      readFileSync(env, "utf8"),
    );
    const snapshotBytes = readFileSync(join(snapshot, "reservations.db"));
    for (const value of Object.values(meeting))
      assert.equal(snapshotBytes.includes(Buffer.from(value)), false);
    withDatabase((db) => {
      db.exec(
        "UPDATE GameReservation SET platform='',gameServer='',meetingCipher=NULL,meetingVersion=8; DELETE FROM WaitlistEntry",
      );
    });
    restoreSnapshot(snapshot, data);
    withDatabase((db) => {
      assert.deepEqual(reservations(db), before);
      assert.deepEqual(related(db), original.related);
      const restored = String(
        db
          .prepare(
            "SELECT meetingCipher FROM GameReservation WHERE id='legacy'",
          )
          .get()!.meetingCipher,
      );
      assert.equal(restored, ciphertext);
      process.env.ADMIN_SESSION_SECRET = randomBytes(32).toString("hex");
      assert.throws(() => decryptPrivate(restored, "meeting"), {
        code: "PRIVATE_KEY",
      });
      process.env.ADMIN_SESSION_SECRET = readFileSync(
        join(snapshot, "server.env"),
        "utf8",
      ).match(/^ADMIN_SESSION_SECRET=(.+)$/m)![1];
      assert.deepEqual(
        JSON.parse(decryptPrivate(restored, "meeting")),
        meeting,
      );
    });

    for (const column of [
      "platform",
      "gameServer",
      "meetingCipher",
      "meetingVersion",
    ]) {
      restoreSnapshot(snapshot, data);
      withDatabase((db) => {
        db.exec(`ALTER TABLE GameReservation DROP COLUMN "${column}"`);
      });
      assert.throws(() => createSnapshot(data, backups, env), /集合信息字段/);
    }
    restoreSnapshot(old, data);
    withDatabase((db) => {
      assert.deepEqual(reservations(db), original.reservations);
      assert.deepEqual(related(db), original.related);
      db.exec(sql);
      assert.deepEqual(
        reservations(db).map((row) => ({ ...row })),
        withDefaults(original.reservations),
      );
      assert.deepEqual(related(db), original.related);
    });
  } finally {
    if (previousSecret === undefined) delete process.env.ADMIN_SESSION_SECRET;
    else process.env.ADMIN_SESSION_SECRET = previousSecret;
    rmSync(root, { recursive: true, force: true });
  }
});
