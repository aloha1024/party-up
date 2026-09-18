import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../server/db";

const base = process.env.TEST_BASE_URL;
const temporaryPassword = process.env.TEST_ADMIN_PASSWORD;

test(
  "admin HTTP: first login changes password, later change invalidates sessions, and deletion is protected",
  { skip: !base || !temporaryPassword },
  async () => {
    let reservationId: string | undefined;
    const original = await db.adminCredential.findMany();
    const send = (path: string, method: string, data?: unknown, cookie = "") =>
      fetch(`${base}${path}`, {
        method,
        headers: {
          Origin: base!,
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: data ? JSON.stringify(data) : undefined,
      });
    const passwordAfterFirstLogin = "first-login-password-123";
    const changedPassword = "changed-password-456";
    try {
      await db.adminCredential.deleteMany();
      const created = await send("/api/reservations", "POST", {
        gameName: "Admin deletion test",
        hostName: "Host",
        maxPlayers: 3,
        scheduledAt: new Date(Date.now() + 3600000).toISOString(),
      });
      assert.equal(created.status, 200);
      reservationId = (await created.json()).data.id;
      const deleteUrl = `/api/admin/reservations/${reservationId}`;
      assert.equal((await send(deleteUrl, "DELETE")).status, 401);
      assert.equal(
        (await send(deleteUrl, "DELETE", undefined, "party_admin=forged"))
          .status,
        401,
      );
      assert.equal(
        (
          await send("/api/admin/session", "POST", {
            username: "admin",
            password: "wrong",
          })
        ).status,
        401,
      );

      const firstLogin = await send("/api/admin/session", "POST", {
        username: "admin",
        password: temporaryPassword,
      });
      assert.equal(firstLogin.status, 200);
      assert.equal((await firstLogin.json()).data.requiresPasswordChange, true);
      assert.equal(firstLogin.headers.get("set-cookie"), null);

      const setup = await send("/api/admin/session", "POST", {
        username: "admin",
        password: temporaryPassword,
        newPassword: passwordAfterFirstLogin,
      });
      assert.equal(setup.status, 200);
      const firstCookieHeader = setup.headers.get("set-cookie")!;
      assert.match(firstCookieHeader, /HttpOnly/i);
      assert.match(firstCookieHeader, /SameSite=strict/i);
      const firstCookie = firstCookieHeader.split(";")[0];
      assert.equal(
        (
          await send("/api/admin/session", "POST", {
            username: "admin",
            password: temporaryPassword,
          })
        ).status,
        401,
      );

      assert.equal(
        (
          await send(
            "/api/admin/session",
            "PATCH",
            { currentPassword: "wrong", newPassword: changedPassword },
            firstCookie,
          )
        ).status,
        401,
      );
      const changed = await send(
        "/api/admin/session",
        "PATCH",
        {
          currentPassword: passwordAfterFirstLogin,
          newPassword: changedPassword,
        },
        firstCookie,
      );
      assert.equal(changed.status, 200);
      const currentCookie = changed.headers.get("set-cookie")!.split(";")[0];
      assert.equal(
        (await send(deleteUrl, "DELETE", undefined, firstCookie)).status,
        401,
      );

      const accountInput = {
        username: "test_moderator",
        password: "moderator-temporary-123",
      };
      assert.equal(
        (await send("/api/admin/accounts", "POST", accountInput)).status,
        401,
      );
      assert.equal(
        (
          await send(
            "/api/admin/accounts",
            "POST",
            { ...accountInput, id: 1 },
            currentCookie,
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await send(
            "/api/admin/accounts",
            "POST",
            { ...accountInput, password: "short" },
            currentCookie,
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await send(
            "/api/admin/accounts",
            "POST",
            { ...accountInput, username: "admin" },
            currentCookie,
          )
        ).status,
        409,
      );
      const accounts = await Promise.all([
        send("/api/admin/accounts", "POST", accountInput, currentCookie),
        send("/api/admin/accounts", "POST", accountInput, currentCookie),
      ]);
      assert.deepEqual(accounts.map((r) => r.status).sort(), [200, 409]);
      const account = (await accounts.find((r) => r.status === 200)!.json())
        .data;
      assert.ok(account.id > 1);
      assert.equal(account.mustChangePassword, true);
      assert.deepEqual(Object.keys(account).sort(), [
        "id",
        "mustChangePassword",
        "username",
      ]);
      const rootBefore = await db.adminCredential.findUniqueOrThrow({
        where: { id: 1 },
      });
      const firstModeratorLogin = await send(
        "/api/admin/session",
        "POST",
        accountInput,
      );
      assert.equal(firstModeratorLogin.status, 200);
      assert.equal(
        (await firstModeratorLogin.json()).data.requiresPasswordChange,
        true,
      );
      assert.equal(firstModeratorLogin.headers.get("set-cookie"), null);
      const moderatorLogin = await send("/api/admin/session", "POST", {
        ...accountInput,
        newPassword: "moderator-final-123",
      });
      assert.equal(moderatorLogin.status, 200);
      const moderatorCookie = moderatorLogin.headers
        .get("set-cookie")!
        .split(";")[0];
      assert.equal(
        (
          await send(
            "/api/admin/accounts",
            "POST",
            {
              username: "blocked_admin",
              password: "blocked-password-123",
              administrator: true,
              role: "ROOT",
            },
            moderatorCookie,
          )
        ).status,
        403,
      );
      assert.equal(
        await db.adminCredential.count({
          where: { username: "blocked_admin" },
        }),
        0,
      );
      const moderatorPage = await send(
        "/admin",
        "GET",
        undefined,
        moderatorCookie,
      );
      const moderatorHtml = await moderatorPage.text();
      assert.equal(moderatorHtml.includes('href="/admin/accounts"'), false);
      assert.equal(moderatorHtml.includes('href="/admin/password"'), true);
      const forbiddenPage = await fetch(base + "/admin/accounts", {
        headers: { Cookie: moderatorCookie },
        redirect: "manual",
      });
      const forbiddenHtml = await forbiddenPage.text();
      assert.ok(
        forbiddenPage.status === 307 || forbiddenHtml.includes("NEXT_REDIRECT"),
      );
      assert.equal(forbiddenHtml.includes('name="username"'), false);
      const moderatorChanged = await send(
        "/api/admin/session",
        "PATCH",
        {
          currentPassword: "moderator-final-123",
          newPassword: "moderator-changed-456",
          adminId: 1,
        },
        moderatorCookie,
      );
      assert.equal(moderatorChanged.status, 200);
      const moderatorCurrentCookie = moderatorChanged.headers
        .get("set-cookie")!
        .split(";")[0];
      assert.equal(
        (await send(deleteUrl, "DELETE", undefined, moderatorCookie)).status,
        401,
      );
      const rootAfter = await db.adminCredential.findUniqueOrThrow({
        where: { id: 1 },
      });
      assert.equal(rootAfter.passwordHash, rootBefore.passwordHash);
      assert.equal(rootAfter.sessionVersion, rootBefore.sessionVersion);

      const editUrl = `/api/reservations/${reservationId}`;
      const changes = {
        gameName: "Admin edited",
        hostName: "Updated host",
        maxPlayers: 4,
        description: "Updated by admin",
        scheduledAt: new Date(Date.now() + 7200000).toISOString(),
      };
      assert.equal(
        (await send(editUrl, "PATCH", { ...changes, administrator: true }))
          .status,
        403,
      );
      assert.equal(
        (await send(editUrl, "PATCH", changes, currentCookie)).status,
        200,
      );
      assert.equal(
        (await send(editUrl, "PATCH", changes, moderatorCurrentCookie)).status,
        200,
      );
      assert.equal(
        (await send(deleteUrl, "DELETE", undefined, moderatorCurrentCookie))
          .status,
        200,
      );
      assert.equal(await db.participant.count({ where: { reservationId } }), 0);
      assert.equal(
        (await send(`/api/reservations/${reservationId}`, "GET")).status,
        404,
      );

      const logout = await send(
        "/api/admin/session",
        "DELETE",
        undefined,
        currentCookie,
      );
      assert.equal(logout.status, 200);
      assert.match(logout.headers.get("set-cookie")!, /Max-Age=0/i);
    } finally {
      if (reservationId)
        await db.gameReservation.deleteMany({ where: { id: reservationId } });
      await db.adminCredential.deleteMany();
      if (original.length)
        await db.adminCredential.createMany({ data: original });
      await db.$disconnect();
    }
  },
);
