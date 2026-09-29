import "./support/isolated";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  createSnapshot,
  restoreSnapshot,
  verifySnapshot,
} from "../scripts/backup-data.mjs";

const migration = "20260929000100_session_management";
const migrationSql = readFileSync(
  `prisma/migrations/${migration}/migration.sql`,
  "utf8",
);
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function removeFixture(root: string) {
  const absolute = realpathSync(root);
  assert.equal(dirname(absolute), realpathSync(tmpdir()));
  assert.match(
    basename(absolute),
    /^party-(session-migration-|up-tests-session-migration-)/,
  );
  rmSync(absolute, { recursive: true, force: true });
}

function seedLegacy(database: DatabaseSync) {
  for (const name of readdirSync("prisma/migrations")
    .filter((name) => /^\d/.test(name) && name < migration)
    .sort())
    database.exec(
      readFileSync(`prisma/migrations/${name}/migration.sql`, "utf8"),
    );
  const token = randomBytes(32).toString("hex"),
    expired = randomBytes(32).toString("hex"),
    stale = randomBytes(32).toString("hex");
  database.exec(`PRAGMA foreign_keys=ON;
    INSERT INTO User(id,username,nickname,passwordHash,identityKey,recoveryHash,version)
      VALUES ('session-owner','session-owner','Owner','unchanged-password-hash','00000000-0000-4000-8000-000000000001','unchanged-recovery-hash',3);
    INSERT INTO GameReservation(id,gameName,hostName,hostTokenHash,scheduledAt,maxPlayers,updatedAt)
      VALUES ('legacy-reservation','Legacy','Host','guest-owner',2000000000000,3,CURRENT_TIMESTAMP);
    INSERT INTO Participant(id,reservationId,name,nameKey,tokenHash)
      VALUES ('legacy-participant','legacy-reservation','Host','host','guest-owner');
    INSERT INTO CreationRequest(id,ownerTokenHash,key,inputHash,reservationId)
      VALUES ('legacy-creation','guest-owner','creation-key','creation-input','legacy-reservation');
    INSERT INTO GuestIdentity(hash,version,retired) VALUES ('guest-owner',2,0);
    INSERT INTO GuestClaim(id,userId,guestHash,key,inputHash,result)
      VALUES ('legacy-claim','session-owner','previous-guest','claim-key','claim-input','{}');`);
  const insert = database.prepare(
    "INSERT INTO UserSession(id,userId,version,expiresAt) VALUES (?,'session-owner',?,?)",
  );
  insert.run(digest(token), 3, new Date("2100-01-01T00:00:00Z").getTime());
  insert.run(digest(expired), 3, 0);
  insert.run(digest(stale), 2, new Date("2100-01-01T00:00:00Z").getTime());
  return { token, expired, stale };
}

function recordMigrations(database: DatabaseSync, upgraded: boolean) {
  database.exec(`CREATE TABLE _prisma_migrations (
    migration_name TEXT, checksum TEXT, finished_at TEXT, rolled_back_at TEXT
  )`);
  const insert = database.prepare(
    "INSERT INTO _prisma_migrations VALUES (?,?,'2026-09-29',NULL)",
  );
  for (const name of [
    "20260928000100_user_accounts",
    ...(upgraded ? [migration] : []),
  ])
    insert.run(
      name,
      digest(readFileSync(`prisma/migrations/${name}/migration.sql`, "utf8")),
    );
}

test("session migration preserves every credential and existing record while adding independent public IDs", () => {
  const database = new DatabaseSync(":memory:");
  try {
    seedLegacy(database);
    const before = database
      .prepare("SELECT * FROM UserSession ORDER BY id")
      .all();
    const tables = [
      "User",
      "GameReservation",
      "Participant",
      "CreationRequest",
      "GuestIdentity",
      "GuestClaim",
    ];
    const unchanged = tables.map((table) =>
      database.prepare(`SELECT * FROM ${table}`).all(),
    );
    database.exec(migrationSql);
    assert.deepEqual(
      database
        .prepare(
          "SELECT id,userId,version,expiresAt FROM UserSession ORDER BY id",
        )
        .all(),
      before,
    );
    assert.deepEqual(
      tables.map((table) => database.prepare(`SELECT * FROM ${table}`).all()),
      unchanged,
    );
    const sessions = database
      .prepare("SELECT * FROM UserSession ORDER BY id")
      .all();
    assert.equal(
      new Set(sessions.map((session) => session.publicId)).size,
      before.length,
    );
    for (const session of sessions) {
      assert.match(String(session.publicId), uuid);
      assert.notEqual(session.publicId, session.id);
      assert.equal(session.createdAt, null);
      assert.equal(session.browser, null);
      assert.equal(session.os, null);
    }
    assert.throws(() =>
      database
        .prepare(
          "INSERT INTO UserSession(id,publicId,userId,version,expiresAt) VALUES ('duplicate',?,'session-owner',3,2000000000000)",
        )
        .run(sessions[0].publicId),
    );
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    database.exec("DELETE FROM User WHERE id='session-owner'");
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM UserSession").get()!
        .count,
      0,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM Participant").get()!
        .count,
      1,
    );
  } finally {
    database.close();
  }
});

