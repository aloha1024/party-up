import "./support/isolated";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { db } from "../server/db";
import { createReservation, joinReservation } from "../server/reservations";
const base = process.env.TEST_BASE_URL;
after(async () => {
  await db.$disconnect();
});
test(
  "HTTP waitlist requires identity/origin, validates input, hides hashes and shares roster quota",
  { skip: !base },
  async () => {
    const host = randomBytes(32).toString("hex"),
      guest = randomBytes(32).toString("hex"),
      waiter = randomBytes(32).toString("hex");
    const r = await createReservation(
      {
        gameName: "Waitlist HTTP",
        hostName: "Host",
        maxPlayers: 2,
        scheduledAt: new Date(Date.now() + 86400000).toISOString(),
      },
      host,
    );
    try {
      await joinReservation(r.id, { name: "Guest" }, guest);
      const path = `/api/reservations/${r.id}`;
      const send = (
        suffix: string,
        method = "POST",
        payload: unknown = { name: "Waiter" },
        identity = waiter,
        origin = base!,
      ) =>
        fetch(base + path + suffix, {
          method,
          headers: {
            Origin: origin,
            Cookie: identity ? `party_identity=${identity}` : "",
            "Content-Type": "application/json",
          },
          body: method === "POST" ? JSON.stringify(payload) : undefined,
        });
      assert.equal((await send("/waitlist", "POST", {}, "")).status, 428);
      assert.equal(
        (await send("/waitlist", "POST", {}, "invalid")).status,
        428,
      );
      assert.equal(
        (await send("/waitlist", "POST", {}, waiter, "https://evil.test"))
          .status,
        403,
      );
      for (const input of [
        { name: " " },
        { name: "X", rank: 1 },
        { name: "X", tokenHash: guest },
      ])
        assert.equal((await send("/waitlist", "POST", input)).status, 400);
      const queued = await send("/waitlist");
      assert.equal(queued.status, 200);
      const detail = (await queued.json()).data;
      assert.equal(detail.participants.length, 2);
      assert.equal(detail.waitlist[0].isMe, true);
      assert.deepEqual(Object.keys(detail.waitlist[0]).sort(), [
        "id",
        "isHost",
        "isMe",
        "joinedAt",
        "name",
      ]);
      assert.equal(JSON.stringify(detail).includes("tokenHash"), false);
      const stranger = randomBytes(32).toString("hex");
      assert.equal(
        (await send("/waitlist", "DELETE", undefined, stranger)).status,
        403,
      );
      assert.equal(
        (await send("/participants", "DELETE", undefined, guest)).status,
        200,
      );
      const promoted = await send("/waitlist", "DELETE");
      assert.equal(promoted.status, 409);
      assert.equal((await promoted.json()).code, "PROMOTED");
      const publicDetail = (
        await (await send("", "GET", undefined, stranger)).json()
      ).data;
      assert.equal(publicDetail.waitlist.length, 0);
      assert.equal(
        publicDetail.participants.filter((p: { isMe: boolean }) => p.isMe)
          .length,
        0,
      );
      // The same identity exhausts one shared quota across both roster routes.
      let status = 0;
      for (let i = 0; i < 31 && status !== 429; i++)
        status = (
          await send(
            i % 2 ? "/participants" : "/waitlist",
            "POST",
            { name: "Again" },
            stranger,
          )
        ).status;
      assert.equal(status, 429);
      assert.equal(
        (await send("/waitlist", "DELETE", undefined, stranger)).status,
        429,
      );
    } finally {
      await db.gameReservation.delete({ where: { id: r.id } });
    }
  },
);
