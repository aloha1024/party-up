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
    const original = await db.adminCredential.findUnique({ where: { id: 1 } });
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
        (await send(deleteUrl, "DELETE", undefined, currentCookie)).status,
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
      if (original) await db.adminCredential.create({ data: original });
      await db.$disconnect();
    }
  },
);
