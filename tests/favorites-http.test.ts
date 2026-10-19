import "./support/isolated";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../server/db";
import { registeredToken, testCookie } from "./support/member";
import { createReservation } from "../server/reservations";
import {
  currentInvitation,
  acceptInvitation,
  rotateInvitation,
} from "../server/reservation-invitations";
import { ADMIN_COOKIE, createAdminSession } from "../server/admin-auth";
import { ensureAdminRecord } from "../server/admin";
import { resolveViewer } from "../server/user-identity";

const base = process.env.TEST_BASE_URL;
const ids: string[] = [],
  users: string[] = [];
async function account() {
  const token = await registeredToken(),
    cookie = testCookie(token);
  const viewer = await resolveViewer(cookie.split("=")[1]);
  users.push(viewer.user!.id);
  return { token, cookie, viewer };
}
async function reservation(token: string, visibility = "PUBLIC") {
  const r = await createReservation(
    {
      gameName: "Favorite HTTP-" + randomUUID(),
      hostName: "收藏队长",
      maxPlayers: 3,
      visibility,
      scheduledAt: new Date(Date.now() + 86400000).toISOString(),
    },
    token,
  );
  ids.push(r.id);
  return r;
}
async function scope(cookie: string) {
  return (
    await (
      await fetch(base + "/api/identity", { headers: { Cookie: cookie } })
    ).json()
  ).data.scope as string;
}
async function send(
  id: string,
  method: string,
  cookie: string,
  identityScope?: string | null,
  origin: string | null = base!,
) {
  return fetch(`${base}/api/reservations/${encodeURIComponent(id)}/favorite`, {
    method,
    headers: {
      Cookie: cookie,
      ...(origin === null ? {} : { Origin: origin }),
      ...(identityScope === null
        ? {}
        : { "X-Identity-Scope": identityScope ?? (await scope(cookie)) }),
    },
  });
}
after(async () => {
  await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

test(
  "HTTP favorites enforce account, scope and origin boundaries without administrator escalation",
  { skip: !base },
  async () => {
    const owner = await account(),
      other = await account();
    const publicGame = await reservation(owner.token),
      invited = await reservation(owner.token, "INVITE");
    await ensureAdminRecord();
    const admin = await db.adminCredential.create({
      data: {
        username: "fav-admin-" + randomUUID(),
        passwordHash: "unused",
        mustChangePassword: false,
      },
    });
    const adminCookie = `${ADMIN_COOKIE}=${createAdminSession(admin.id, admin.sessionVersion)}`;
    try {
      assert.equal(
        (
          await fetch(base + "/api/admin/audit", {
            headers: { Cookie: adminCookie },
          })
        ).status,
        200,
      );
      for (const cookie of [
        "",
        `party_identity=${randomBytes(32).toString("hex")}`,
        "party_user=invalid",
        adminCookie,
      ])
        for (const method of ["POST", "DELETE"])
          assert.equal((await send(publicGame.id, method, cookie)).status, 401);
      for (const method of ["POST", "DELETE"]) {
        assert.equal(
          (await send(publicGame.id, method, owner.cookie, null)).status,
          409,
        );
        assert.equal(
          (await send(publicGame.id, method, owner.cookie, other.viewer.scope))
            .status,
          409,
        );
        assert.equal(
          (
            await send(
              publicGame.id,
              method,
              owner.cookie,
              owner.viewer.scope,
              "https://foreign.example",
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await send(
              publicGame.id,
              method,
              owner.cookie,
              owner.viewer.scope,
              null,
            )
          ).status,
          403,
        );
        assert.equal((await send("bad$id", method, owner.cookie)).status, 400);
      }
      const bothCookies = `${other.cookie}; ${adminCookie}`;
      assert.equal(
        (
          await fetch(`${base}/api/reservations/${invited.id}`, {
            headers: { Cookie: bothCookies },
          })
        ).status,
        200,
      );
      assert.equal((await send(invited.id, "POST", bothCookies)).status, 404);
      const deleted = await send(invited.id, "DELETE", bothCookies);
      assert.equal(deleted.status, 200);
      assert.deepEqual((await deleted.json()).data, { saved: false });
      const created = await send(publicGame.id, "POST", owner.cookie);
      assert.equal(created.status, 200);
      assert.equal(created.headers.get("cache-control"), "no-store");
      assert.deepEqual((await created.json()).data, { saved: true });
      assert.equal(
        (await send(publicGame.id, "POST", owner.cookie)).status,
        200,
      );
      assert.equal(
        await db.userReservationFavorite.count({
          where: {
            userId: owner.viewer.user!.id,
            reservationId: publicGame.id,
          },
        }),
        1,
      );
      const ownPage = await (
        await fetch(base + "/my-reservations/favorites", {
          headers: { Cookie: owner.cookie },
        })
      ).text();
      const otherPage = await (
        await fetch(base + "/my-reservations/favorites", {
          headers: { Cookie: other.cookie },
        })
      ).text();
      assert.equal(ownPage.includes(publicGame.gameName), true);
      assert.equal(otherPage.includes(publicGame.gameName), false);
      assert.equal(otherPage.includes(invited.gameName), false);
      assert.deepEqual(
        (await (await send(publicGame.id, "DELETE", other.cookie)).json()).data,
        { saved: false },
      );
      assert.equal(
        await db.userReservationFavorite.count({
          where: {
            userId: owner.viewer.user!.id,
            reservationId: publicGame.id,
          },
        }),
        1,
      );
      for (let i = 0; i < 2; i++)
        assert.deepEqual(
          (await (await send(publicGame.id, "DELETE", owner.cookie)).json())
            .data,
          { saved: false },
        );
      assert.deepEqual(
        (await (await send(randomUUID(), "DELETE", owner.cookie)).json()).data,
        { saved: false },
      );
    } finally {
      await db.adminCredential.delete({ where: { id: admin.id } });
    }
  },
);

test(
  "HTTP lost invitation access and invalidated sessions cannot read or add favorites but valid accounts can delete their hidden record",
  { skip: !base },
  async () => {
    const host = await account(),
      visitor = await account();
    const r = await reservation(host.token, "INVITE");
    const invite = await currentInvitation(r.id, host.token);
    await acceptInvitation(
      r.id,
      { token: invite.path.split("#invite=")[1] },
      visitor.token,
    );
    assert.equal((await send(r.id, "POST", visitor.cookie)).status, 200);
    await rotateInvitation(
      r.id,
      { expectedVersion: invite.version },
      host.token,
    );
    const page = await (
      await fetch(base + "/my-reservations/favorites", {
        headers: { Cookie: visitor.cookie },
      })
    ).text();
    assert.equal(page.includes(r.gameName), false);
    assert.equal((await send(r.id, "POST", visitor.cookie)).status, 404);
    assert.deepEqual(
      (await (await send(r.id, "DELETE", visitor.cookie)).json()).data,
      { saved: false },
    );
    const normal = await reservation(host.token);
    for (const state of ["password", "revoked"]) {
      const current = await account();
      assert.equal((await send(normal.id, "POST", current.cookie)).status, 200);
      if (state === "password")
        await db.user.update({
          where: { id: current.viewer.user!.id },
          data: { mustChangePassword: true },
        });
      else
        await db.userSession.delete({
          where: { id: current.viewer.sessionHash! },
        });
      for (const method of ["POST", "DELETE"])
        assert.equal(
          (await send(normal.id, method, current.cookie)).status,
          401,
        );
      const privatePage = await (
        await fetch(base + "/my-reservations/favorites", {
          headers: { Cookie: current.cookie },
        })
      ).text();
      assert.equal(privatePage.includes(normal.gameName), false);
      assert.equal(
        await db.userReservationFavorite.count({
          where: { userId: current.viewer.user!.id },
        }),
        1,
      );
    }
  },
);
