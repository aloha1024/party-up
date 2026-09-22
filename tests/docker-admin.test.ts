import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scryptSync } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { initializeDockerAdmin } from "../scripts/docker-admin-bootstrap.mjs";

test("Docker initializes admin once, preserves changed passwords, and supports explicit reset", async () => {
  const directory = mkdtempSync(join(tmpdir(), "party-admin-"));
  const configPath = join(directory, "admin-bootstrap.json");
  const db = new PrismaClient({
    datasources: {
      db: { url: "file:" + join(directory, "test.db").replaceAll("\\", "/") },
    },
  });
  const logs: string[] = [];
  const log = (message: string) => logs.push(message);
  try {
    const sqlite = new DatabaseSync(join(directory, "test.db"));
    for (const directory of readdirSync("prisma/migrations")
      .filter((name) => /^\d/.test(name))
      .sort()) {
      const migration = readFileSync(
        "prisma/migrations/" + directory + "/migration.sql",
        "utf8",
      );
      sqlite.exec(migration);
    }
    sqlite.close();
    const env: Record<string, string> = {};
    await initializeDockerAdmin({ db, configPath, env, log });
    const first = await db.adminCredential.findUniqueOrThrow({
      where: { id: 1 },
    });
    assert.equal(first.username, "admin");
    assert.equal(first.mustChangePassword, true);
    const password = logs.join("\n").match(/临时密码：([^\n]+)/)![1];
    const [, salt, hash] = first.passwordHash.split(":");
    assert.equal(scryptSync(password, salt, 64).toString("hex"), hash);
    assert.equal(readFileSync(configPath, "utf8").includes(password), false);
    assert.ok(env.ADMIN_SESSION_SECRET.length >= 32);

    await db.adminCredential.update({
      where: { id: 1 },
      data: {
        passwordHash: "changed-password-hash",
        mustChangePassword: false,
        sessionVersion: 7,
      },
    });
    logs.length = 0;
    const restartedEnv: Record<string, string> = {};
    await initializeDockerAdmin({ db, configPath, env: restartedEnv, log });
    assert.deepEqual(restartedEnv, env);
    const restarted = await db.adminCredential.findUniqueOrThrow({
      where: { id: 1 },
    });
    assert.equal(restarted.passwordHash, "changed-password-hash");
    assert.equal(restarted.mustChangePassword, false);
    assert.equal(restarted.sessionVersion, 7);
    assert.equal(logs.join("\n").includes(password), false);

    const migrated = await db.adminCredential.findUniqueOrThrow({
      where: { id: 1 },
    });
    assert.deepEqual(migrated, restarted);
    const child = await db.adminCredential.create({
      data: {
        username: "migration_moderator",
        passwordHash: "child-password-hash",
      },
    });
    assert.ok(child.id > 1);
    assert.equal(child.mustChangePassword, true);
    await initializeDockerAdmin({ db, configPath, env: {}, log });
    assert.deepEqual(
      await db.adminCredential.findUniqueOrThrow({ where: { id: child.id } }),
      child,
    );

    await assert.rejects(
      initializeDockerAdmin({
        db,
        configPath,
        env: { ADMIN_USERNAME: "admin" },
        log,
      }),
      /不完整/,
    );
    const resetEnv = {
      ...env,
      ADMIN_PASSWORD_HASH: `scrypt:${"a".repeat(32)}:${"b".repeat(128)}`,
    };
    await initializeDockerAdmin({ db, configPath, env: resetEnv, log });
    const reset = await db.adminCredential.findUniqueOrThrow({
      where: { id: 1 },
    });
    assert.equal(reset.passwordHash, resetEnv.ADMIN_PASSWORD_HASH);
    assert.equal(reset.mustChangePassword, true);
    assert.equal(reset.sessionVersion, 8);
    assert.deepEqual(
      await db.adminCredential.findUniqueOrThrow({ where: { id: child.id } }),
      child,
    );
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), resetEnv);

    rmSync(configPath);
    await assert.rejects(
      initializeDockerAdmin({ db, configPath, env: {}, log }),
      /数据库中已有管理员/,
    );
    assert.equal(
      (await db.adminCredential.findUniqueOrThrow({ where: { id: 1 } }))
        .sessionVersion,
      8,
    );
  } finally {
    await db.$disconnect();
    rmSync(directory, { recursive: true, force: true });
  }
});
