import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adminBootstrapConfigured,
  bootstrapFingerprint,
  createAdminSession,
  hashPassword,
  readAdminSession,
  verifyPasswordHash,
  SESSION_SECONDS,
} from "../server/admin-auth";

test("password hashes and versioned sessions reject wrong values, tampering and expiry", async () => {
  const old = { ...process.env };
  try {
    process.env.ADMIN_USERNAME = "admin";
    process.env.ADMIN_PASSWORD_HASH = await hashPassword("temporary-password");
    process.env.ADMIN_SESSION_SECRET = "b".repeat(64);
    assert.equal(adminBootstrapConfigured(), true);
    assert.match(bootstrapFingerprint(), /^[a-f0-9]{64}$/);
    assert.equal(
      await verifyPasswordHash(
        "temporary-password",
        process.env.ADMIN_PASSWORD_HASH,
      ),
      true,
    );
    assert.equal(
      await verifyPasswordHash("wrong", process.env.ADMIN_PASSWORD_HASH),
      false,
    );
    const now = Date.now();
    const token = createAdminSession(2, 3, now);
    assert.deepEqual(readAdminSession(token, now), {
      adminId: 2,
      sessionVersion: 3,
    });
    assert.equal(readAdminSession(token + "x", now), null);
    assert.equal(readAdminSession(token.replace("v2.2.", "v2.1."), now), null);
    assert.equal(readAdminSession(undefined, now), null);
    assert.equal(readAdminSession(token, now + SESSION_SECONDS * 1000), null);
    process.env.ADMIN_SESSION_SECRET = "c".repeat(64);
    assert.equal(readAdminSession(token, now), null);
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
