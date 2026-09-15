import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../server/db";
const base = process.env.TEST_BASE_URL;
const password = process.env.TEST_ADMIN_PASSWORD;
test(
  "admin HTTP: login, unauthorized deletion, cascade deletion and logout",
  { skip: !base || !password },
  async () => {
    let id: string | undefined;
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
    try {
      const created = await send("/api/reservations", "POST", {
        gameName: "Admin deletion test",
        hostName: "Host",
        maxPlayers: 3,
        scheduledAt: new Date(Date.now() + 3600000).toISOString(),
      });
      assert.equal(created.status, 200);
      id = (await created.json()).data.id;
      const url = `/api/admin/reservations/${id}`;
      assert.equal((await send(url, "DELETE")).status, 401);
      assert.equal(
        (await send(url, "DELETE", undefined, "party_admin=forged")).status,
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
      const login = await send("/api/admin/session", "POST", {
        username: "admin",
        password,
      });
      assert.equal(login.status, 200);
      const header = login.headers.get("set-cookie")!;
      assert.match(header, /HttpOnly/i);
      assert.match(header, /SameSite=strict/i);
      const cookie = header.split(";")[0];
      const editUrl = `/api/reservations/${id}`;
      const changes = {
        gameName: "Admin edited",
        hostName: "Updated host",
        maxPlayers: 4,
        description: "Updated by admin",
        scheduledAt: new Date(Date.now() + 7200000).toISOString(),
      };
      assert.equal(
        (
          await send(editUrl, "PATCH", {
            ...changes,
            administrator: true,
            isAdmin: true,
          })
        ).status,
        403,
      );
      assert.equal(
        (await send(editUrl, "PATCH", changes, "party_admin=forged")).status,
        403,
      );
      const edited = await send(editUrl, "PATCH", changes, cookie);
      assert.equal(edited.status, 200);
      const updated = (await edited.json()).data;
      assert.equal(updated.gameName, changes.gameName);
      assert.equal(updated.participants[0].name, changes.hostName);
      assert.equal(updated.isHost, false);
      // Legacy reservations can be administered without guessing creator identity.
      await db.gameReservation.update({
        where: { id },
        data: { hostTokenHash: null },
      });
      assert.equal((await send(editUrl, "PATCH", changes, cookie)).status, 200);
      assert.equal((await send(url, "DELETE", undefined, cookie)).status, 200);
      assert.equal(
        await db.participant.count({ where: { reservationId: id } }),
        0,
      );
      assert.equal((await send(`/api/reservations/${id}`, "GET")).status, 404);
      assert.equal((await send(url, "DELETE", undefined, cookie)).status, 404);
      const logout = await send(
        "/api/admin/session",
        "DELETE",
        undefined,
        cookie,
      );
      assert.equal(logout.status, 200);
      assert.match(logout.headers.get("set-cookie")!, /Max-Age=0/i);
    } finally {
      if (id) await db.gameReservation.deleteMany({ where: { id } });
      await db.$disconnect();
    }
  },
);
