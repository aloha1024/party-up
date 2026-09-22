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
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSnapshot,
  verifySnapshot,
  restoreSnapshot,
  pruneSnapshots,
} from "../scripts/backup-data.mjs";
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
      "CREATE TABLE GameReservation (id TEXT PRIMARY KEY, name TEXT); CREATE TABLE Participant (id TEXT); CREATE TABLE AdminCredential (id INTEGER); CREATE TABLE _prisma_migrations (id TEXT); INSERT INTO GameReservation VALUES ('one', '原始预约');",
    );
    db.close();
    const snapshot = createSnapshot(data, backups, env);
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
