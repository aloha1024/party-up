import "./support/isolated";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "../server/db";
import { registerUser } from "../server/user-accounts";
import { resolveViewer } from "../server/user-identity";
import { createAdminSession } from "../server/admin-auth";

const base = process.env.TEST_BASE_URL;
const password = "http-session-password";
async function account() {
  const username = "hs_" + randomUUID().replaceAll("-", "").slice(0, 20);
  const auth = await registerUser({ username, password, nickname: "Member" });
  const viewer = await resolveViewer(auth.token);
  return { username, viewer, cookie: "party_user=" + auth.token };
}
async function send(
  path: string,
  method: string,
  cookie = "",
  scope = "",
  data?: unknown,
  userAgent?: string,
) {
  return fetch(base + path, {
    method,
    headers: {
      Origin: base!,
      Cookie: cookie,
      "X-Identity-Scope": scope,
      "Content-Type": "application/json",
      ...(userAgent ? { "User-Agent": userAgent } : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
}

test(
  "HTTP session management validates pages, isolates users and hides credentials",
  { skip: !base },
  async () => {
    const a = await account(),
      b = await account();
    try {
      const login = await send(
        "/api/user/session",
        "POST",
        "",
        "",
        { username: a.username, password },
        "Mozilla/5.0 (Macintosh) Version/18.0 Safari/605.1 secret=value",
      );
      assert.equal(login.status, 200);
      const otherCookie = login.headers.get("set-cookie")!.split(";")[0];
      const response = await send("/api/user/sessions", "GET", a.cookie);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const page = (await response.json()).data;
      assert.equal(page.total, 2);
      assert.equal(page.pageSize, 20);
      const target = page.items.find(
        (item: { current: boolean }) => !item.current,
      );
      assert.equal(target.browser, "Safari");
      assert.equal(target.os, "macOS");
      assert.match(target.id, /^[a-f0-9-]{36}$/);
      assert.equal(JSON.stringify(page).includes("secret=value"), false);
      assert.equal(JSON.stringify(page).includes(a.viewer.sessionHash!), false);
      assert.equal(
        JSON.stringify(page).includes(a.viewer.user!.identityKey),
        false,
      );
      for (const query of [
        "page=0",
        "page=01",
        "page=1&page=2",
        "page=1.2",
        "page=100001",
      ])
        assert.equal(
          (await send("/api/user/sessions?" + query, "GET", a.cookie)).status,
          400,
        );
      assert.equal(
        (
          await (
            await send("/api/user/sessions?page=999", "GET", a.cookie)
          ).json()
        ).data.page,
        1,
      );
      for (const cookie of [
        "",
        "party_user=invalid",
        "party_identity=" + "a".repeat(64),
        "party_admin=" + createAdminSession(1, 0),
      ])
        assert.equal(
          (await send("/api/user/sessions", "GET", cookie)).status,
          401,
        );
      const bPage = (
        await (await send("/api/user/sessions", "GET", b.cookie)).json()
      ).data;
      assert.equal(bPage.total, 1);
      const forbidden = await send(
        "/api/user/sessions/" + bPage.items[0].id,
        "DELETE",
        a.cookie,
        a.viewer.scope,
      );
      assert.deepEqual((await forbidden.json()).data, {
        revoked: true,
        current: false,
      });
      const revoked = await send(
        "/api/user/sessions/" + target.id,
        "DELETE",
        a.cookie,
        a.viewer.scope,
      );
      assert.equal(revoked.status, 200);
      assert.equal(revoked.headers.get("set-cookie"), null);
      assert.deepEqual((await revoked.json()).data, {
        revoked: true,
        current: false,
      });
      assert.equal(
        (await send("/api/user/sessions", "GET", otherCookie)).status,
        401,
      );
      assert.equal(
        (await send("/api/user/sessions", "GET", a.cookie)).status,
        200,
      );
      assert.equal(
        (await send("/api/user/sessions", "GET", b.cookie)).status,
        200,
      );
      const again = await send(
        "/api/user/sessions/" + target.id,
        "DELETE",
        a.cookie,
        a.viewer.scope,
      );
      assert.deepEqual((await again.json()).data, {
        revoked: true,
        current: false,
      });
      const current = page.items.find(
        (item: { current: boolean }) => item.current,
      );
      const self = await send(
        "/api/user/sessions/" + current.id,
        "DELETE",
        a.cookie,
        a.viewer.scope,
      );
      assert.deepEqual((await self.json()).data, {
        revoked: true,
        current: true,
      });
      assert.match(self.headers.get("set-cookie")!, /party_user=;/);
      assert.equal(
        (await send("/api/user/sessions", "GET", a.cookie)).status,
        401,
      );
    } finally {
      await db.user.deleteMany({
        where: { id: { in: [a.viewer.user!.id, b.viewer.user!.id] } },
      });
    }
  },
);

test(
  "HTTP single-session mutations enforce origin, scope and fixed rate-limit bucket",
  { skip: !base },
  async () => {
    const a = await account();
    try {
      const badOrigin = await fetch(
        base + "/api/user/sessions/" + randomUUID(),
        {
          method: "DELETE",
          headers: {
            Cookie: a.cookie,
            Origin: "https://invalid.example",
            "X-Identity-Scope": a.viewer.scope,
          },
        },
      );
      assert.equal(badOrigin.status, 403);
      assert.equal(
        (
          await send(
            "/api/user/sessions/" + randomUUID(),
            "DELETE",
            a.cookie,
            "wrong-scope",
          )
        ).status,
        409,
      );
      assert.equal(
        (
          await send(
            "/api/user/sessions/not-a-uuid",
            "DELETE",
            a.cookie,
            a.viewer.scope,
          )
        ).status,
        400,
      );
      for (let i = 0; i < 3; i++)
        assert.equal(
          (
            await send(
              "/api/user/sessions/" + randomUUID(),
              "DELETE",
              a.cookie,
              a.viewer.scope,
            )
          ).status,
          200,
        );
      const limited = await send(
        "/api/user/sessions/" + randomUUID(),
        "DELETE",
        a.cookie,
        a.viewer.scope,
      );
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get("retry-after")) > 0);
      assert.equal(
        (await send("/api/user/sessions", "GET", a.cookie)).status,
        200,
      );
    } finally {
      await db.user.delete({ where: { id: a.viewer.user!.id } });
    }
  },
);

test(
  "HTTP session list rejects newly forced password changes and disabled users",
  { skip: !base },
  async () => {
    const a = await account();
    try {
      await db.user.update({
        where: { id: a.viewer.user!.id },
        data: { mustChangePassword: true },
      });
      assert.equal(
        (await send("/api/user/sessions", "GET", a.cookie)).status,
        401,
      );
      assert.equal(
        (
          await send(
            "/api/user/sessions/" + randomUUID(),
            "DELETE",
            a.cookie,
            a.viewer.scope,
          )
        ).status,
        401,
      );
      await db.user.update({
        where: { id: a.viewer.user!.id },
        data: { isActive: false },
      });
      assert.equal(
        (await send("/api/user/sessions", "GET", a.cookie)).status,
        401,
      );
    } finally {
      await db.user.delete({ where: { id: a.viewer.user!.id } });
    }
  },
);
