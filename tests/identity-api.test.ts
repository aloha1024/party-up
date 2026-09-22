import "./support/isolated";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "../server/db";
const base = process.env.TEST_BASE_URL;
test(
  "identity is confirmed before writes; creation is deduplicated and quota returns Retry-After",
  { skip: !base },
  async () => {
    const input = {
      gameName: "Identity test",
      hostName: "Host",
      maxPlayers: 3,
      scheduledAt: new Date(Date.now() + 3600000).toISOString(),
    };
    const key = randomUUID();
    const send = (
      path: string,
      method = "GET",
      cookie = "",
      payload?: unknown,
      k: string = key,
    ) =>
      fetch(base + path, {
        method,
        headers: {
          Origin: base!,
          Cookie: cookie,
          "Content-Type": "application/json",
          "Idempotency-Key": k,
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
    assert.equal(
      (await (await send("/api/identity")).json()).data.ready,
      false,
    );
    assert.equal(
      (await send("/api/reservations", "POST", "", input)).status,
      428,
    );
    const bootstrap = await send("/api/identity", "POST");
    const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0];
    assert.equal(
      (await (await send("/api/identity", "GET", cookie)).json()).data.ready,
      true,
    );
    assert.equal(
      (await send("/api/identity", "POST", cookie)).headers.get("set-cookie"),
      null,
    );
    let id: string | undefined;
    try {
      const created = await send("/api/reservations", "POST", cookie, input);
      assert.equal(created.status, 200);
      id = (await created.json()).data.id;
      assert.equal(created.headers.get("set-cookie"), null);
      const repeated = await send("/api/reservations", "POST", cookie, input);
      assert.equal((await repeated.json()).data.id, id);
      assert.equal(
        (await (await send("/api/reservations/" + id, "GET", cookie)).json())
          .data.isHost,
        true,
      );
      assert.equal(
        (await send("/api/reservations", "POST", cookie, input, "")).status,
        400,
      );
      let limited: Response | undefined;
      for (let i = 0; i < 12; i++) {
        const r = await send("/api/reservations", "POST", cookie, input);
        if (r.status === 429) {
          limited = r;
          break;
        }
      }
      assert.ok(limited);
      assert.ok(Number(limited.headers.get("retry-after")) > 0);
    } finally {
      if (id) {
        await db.creationRequest.deleteMany({ where: { reservationId: id } });
        await db.gameReservation.delete({ where: { id } });
      }
      await db.$disconnect();
    }
  },
);
