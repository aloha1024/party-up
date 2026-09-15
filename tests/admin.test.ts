import { test } from "node:test";
import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import {
  adminConfigured,
  createAdminSession,
  verifyAdminSession,
  verifyCredentials,
  SESSION_SECONDS,
} from "../server/admin-auth";
test("admin credentials and signed sessions reject wrong password, tampering, expiry and rotation", async () => {
  const old = { ...process.env };
  const salt = "a".repeat(32);
  try {
    process.env.ADMIN_USERNAME = "admin";
    process.env.ADMIN_PASSWORD_HASH = `scrypt:${salt}:${scryptSync("test-password", salt, 64).toString("hex")}`;
    process.env.ADMIN_SESSION_SECRET = "b".repeat(64);
    assert.equal(adminConfigured(), true);
    assert.equal(await verifyCredentials("admin", "test-password"), true);
    assert.equal(await verifyCredentials("guest", "test-password"), false);
    assert.equal(await verifyCredentials("admin", "wrong"), false);
    const now = Date.now();
    const token = createAdminSession(now);
    assert.equal(verifyAdminSession(token, now), true);
    assert.equal(verifyAdminSession(token + "x", now), false);
    assert.equal(verifyAdminSession(undefined, now), false);
    assert.equal(
      verifyAdminSession(token, now + SESSION_SECONDS * 1000),
      false,
    );
    process.env.ADMIN_SESSION_SECRET = "c".repeat(64);
    assert.equal(verifyAdminSession(token, now), false);
    delete process.env.ADMIN_PASSWORD_HASH;
    assert.equal(adminConfigured(), false);
    assert.equal(verifyAdminSession(token, now), false);
  } finally {
    for (const key of [
      "ADMIN_USERNAME",
      "ADMIN_PASSWORD_HASH",
      "ADMIN_SESSION_SECRET",
    ]) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
  }
});
