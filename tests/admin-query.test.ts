import "./support/isolated";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { db } from "../server/db";
import {
  currentAdmin,
  ensureAdminRecord,
  verifyAdminCredentials,
} from "../server/admin";
import { createAdminSession, hashPassword } from "../server/admin-auth";

const require = createRequire(import.meta.url);
after(() => db.$disconnect());

test("owner reads are reused without caching account or bootstrap state", async (t) => {
  const original = await ensureAdminRecord();
  const originalHash = process.env.ADMIN_PASSWORD_HASH;
  const password = randomUUID();
  const passwordHash = await hashPassword(password);
  let otherId: number | undefined;
  let cookie: string | undefined;
  t.mock.method(require("next/headers"), "cookies", async () => ({
    get: () => (cookie ? { value: cookie } : undefined),
  }));
  try {
    const owner = await db.adminCredential.update({
      where: { id: original.id },
      data: { passwordHash, mustChangePassword: false, isActive: true },
    });
    const other = await db.adminCredential.create({
      data: {
        username: "query_" + randomUUID().slice(0, 8),
        passwordHash,
        mustChangePassword: false,
      },
    });
    otherId = other.id;
    const originalFind = db.adminCredential.findUnique;
    const find = t.mock.fn(originalFind.bind(db.adminCredential));
    db.adminCredential.findUnique = find;
    t.after(() => {
      db.adminCredential.findUnique = originalFind;
    });
    const calls = () => find.mock.callCount();
    for (const admin of [owner, other]) {
      const expectedReads = admin.id === owner.id ? 1 : 2;
      cookie = createAdminSession(admin.id, admin.sessionVersion);
      let before = calls();
      assert.equal((await currentAdmin())?.id, admin.id);
      assert.equal(calls() - before, expectedReads);
      for (const supplied of [password, "wrong"]) {
        before = calls();
        assert.equal(
          (await verifyAdminCredentials(admin.username, supplied)).valid,
          supplied === password,
        );
        assert.equal(calls() - before, expectedReads);
      }
      await db.adminCredential.update({
        where: { id: admin.id },
        data: { isActive: false },
      });
      assert.equal(await currentAdmin(), null);
      assert.equal(
        (await verifyAdminCredentials(admin.username, password)).valid,
        false,
      );
      await db.adminCredential.update({
        where: { id: admin.id },
        data: { isActive: true, mustChangePassword: true },
      });
      assert.equal(await currentAdmin(), null);
      await db.adminCredential.update({
        where: { id: admin.id },
        data: { mustChangePassword: false, sessionVersion: { increment: 1 } },
      });
      assert.equal(await currentAdmin(), null);
    }
    let before = calls();
    assert.equal(
      (await verifyAdminCredentials("missing_" + randomUUID(), password)).valid,
      false,
    );
    assert.equal(calls() - before, 2);
    cookie = undefined;
    before = calls();
    assert.equal(await currentAdmin(), null);
    assert.equal(calls() - before, 0);
    // A bootstrap change must refresh the record before validating the old session.
    cookie = createAdminSession(owner.id, owner.sessionVersion + 1);
    process.env.ADMIN_PASSWORD_HASH = await hashPassword(
      "replacement-password",
    );
    assert.equal(await currentAdmin(), null);
    const updated = await db.adminCredential.findUniqueOrThrow({
      where: { id: owner.id },
    });
    assert.equal(updated.mustChangePassword, true);
    assert.equal(updated.sessionVersion, owner.sessionVersion + 2);
    assert.equal(
      (await verifyAdminCredentials(owner.username, "replacement-password"))
        .valid,
      true,
    );
    assert.equal(
      (await verifyAdminCredentials(owner.username, password)).valid,
      false,
    );
  } finally {
    if (originalHash === undefined) delete process.env.ADMIN_PASSWORD_HASH;
    else process.env.ADMIN_PASSWORD_HASH = originalHash;
    if (otherId !== undefined)
      await db.adminCredential.delete({ where: { id: otherId } });
    await db.adminCredential.update({
      where: { id: original.id },
      data: original,
    });
  }
});
