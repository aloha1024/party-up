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

test("favorites migration preserves account and reservation data, supports old backups and restores private favorites with both cascades", () => {
  const root = mkdtempSync(join(tmpdir(), "party-favorites-migration-"));
  const data = join(root, "data"),
    backups = join(root, "backups"),
    env = join(root, ".env");
  const migration = "20261008000500_reservation_favorites";
  const sql = readFileSync(
    `prisma/migrations/${migration}/migration.sql`,
    "utf8",
  );
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
  const legacy = (db: DatabaseSync) =>
    [
      "User",
      "UserSession",
      "GameReservation",
      "Participant",
      "UserReservationTemplate",
      "CalendarSubscription",
    ].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
  const favorites = (db: DatabaseSync) =>
    db.prepare("SELECT * FROM UserReservationFavorite ORDER BY id").all();
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
        INSERT INTO User(id,username,nickname,passwordHash,identityKey,version) VALUES
          ('owner','favorite_owner','队长','old-hash','owner-key',3),('other','favorite_other','队友','other-hash','other-key',0);
        INSERT INTO UserSession(id,publicId,userId,version,expiresAt) VALUES('session','public-session','owner',3,2000000000000);
        INSERT INTO GameReservation(id,gameName,hostName,hostTokenHash,scheduledAt,maxPlayers,updatedAt,platform,gameServer,revision,editVersion,visibility,inviteVersion,inviteHash,inviteCipher) VALUES
          ('public','旧公开预约','队长','owner-hash',2000000000000,3,1900000000000,'PC','亚洲',7,2,'PUBLIC',1,NULL,NULL),
          ('invite','旧邀请预约','队友','other-hash',2000000001000,4,1900000000000,'PS5','欧洲',5,1,'INVITE',4,'invite-hash','invite-cipher');
        INSERT INTO Participant(id,reservationId,name,nameKey,tokenHash) VALUES('participant','public','队长','队长','owner-hash');
        INSERT INTO UserReservationTemplate(id,userId,name,gameName,hostName,maxPlayers,updatedAt) VALUES('template','owner','旧模板','旧游戏','队长',3,1900000000000);
        INSERT INTO CalendarSubscription(userId,tokenHash,userVersion,version,includeInvites,updatedAt) VALUES('owner','subscription-hash',3,4,1,1900000000000);
      `);
      return legacy(db);
    });
    const old = createSnapshot(data, backups, env);
    assert.equal(verifySnapshot(old).version, 2);
    withDatabase((db) => {
      apply(db, migration, sql);
      assert.deepEqual(legacy(db), original);
      assert.deepEqual(favorites(db), []);
      db.exec(
        `INSERT INTO UserReservationFavorite(userId,reservationId,createdAt) VALUES('owner','public',1900000000000),('owner','invite',1900000001000),('other','public',1900000002000)`,
      );
      assert.throws(
        () =>
          db.exec(
            "INSERT INTO UserReservationFavorite(userId,reservationId) VALUES('owner','public')",
          ),
        /UNIQUE/,
      );
      assert.throws(
        () =>
          db.exec(
            "INSERT INTO UserReservationFavorite(userId,reservationId) VALUES('missing','public')",
          ),
        /FOREIGN KEY/,
      );
      assert.throws(
        () =>
          db.exec(
            "INSERT INTO UserReservationFavorite(userId,reservationId) VALUES('owner','missing')",
          ),
        /FOREIGN KEY/,
      );
    });
    const before = withDatabase(favorites);
    assert.equal(before.length, 3);
    assert.equal(new Set(before.map((row) => row.id)).size, 3);
    const snapshot = createSnapshot(data, backups, env);
    assert.ok(
      verifySnapshot(snapshot).migrations.some(
        (row: { name: string }) => row.name === migration,
      ),
    );
    withDatabase((db) =>
      db.exec(
        "DELETE FROM UserReservationFavorite; UPDATE GameReservation SET revision=revision+1",
      ),
    );
    restoreSnapshot(snapshot, data);
    withDatabase((db) => {
      assert.deepEqual(favorites(db), before);
      assert.deepEqual(legacy(db), original);
      db.exec(
        "UPDATE GameReservation SET deletedAt=1900000003000 WHERE id='public'",
      );
      assert.equal(favorites(db).length, 3);
      db.exec("DELETE FROM GameReservation WHERE id='public'");
      assert.deepEqual(
        favorites(db).map((row) => row.reservationId),
        ["invite"],
      );
      db.exec("DELETE FROM User WHERE id='owner'");
      assert.deepEqual(favorites(db), []);
      assert.equal(
        db
          .prepare("SELECT COUNT(*) n FROM GameReservation WHERE id='invite'")
          .get()!.n,
        1,
      );
    });
    restoreSnapshot(snapshot, data);
    withDatabase((db) => {
      db.exec("DELETE FROM User WHERE id='owner'");
      assert.deepEqual(
        favorites(db).map((row) => row.userId),
        ["other"],
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) n FROM GameReservation").get()!.n,
        2,
      );
    });
    restoreSnapshot(snapshot, data);
    withDatabase((db) => db.exec("DROP TABLE UserReservationFavorite"));
    assert.throws(() => createSnapshot(data, backups, env), /收藏数据表/);
    const columns = ["id", "userId", "reservationId", "createdAt"];
    for (const missing of columns) {
      restoreSnapshot(snapshot, data);
      withDatabase((db) => {
        const retained = columns
          .filter((column) => column !== missing)
          .map((column) => `"${column}"`)
          .join(",");
        db.exec(
          `CREATE TABLE Damaged AS SELECT ${retained} FROM UserReservationFavorite; DROP TABLE UserReservationFavorite; ALTER TABLE Damaged RENAME TO UserReservationFavorite;`,
        );
      });
      assert.throws(() => createSnapshot(data, backups, env), /收藏字段/);
    }
    restoreSnapshot(old, data);
    withDatabase((db) => {
      assert.deepEqual(legacy(db), original);
      assert.equal(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='UserReservationFavorite'",
          )
          .get(),
        undefined,
      );
      apply(db, migration, sql);
      assert.deepEqual(favorites(db), []);
      assert.deepEqual(legacy(db), original);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
