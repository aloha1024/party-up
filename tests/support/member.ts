import "./isolated";
import { randomUUID, randomBytes } from "node:crypto";
import { db } from "../../server/db";
import { memberToken, digest } from "../../server/user-identity";
const sessions = new Map<string, string>();
export async function registeredToken() {
  const user = await db.user.create({
    data: {
      username: `u_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      nickname: "Member",
      passwordHash: "test-only-disabled-password",
    },
  });
  const token = randomBytes(32).toString("hex");
  await db.userSession.create({
    data: {
      id: digest(token),
      userId: user.id,
      version: 0,
      expiresAt: new Date(Date.now() + 86400000),
    },
  });
  sessions.set(memberToken(user), token);
  return memberToken(user);
}
export function testCookie(token: string) {
  return sessions.has(token)
    ? `party_user=${sessions.get(token)}`
    : `party_identity=${token}`;
}
export function browserCookie(token: string) {
  const [name, value] = testCookie(token).split("=");
  return { name, value };
}
// Existing HTTP regressions use this helper to supply the same current identity
// scope as the browser. Tests of missing/stale scopes deliberately use raw fetch.
export async function identityFetch(
  input: string | URL | Request,
  init?: RequestInit,
) {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const headers = new Headers(init?.headers);
  const cookie = headers.get("Cookie");
  if (cookie)
    headers.set(
      "Cookie",
      cookie.replace(/party_identity=(user:[a-f0-9-]{36})/g, (_, token) =>
        testCookie(token),
      ),
    );
  if (
    (init?.method ?? "GET") !== "GET" &&
    new URL(url).pathname.startsWith("/api/reservations") &&
    !headers.has("X-Identity-Scope")
  ) {
    const response = await globalThis.fetch(new URL("/api/identity", url), {
      headers: { Cookie: headers.get("Cookie") || "" },
    });
    const identity = await response.json();
    headers.set("X-Identity-Scope", identity.data.scope);
  }
  return globalThis.fetch(input, { ...init, headers });
}
