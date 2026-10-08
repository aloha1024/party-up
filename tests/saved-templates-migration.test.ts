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

test("template and calendar migrations preserve accounts, old backups, private configuration and subscription state", () => {
  const root = mkdtempSync(join(tmpdir(), "party-templates-migration-"));
  const data = join(root, "data"),
    backups = join(root, "backups"),
    env = join(root, ".env");
  const migrations = [
    "20261008000300_saved_templates",
    "20261008000400_calendar_subscription",
  ];
  const required = [
    {
      table: "UserReservationTemplate",
      label: "常用模板",
      columns: [
        "id",
        "userId",
        "name",
        "visibility",
        "gameName",
        "hostName",
        "maxPlayers",
        "description",
        "platform",
        "gameServer",
        "version",
        "createdAt",
        "updatedAt",
      ],
    },
    {
      table: "CalendarSubscription",
      label: "日历订阅",
      columns: [
        "userId",
        "tokenHash",
        "userVersion",
        "version",
        "includeInvites",
        "createdAt",
        "updatedAt",
      ],
    },
  ];
  const withDatabase = <T>(run: (database: DatabaseSync) => T): T => {
    const database = new DatabaseSync(join(data, "reservations.db"));
    try {
      database.exec("PRAGMA foreign_keys=ON");
      return run(database);
    } finally {
      database.close();
    }
  };
  const apply = (database: DatabaseSync, name: string) => {
    const sql = readFileSync(`prisma/migrations/${name}/migration.sql`, "utf8");
    database.exec(sql);
    database
      .prepare("INSERT INTO _prisma_migrations VALUES(?,?,'2026-10-08',NULL)")
      .run(name, createHash("sha256").update(sql).digest("hex"));
  };
  const legacyRows = (database: DatabaseSync) =>
    [
      "User",
      "UserSession",
      "GameReservation",
      "Participant",
      "CreationRequest",
    ].map((table) =>
      database.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
    );
  const newRows = (database: DatabaseSync) =>
    required.map(({ table }) =>
      database.prepare(`SELECT * FROM ${table} ORDER BY userId`).all(),
    );
  try {
    mkdirSync(data);
    writeFileSync(env, "APP_PORT=3001\n");
    const original = withDatabase((database) => {
      database.exec(
        "CREATE TABLE _prisma_migrations(migration_name TEXT,checksum TEXT,finished_at TEXT,rolled_back_at TEXT)",
      );
      for (const name of readdirSync("prisma/migrations")
        .filter((name) => /^\d/.test(name) && name < migrations[0])
        .sort())
        apply(database, name);
      database.exec(`
        INSERT INTO User(id,username,nickname,passwordHash,identityKey,recoveryHash,version)
          VALUES('owner','legacy_owner','旧队长','legacy-password-hash','owner-key','legacy-recovery-hash',7),
                ('other','legacy_other','旧队友','other-password-hash','other-key',NULL,2);
        INSERT INTO UserSession(id,publicId,userId,version,expiresAt,browser,os,createdAt)
          VALUES('owner-session','owner-public-session','owner',7,2000000000000,'Chrome','Windows',1900000000000);
        INSERT INTO GameReservation(id,gameName,hostName,hostTokenHash,scheduledAt,maxPlayers,updatedAt,platform,gameServer,meetingCipher,meetingVersion)
          VALUES('legacy','原有预约','旧队长','member-hash',2000000000000,3,1900000000000,'PC','亚服','preserved-cipher',5);
        INSERT INTO Participant(id,reservationId,name,nameKey,tokenHash)
          VALUES('participant','legacy','旧队长','旧队长','member-hash');
        INSERT INTO CreationRequest(id,ownerTokenHash,key,inputHash,reservationId)
          VALUES('request','member-hash','request-key','input-hash','legacy');
      `);
      return legacyRows(database);
    });
    const old = createSnapshot(data, backups, env);
    assert.equal(verifySnapshot(old).version, 2);
    withDatabase((database) => {
      for (const migration of migrations) apply(database, migration);
      assert.deepEqual(legacyRows(database), original);
      assert.deepEqual(newRows(database), [[], []]);
      database.exec(`
        INSERT INTO UserReservationTemplate(id,userId,name,gameName,hostName,maxPlayers,updatedAt)
          VALUES('default-template','other','默认模板','默认游戏','旧队友',4,1900000000000);
        INSERT INTO CalendarSubscription(userId,userVersion,updatedAt)
          VALUES('other',2,1900000000000);
      `);
      const defaults = database
        .prepare(
          "SELECT * FROM UserReservationTemplate WHERE id='default-template'",
        )
        .get()!;
      assert.equal(defaults.visibility, "PUBLIC");
      assert.equal(defaults.description, "");
      assert.equal(defaults.platform, "");
      assert.equal(defaults.gameServer, "");
      assert.equal(defaults.version, 0);
      const disabled = database
        .prepare("SELECT * FROM CalendarSubscription WHERE userId='other'")
        .get()!;
      assert.equal(disabled.tokenHash, null);
      assert.equal(disabled.includeInvites, 0);
      assert.equal(disabled.version, 0);
      database.exec(`
        INSERT INTO UserReservationTemplate(id,userId,name,visibility,gameName,hostName,maxPlayers,description,platform,gameServer,version,createdAt,updatedAt)
          VALUES('saved-template','owner','周末邀请模板','INVITE','保留游戏','旧队长',6,'保留备注','PC','亚洲',3,1900000000000,1900000001000);
      `);
      const tokenHash = createHash("sha256")
        .update("test-subscription-secret")
        .digest("hex");
      database
        .prepare(
          "INSERT INTO CalendarSubscription(userId,tokenHash,userVersion,version,includeInvites,createdAt,updatedAt) VALUES('owner',?,7,4,1,1900000000000,1900000001000)",
        )
        .run(tokenHash);
      assert.throws(
        () =>
          database
            .prepare(
              "UPDATE CalendarSubscription SET tokenHash=? WHERE userId='other'",
            )
            .run(tokenHash),
        /UNIQUE/,
      );
      assert.throws(
        () =>
          database.exec(
            "INSERT INTO CalendarSubscription(userId,userVersion,updatedAt) VALUES('owner',7,1900000000000)",
          ),
        /UNIQUE/,
      );
      assert.throws(
        () =>
          database.exec(
            "INSERT INTO UserReservationTemplate(id,userId,name,gameName,hostName,maxPlayers,updatedAt) VALUES('orphan','missing','孤立模板','游戏','队长',2,1900000000000)",
          ),
        /FOREIGN KEY/,
      );
    });
    const before = withDatabase(newRows);
    const snapshot = createSnapshot(data, backups, env);
    const manifest = verifySnapshot(snapshot);
    for (const migration of migrations)
      assert.ok(
        manifest.migrations.some(
          (row: { name: string }) => row.name === migration,
        ),
      );
    assert.equal(
      readFileSync(join(snapshot, "reservations.db")).includes(
        Buffer.from("test-subscription-secret"),
      ),
      false,
    );
    withDatabase((database) => {
      database.exec(
        "DELETE FROM UserReservationTemplate; UPDATE CalendarSubscription SET tokenHash=NULL,includeInvites=0,version=version+1; DELETE FROM UserSession",
      );
    });
    restoreSnapshot(snapshot, data);
    withDatabase((database) => {
      assert.deepEqual(newRows(database), before);
      assert.deepEqual(legacyRows(database), original);
      database.exec("DELETE FROM User WHERE id='owner'");
      assert.equal(
        database
          .prepare(
            "SELECT COUNT(*) n FROM UserReservationTemplate WHERE userId='owner'",
          )
          .get()!.n,
        0,
      );
      assert.equal(
        database
          .prepare(
            "SELECT COUNT(*) n FROM CalendarSubscription WHERE userId='owner'",
          )
          .get()!.n,
        0,
      );
      assert.equal(
        database
          .prepare(
            "SELECT COUNT(*) n FROM UserReservationTemplate WHERE userId='other'",
          )
          .get()!.n,
        1,
      );
      assert.equal(
        database
          .prepare(
            "SELECT COUNT(*) n FROM CalendarSubscription WHERE userId='other'",
          )
          .get()!.n,
        1,
      );
    });

    for (const { table, label, columns } of required) {
      restoreSnapshot(snapshot, data);
      withDatabase((database) => database.exec(`DROP TABLE ${table}`));
      assert.throws(
        () => createSnapshot(data, backups, env),
        new RegExp(`${label}数据表`),
      );
      for (const missing of columns) {
        restoreSnapshot(snapshot, data);
        withDatabase((database) => {
          const retained = columns
            .filter((column) => column !== missing)
            .map((column) => `"${column}"`)
            .join(",");
          // Rebuild without constraints so each missing field reaches backup validation.
          database.exec(
            `CREATE TABLE Damaged AS SELECT ${retained} FROM ${table}; DROP TABLE ${table}; ALTER TABLE Damaged RENAME TO ${table};`,
          );
        });
        assert.throws(
          () => createSnapshot(data, backups, env),
          new RegExp(`${label}字段`),
        );
      }
    }
    restoreSnapshot(old, data);
    withDatabase((database) => {
      assert.deepEqual(legacyRows(database), original);
      for (const { table } of required)
        assert.equal(
          database
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            )
            .get(table),
          undefined,
        );
      for (const migration of migrations) apply(database, migration);
      assert.deepEqual(newRows(database), [[], []]);
      assert.deepEqual(legacyRows(database), original);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
