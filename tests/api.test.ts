import "./support/isolated";
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../server/db";
const base = process.env.TEST_BASE_URL;
test(
  "HTTP: origin protection, cookies, identity, malformed input and missing records",
  { skip: !base },
  async () => {
    const data = {
      gameName: "HTTP smoke test",
      hostName: "Host",
      scheduledAt: new Date(Date.now() + 3600000).toISOString(),
      maxPlayers: 2,
    };
    const send = (
      path: string,
      method: string,
      payload?: unknown,
      cookie = "",
      origin = base!,
    ) =>
      fetch(`${base}${path}`, {
        method,
        headers: {
          Origin: origin,
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
    const blocked = await send(
      "/api/reservations",
      "POST",
      data,
      "",
      "https://evil.example",
    );
    assert.equal(blocked.status, 403);
    const created = await send("/api/reservations", "POST", data);
    assert.equal(created.status, 200);
    const cookie = created.headers.get("set-cookie")!;
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=lax/i);
    const { data: r } = await created.json();
    try {
      const url = `/api/reservations/${r.id}`;
      const joined = await send(`${url}/participants`, "POST", {
        name: "Guest",
      });
      assert.equal(joined.status, 200);
      const guestCookie = joined.headers.get("set-cookie")!.split(";")[0];
      assert.equal((await joined.json()).data.status, "FULL");
      assert.equal(
        (await send(`${url}/participants`, "POST", { name: "Third" })).status,
        409,
      );
      assert.equal((await send(`${url}/participants`, "DELETE")).status, 403);
      assert.equal(
        (await send(`${url}/participants`, "DELETE", undefined, guestCookie))
          .status,
        200,
      );
      const own = await send(url, "GET", undefined, cookie.split(";")[0]);
      assert.equal((await own.json()).data.participants[0].isMe, true);
      assert.equal(
        (await send("/api/reservations/missing", "GET")).status,
        404,
      );
      assert.equal(
        (await send(url + "/cancel", "POST", { reason: "outsider" })).status,
        403,
      );
      assert.equal(
        (
          await send(
            url + "/cancel",
            "POST",
            { reason: " " },
            cookie.split(";")[0],
          )
        ).status,
        400,
      );
      const cancelled = await send(
        url + "/cancel",
        "POST",
        { reason: "临时有事" },
        cookie.split(";")[0],
      );
      assert.equal(cancelled.status, 200);
      assert.equal(
        (await cancelled.json()).data.cancellationReason,
        "临时有事",
      );
      assert.equal(
        (await send(url + "/participants", "POST", { name: "Late" })).status,
        409,
      );
      const bad = await fetch(`${base}/api/reservations`, {
        method: "POST",
        headers: { Origin: base!, "Content-Type": "application/json" },
        body: "{",
      });
      assert.equal(bad.status, 400);
    } finally {
      await db.gameReservation.delete({ where: { id: r.id } });
      await db.$disconnect();
    }
  },
);