test("the original cookie still authenticates through resolveViewer after migrating an actual legacy database", () => {
  const root = mkdtempSync(join(tmpdir(), "party-up-tests-session-migration-"));
  const path = join(root, "tests.db");
  try {
    const database = new DatabaseSync(path);
    let credentials: ReturnType<typeof seedLegacy>;
    try {
      credentials = seedLegacy(database);
      database.exec(migrationSql);
    } finally {
      database.close();
    }
    const databaseUrl = "file:" + path.replaceAll("\\", "/");
    const markerToken = randomBytes(32).toString("hex");
    writeFileSync(
      join(root, "test-context.json"),
      JSON.stringify({ token: markerToken, databaseUrl }),
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      PARTY_TEST_ROOT: root,
      PARTY_TEST_TOKEN: markerToken,
      SESSION_MIGRATION_CREDENTIALS: JSON.stringify(credentials),
    };
    for (const key of [
      "TEST_BASE_URL",
      "TEST_ADMIN_PASSWORD",
      "NODE_OPTIONS",
      "NODE_TEST_CONTEXT",
    ])
      delete env[key];
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "./scripts/test-preload.mjs",
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `import { resolveViewer } from './server/user-identity.ts';
       import { db } from './server/db.ts';
       const { token, expired, stale } = JSON.parse(process.env.SESSION_MIGRATION_CREDENTIALS);
       try {
         const viewer = await resolveViewer(token);
         console.log(JSON.stringify({mode: viewer.mode, userId: viewer.user?.id, version: viewer.version,
           expired: (await resolveViewer(expired)).mode, stale: (await resolveViewer(stale)).mode}));
       } finally { await db.$disconnect(); }`,
      ],
      { env, encoding: "utf8", windowsHide: true, timeout: 30000 },
    );
    assert.equal(child.status, 0, child.error?.message || child.stderr);
    assert.deepEqual(JSON.parse(child.stdout.trim()), {
      mode: "user",
      userId: "session-owner",
      version: 3,
      expired: "invalid",
      stale: "invalid",
    });
  } finally {
    removeFixture(root);
  }
});

test("session metadata survives backup restore and completed migrations require every new field", () => {
  const root = mkdtempSync(join(tmpdir(), "party-session-migration-"));
  const data = join(root, "data"),
    backups = join(root, "backups"),
    env = join(root, ".env");
  mkdirSync(data);
  writeFileSync(env, "APP_PORT=3001\n");
  const open = () => new DatabaseSync(join(data, "reservations.db"));
  try {
    const database = open();
    seedLegacy(database);
    database.exec(migrationSql);
    recordMigrations(database, true);
    database
      .prepare(
        "INSERT INTO UserSession(id,publicId,userId,version,expiresAt,createdAt,browser,os) VALUES ('new-session',?,'session-owner',3,2000000000000,1900000000000,'Firefox','Linux')",
      )
      .run(randomUUID());
    const before = database
      .prepare("SELECT * FROM UserSession ORDER BY id")
      .all();
    database.close();
    const snapshot = createSnapshot(data, backups, env);
    assert.equal(verifySnapshot(snapshot).version, 2);
    const changed = open();
    changed.exec("DELETE FROM UserSession");
    changed.close();
    restoreSnapshot(snapshot, data);
    const restored = open();
    assert.deepEqual(
      restored.prepare("SELECT * FROM UserSession ORDER BY id").all(),
      before,
    );
    restored.close();
    for (const column of ["createdAt", "browser", "os", "publicId"]) {
      restoreSnapshot(snapshot, data);
      const broken = open();
      if (column === "publicId")
        broken.exec('DROP INDEX "UserSession_publicId_key"');
      broken.exec(`ALTER TABLE UserSession DROP COLUMN "${column}"`);
      broken.close();
      assert.throws(
        () => createSnapshot(data, backups, env),
        /缺少登录会话管理字段/,
      );
    }
  } finally {
    removeFixture(root);
  }
});

test("backups made before session metadata remain restorable and can be migrated afterward", () => {
  const root = mkdtempSync(join(tmpdir(), "party-session-migration-"));
  const data = join(root, "data"),
    backups = join(root, "backups"),
    env = join(root, ".env");
  mkdirSync(data);
  writeFileSync(env, "APP_PORT=3001\n");
  const open = () => new DatabaseSync(join(data, "reservations.db"));
  try {
    const database = open();
    seedLegacy(database);
    recordMigrations(database, false);
    const before = database
      .prepare("SELECT * FROM UserSession ORDER BY id")
      .all();
    database.close();
    const snapshot = createSnapshot(data, backups, env);
    assert.equal(verifySnapshot(snapshot).version, 2);
    const changed = open();
    changed.exec("DELETE FROM UserSession");
    changed.close();
    restoreSnapshot(snapshot, data);
    const restored = open();
    assert.deepEqual(
      restored.prepare("SELECT * FROM UserSession ORDER BY id").all(),
      before,
    );
    restored.exec(migrationSql);
    assert.deepEqual(
      restored
        .prepare(
          "SELECT id,userId,version,expiresAt FROM UserSession ORDER BY id",
        )
        .all(),
      before,
    );
    restored.close();
  } finally {
    removeFixture(root);
  }
});
