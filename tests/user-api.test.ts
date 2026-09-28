import "./support/isolated";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "../server/db";
import { createAdminSession } from "../server/admin-auth";
const base = process.env.TEST_BASE_URL;
test(
  "HTTP accounts enforce guest capabilities, fresh identity scopes, private sessions, recovery and admin reset",
  { skip: !base },
  async () => {
    const username = "http_" + randomUUID().replaceAll("-", "").slice(0, 20),
      password = "http-user-password";
    const identity = async (cookie: string) =>
      (
        await (
          await fetch(base + "/api/identity", { headers: { Cookie: cookie } })
        ).json()
      ).data;
    const send = async (
      path: string,
      method: string,
      cookie = "",
      data?: unknown,
      scope?: string,
    ) =>
      fetch(base + path, {
        method,
        headers: {
          Origin: base!,
          Cookie: cookie,
          "Content-Type": "application/json",
          "X-Identity-Scope": scope ?? (await identity(cookie)).scope,
          "Idempotency-Key": randomUUID(),
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
    const bootstrap = await send("/api/identity", "POST");
    const guest = bootstrap.headers.get("set-cookie")!.split(";")[0];
    const guestInfo = await identity(guest);
    assert.equal(guestInfo.mode, "guest");
    assert.equal(guestInfo.capabilities.createInvitation, false);
    const input = {
      gameName: username,
      hostName: "Host",
      scheduledAt: new Date(Date.now() + 86400000).toISOString(),
      maxPlayers: 3,
    };
    const original = await send("/api/reservations", "POST", guest, input);
    assert.equal(original.status, 200);
    const r = (await original.json()).data;
    let userId = "",
      adminId = 0;
    try {
      assert.equal(
        (
          await send("/api/reservations", "POST", guest, {
            ...input,
            visibility: "INVITE",
          })
        ).status,
        403,
      );
      assert.equal(
        (await send(`/api/reservations/${r.id}/calendar`, "GET", guest)).status,
        403,
      );
      const noScope = await fetch(base + "/api/reservations", {
        method: "POST",
        headers: {
          Origin: base!,
          Cookie: guest,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      });
      assert.equal(noScope.status, 409);
      const badOrigin = await fetch(base + "/api/user/register", {
        method: "POST",
        headers: {
          Origin: "https://invalid.example",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ username, password, nickname: "Member" }),
      });
      assert.equal(badOrigin.status, 403);
      const registered = await send("/api/user/register", "POST", guest, {
        username,
        password,
        nickname: "Member",
      });
      assert.equal(registered.status, 200);
      assert.equal(registered.headers.get("cache-control"), "no-store");
      const accountCookie = registered.headers.get("set-cookie")!.split(";")[0],
        cookie = accountCookie + "; " + guest;
      const recovery = (await registered.json()).data.recoveryCode;
      assert.match(recovery, /^[a-f0-9]{64}$/);
      const user = await db.user.findUniqueOrThrow({ where: { username } });
      userId = user.id;
      const member = await identity(cookie);
      assert.equal(member.mode, "user");
      assert.equal(member.ready, true);
      for (const secret of [
        user.passwordHash,
        user.identityKey,
        user.recoveryHash,
        recovery,
      ])
        assert.equal(JSON.stringify(member).includes(secret!), false);
      assert.equal(
        (
          await send(
            "/api/reservations",
            "POST",
            cookie,
            input,
            guestInfo.scope,
          )
        ).status,
        409,
      );
      const preview = (
        await (await send("/api/user/guest-claims", "GET", cookie)).json()
      ).data;
      assert.deepEqual(Object.keys(preview).sort(), [
        "fingerprint",
        "guestStorageKey",
        "items",
      ]);
      assert.deepEqual(Object.keys(preview.items[0]).sort(), [
        "canOpen",
        "conflict",
        "historical",
        "id",
        "label",
      ]);
      const claim = await send("/api/user/guest-claims", "POST", cookie, {
        key: randomUUID(),
        fingerprint: preview.fingerprint,
        ids: [r.id],
      });
      assert.equal(claim.status, 200);
      assert.equal(claim.headers.get("cache-control"), "no-store");
      assert.deepEqual(Object.keys((await claim.json()).data).sort(), [
        "fromStorage",
        "ids",
        "retired",
        "toStorage",
      ]);
      assert.equal(
        (await (await send(`/api/reservations/${r.id}`, "GET", cookie)).json())
          .data.isHost,
        true,
      );
      assert.equal(
        (await send(`/api/reservations/${r.id}/calendar`, "GET", cookie))
          .status,
        200,
      );
      assert.equal(
        (
          await send(
            `/api/reservations/${r.id}/cancel`,
            "POST",
            guest,
            { reason: "stale" },
            guestInfo.scope,
          )
        ).status,
        409,
      );
      const second = await send("/api/user/session", "POST", "", {
        username,
        password,
      });
      assert.equal(second.status, 200);
      const secondCookie = second.headers.get("set-cookie")!.split(";")[0];
      assert.equal(
        (
          await (
            await send(`/api/reservations/${r.id}`, "GET", secondCookie)
          ).json()
        ).data.isHost,
        true,
      );
      const admin = await db.adminCredential.create({
        data: {
          username: "users_" + randomUUID().slice(0, 8),
          passwordHash: "test-only",
          mustChangePassword: false,
        },
      });
      adminId = admin.id;
      const adminCookie = `party_admin=${createAdminSession(admin.id, 0)}`;
      assert.equal((await send("/api/admin/users", "GET", cookie)).status, 401);
      assert.equal(
        (await send(`/api/admin/users?q=${username}`, "GET", adminCookie))
          .status,
        200,
      );
      assert.equal(
        (
          await send(`/api/admin/users/${user.id}`, "PATCH", adminCookie, {
            action: "reset",
            version: 0,
            password: "temporary-http-password",
          })
        ).status,
        200,
      );
      assert.equal((await identity(cookie)).mode, "invalid");
      assert.equal(
        (await send("/api/reservations", "POST", cookie, input)).status,
        401,
      );
      assert.equal(
        (
          await send("/api/user/recovery/reset", "POST", "", {
            username,
            recoveryCode: recovery,
            password,
          })
        ).status,
        400,
      );
      const limitedLogin = await send("/api/user/session", "POST", "", {
        username,
        password: "temporary-http-password",
      });
      const limitedCookie = limitedLogin.headers
        .get("set-cookie")!
        .split(";")[0];
      assert.equal((await identity(limitedCookie)).ready, false);
      assert.equal(
        (
          await (
            await send(`/api/reservations/${r.id}`, "GET", limitedCookie)
          ).json()
        ).data.isHost,
        false,
      );
      assert.equal(
        (
          await send("/api/user/password", "POST", limitedCookie, {
            currentPassword: "temporary-http-password",
            password,
          })
        ).status,
        200,
      );
    } finally {
      await db.gameReservation.deleteMany({ where: { gameName: username } });
      if (userId) await db.user.deleteMany({ where: { id: userId } });
      if (adminId) {
        await db.adminAuditLog.deleteMany({ where: { actorId: adminId } });
        await db.adminCredential.deleteMany({ where: { id: adminId } });
      }
    }
  },
);

test(
  "HTTP ordinary login, recovery and administrator resets have independent limits",
  { skip: !base },
  async () => {
    const username = "limited_" + randomUUID().slice(0, 8);
    const post = (path: string, data: unknown, cookie = "", method = "POST") =>
      fetch(base + path, {
        method,
        headers: {
          Origin: base!,
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
      });
    for (let i = 0; i < 20; i++)
      assert.equal(
        (
          await post("/api/user/session", {
            username,
            password: "wrong-password",
          })
        ).status,
        401,
      );
    assert.equal(
      (
        await post("/api/user/session", {
          username,
          password: "wrong-password",
        })
      ).status,
      429,
    );
    for (let i = 0; i < 5; i++)
      assert.equal(
        (
          await post("/api/user/recovery/reset", {
            username,
            password: "reset-password",
            recoveryCode: "0".repeat(64),
          })
        ).status,
        400,
      );
    assert.equal(
      (
        await post("/api/user/recovery/reset", {
          username,
          password: "reset-password",
          recoveryCode: "0".repeat(64),
        })
      ).status,
      429,
    );
    const admin = await db.adminCredential.create({
      data: {
        username: "quota_" + randomUUID().slice(0, 8),
        passwordHash: "unused",
        mustChangePassword: false,
      },
    });
    try {
      const cookie = `party_admin=${createAdminSession(admin.id, 0)}`,
        path = "/api/admin/users/" + randomUUID();
      for (let i = 0; i < 5; i++)
        assert.equal(
          (
            await post(
              path,
              { action: "reset", version: 0, password: "temporary-password" },
              cookie,
              "PATCH",
            )
          ).status,
          409,
        );
      assert.equal(
        (
          await post(
            path,
            { action: "reset", version: 0, password: "temporary-password" },
            cookie,
            "PATCH",
          )
        ).status,
        429,
      );
    } finally {
      await db.adminCredential.delete({ where: { id: admin.id } });
    }
  },
);
