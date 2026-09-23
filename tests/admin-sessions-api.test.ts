import "./support/isolated";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "../server/db";
import { createAdminSession, hashPassword } from "../server/admin-auth";
const base = process.env.TEST_BASE_URL;
test(
  "revoke all devices rejects old copied cookies while preserving other administrators",
  { skip: !base },
  async () => {
    const ids: number[] = [];
    const passwordHash = await hashPassword(randomUUID());
    try {
      for (let i = 0; i < 2; i++) {
        const admin = await db.adminCredential.create({
          data: {
            username: "session_" + randomUUID().slice(0, 8),
            passwordHash,
            mustChangePassword: false,
          },
        });
        ids.push(admin.id);
      }
      const cookie = (id: number) => "party_admin=" + createAdminSession(id, 0);
      const first = cookie(ids[0]),
        second = cookie(ids[0]),
        other = cookie(ids[1]);
      const send = (
        path: string,
        method: string,
        token: string,
        origin = base!,
      ) =>
        fetch(base + path, {
          method,
          headers: {
            Cookie: token,
            Origin: origin,
            "X-Request-ID": "attacker-controlled",
          },
        });
      const denied = await send(
        "/api/admin/session/all",
        "DELETE",
        first,
        "https://foreign.invalid",
      );
      assert.equal(denied.status, 403);
      const error = await denied.json();
      assert.equal(error.requestId, denied.headers.get("x-request-id"));
      assert.notEqual(error.requestId, "attacker-controlled");
      assert.equal((await send("/api/admin/audit", "GET", first)).status, 200);
      const result = await send("/api/admin/session/all", "DELETE", first);
      assert.equal(result.status, 200);
      assert.match(result.headers.get("set-cookie")!, /Max-Age=0/);
      for (const old of [first, second])
        assert.equal((await send("/api/admin/audit", "GET", old)).status, 401);
      assert.equal((await send("/api/admin/audit", "GET", other)).status, 200);
      assert.equal(
        (await send("/api/admin/session/all", "DELETE", first)).status,
        401,
      );
      assert.equal(
        await db.adminAuditLog.count({
          where: { actorId: ids[0], action: "ADMIN_REVOKE_SESSIONS" },
        }),
        1,
      );
      assert.equal(
        (await db.adminCredential.findUniqueOrThrow({ where: { id: ids[0] } }))
          .sessionVersion,
        1,
      );
      assert.equal(
        (
          await send(
            "/api/admin/audit",
            "GET",
            "party_admin=" + createAdminSession(ids[0], 1),
          )
        ).status,
        200,
      );
    } finally {
      await db.adminAuditLog.deleteMany({ where: { actorId: { in: ids } } });
      await db.adminCredential.deleteMany({ where: { id: { in: ids } } });
      await db.$disconnect();
    }
  },
);
