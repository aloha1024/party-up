import "./support/isolated";
import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { NextRequest } from "next/server";
import { db } from "../server/db";
import { respond } from "../server/http";
import {
  digest,
  GUEST_COOKIE,
  USER_COOKIE,
  resolveViewer,
  publicViewer,
  viewerContext,
} from "../server/user-identity";
import { registerUser } from "../server/user-accounts";
import { writeTransaction } from "../server/request-budget";
import {
  GET as identityGet,
  POST as identityPost,
} from "../app/api/identity/route";
import {
  GET as userGet,
  POST as userPost,
  PATCH as userPatch,
  DELETE as userDelete,
} from "../app/api/user/[...action]/route";

const require = createRequire(import.meta.url);
const origin = "http://identity-query.test";
const secret = () => randomBytes(32).toString("hex");
const users: string[] = [];
const guests: string[] = [];
const cookieContext = new AsyncLocalStorage<Map<string, string>>();
const password = "identity-query-password";
const username = () => "query_" + randomUUID().replaceAll("-", "").slice(0, 20);

after(async () => {
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.guestIdentity.deleteMany({ where: { hash: { in: guests } } });
  await db.$disconnect();
});

function mockCookies(t: TestContext) {
  t.mock.method(require("next/headers"), "cookies", async () => {
    const jar = cookieContext.getStore();
    assert.ok(jar, "Every route call needs its own request cookie jar");
    return {
      get: (name: string) =>
        jar.has(name) ? { name, value: jar.get(name)! } : undefined,
      set: (name: string, value: string) => jar.set(name, value),
      delete: (name: string) => jar.delete(name),
    };
  });
}

function request(
  path: string,
  method = "GET",
  input?: unknown,
  scope?: string,
) {
  return new NextRequest(origin + path, {
    method,
    headers: {
      Host: new URL(origin).host,
      Origin: origin,
      "Content-Type": "application/json",
      ...(scope ? { "X-Identity-Scope": scope } : {}),
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
}

function callIdentity(jar: Map<string, string>, method = "GET") {
  return cookieContext.run(jar, () =>
    (method === "GET" ? identityGet : identityPost)(
      request("/api/identity", method),
    ),
  );
}

function callUser(
  jar: Map<string, string>,
  action: string,
  method = "GET",
  input?: unknown,
  scope?: string,
) {
  const route =
    method === "GET"
      ? userGet
      : method === "POST"
        ? userPost
        : method === "PATCH"
          ? userPatch
          : userDelete;
  return cookieContext.run(jar, () =>
    route(request("/api/user/" + action, method, input, scope), {
      params: Promise.resolve({ action: action.split("/") }),
    }),
  );
}

async function seedUser() {
  const user = await db.user.create({
    data: { username: username(), nickname: "Member", passwordHash: "unused" },
  });
  users.push(user.id);
  const token = secret();
  await db.userSession.create({
    data: {
      id: digest(token),
      userId: user.id,
      version: user.version,
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  return { user, token };
}

// These counters measure initial resolver delegate calls, not SQL statements.
// Session resolution includes a related user; transaction guards use tx delegates.
function trackReads(t: TestContext) {
  const originalSessions = db.userSession.findUnique;
  const originalGuest = db.guestIdentity.findUnique;
  const sessions = t.mock.fn(originalSessions.bind(db.userSession));
  const guest = t.mock.fn(originalGuest.bind(db.guestIdentity));
  db.userSession.findUnique = sessions;
  db.guestIdentity.findUnique = guest;
  t.after(() => {
    db.userSession.findUnique = originalSessions;
    db.guestIdentity.findUnique = originalGuest;
  });
  return () => [sessions.mock.callCount(), guest.mock.callCount()];
}

test("identity and account GETs resolve each request once without reusing another request's state", async (t) => {
  mockCookies(t);
  const member = await seedUser();
  const guest = secret();
  const counts = trackReads(t);
  const cases = [
    { jar: new Map<string, string>(), mode: "anonymous", reads: [0, 0] },
    { jar: new Map([[GUEST_COOKIE, guest]]), mode: "guest", reads: [0, 1] },
    {
      jar: new Map([[USER_COOKIE, member.token]]),
      mode: "user",
      reads: [1, 0],
    },
    {
      jar: new Map([
        [USER_COOKIE, "invalid"],
        [GUEST_COOKIE, guest],
      ]),
      mode: "invalid",
      reads: [0, 0],
    },
    {
      jar: new Map([
        [USER_COOKIE, secret()],
        [GUEST_COOKIE, guest],
      ]),
      mode: "invalid",
      reads: [1, 0],
    },
  ];
  for (const fixture of cases) {
    for (const call of [
      callIdentity,
      (jar: Map<string, string>) => callUser(jar, "session"),
    ]) {
      const before = counts();
      const response = await call(fixture.jar);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal((await response.json()).data.mode, fixture.mode);
      assert.deepEqual(
        counts().map((n, i) => n - before[i]),
        fixture.reads,
      );
    }
  }
  // A subsequent request sees changes even when its session cookie is unchanged.
  await db.user.update({
    where: { id: member.user.id },
    data: { isActive: false },
  });
  assert.equal(
    (await (await callIdentity(cases[2].jar)).json()).data.mode,
    "invalid",
  );
});

test("identity POST reuses existing viewers and resolves a newly issued guest cookie freshly", async (t) => {
  mockCookies(t);
  const member = await seedUser();
  const guest = secret();
  const counts = trackReads(t);
  for (const [cookie, token, expected] of [
    [GUEST_COOKIE, guest, [0, 1]],
    [USER_COOKIE, member.token, [1, 0]],
  ] as const) {
    const jar = new Map([[cookie, token]]);
    const before = counts();
    const response = await callIdentity(jar, "POST");
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.ready, true);
    assert.deepEqual(
      counts().map((n, i) => n - before[i]),
      expected,
    );
    assert.equal(jar.size, 1);
    assert.equal(jar.get(cookie), token);
  }
  for (const retired of [false, true]) {
    const previous = secret();
    const jar = new Map<string, string>();
    if (retired) {
      guests.push(digest(previous));
      await db.guestIdentity.create({
        data: { hash: digest(previous), retired: true, version: 1 },
      });
      jar.set(GUEST_COOKIE, previous);
    }
    const before = counts();
    const response = await callIdentity(jar, "POST");
    const result = (await response.json()).data;
    const issued = jar.get(GUEST_COOKIE)!;
    assert.equal(response.status, 200);
    assert.match(issued, /^[a-f0-9]{64}$/);
    assert.notEqual(issued, previous);
    assert.equal(result.mode, "guest");
    assert.equal(result.ready, true);
    assert.deepEqual(
      counts().map((n, i) => n - before[i]),
      [0, retired ? 2 : 1],
    );
    assert.deepEqual(
      result,
      publicViewer(await resolveViewer(undefined, issued)),
    );
  }
});

test("account cookie mutations return the new viewer and limited accounts can still change passwords", async (t) => {
  mockCookies(t);
  const guest = secret();
  // Invalid account cookies must not stop explicit registration or leak into its response.
  const jar = new Map([
    [USER_COOKIE, secret()],
    [GUEST_COOKIE, guest],
  ]);
  const counts = trackReads(t);
  const firstName = username();
  let before = counts();
  let response = await callUser(jar, "register", "POST", {
    username: firstName,
    nickname: "First",
    password,
  });
  assert.equal(response.status, 200);
  // Initial missing session plus the new session; invalid accounts never fall back to guests.
  assert.deepEqual(
    counts().map((n, i) => n - before[i]),
    [2, 0],
  );
  const first = (await response.json()).data.identity;
  const firstToken = jar.get(USER_COOKIE)!;
  const firstUser = await db.user.findUniqueOrThrow({
    where: { username: firstName },
  });
  users.push(firstUser.id);
  assert.equal(first.mode, "user");
  assert.equal(first.user.username, firstName);
  assert.deepEqual(first, (await (await callIdentity(jar)).json()).data);

  response = await callUser(
    jar,
    "profile",
    "PATCH",
    { nickname: "Changed" },
    first.scope,
  );
  assert.equal(response.status, 200);
  assert.equal(
    (await (await callUser(jar, "session")).json()).data.user.nickname,
    "Changed",
  );
  const secondName = username();
  const second = await registerUser({
    username: secondName,
    nickname: "Second",
    password,
  });
  const secondUser = await db.user.findUniqueOrThrow({
    where: { username: secondName },
  });
  users.push(secondUser.id);
  before = counts();
  response = await callUser(jar, "session", "POST", {
    username: secondName,
    password,
  });
  assert.equal(response.status, 200);
  // The request identity and the replacement session each resolve once.
  assert.deepEqual(
    counts().map((n, i) => n - before[i]),
    [2, 0],
  );
  const signedIn = (await response.json()).data.identity;
  assert.equal(signedIn.user.username, secondName);
  assert.notEqual(signedIn.scope, first.scope);
  assert.notEqual(jar.get(USER_COOKIE), firstToken);
  assert.equal(
    await db.userSession.findUnique({ where: { id: digest(firstToken) } }),
    null,
  );
  assert.deepEqual(signedIn, (await (await callIdentity(jar)).json()).data);

  response = await callUser(
    jar,
    "session",
    "DELETE",
    undefined,
    signedIn.scope,
  );
  assert.equal(response.status, 200);
  assert.equal(jar.has(USER_COOKIE), false);
  assert.equal((await (await callIdentity(jar)).json()).data.mode, "guest");
  jar.set(USER_COOKIE, second.token);
  before = counts();
  response = await callUser(jar, "recovery/reset", "POST", {
    username: secondName,
    recoveryCode: second.recoveryCode,
    password: password + "new",
  });
  assert.equal(response.status, 200);
  // Recovery revokes the account; its response freshly resolves the retained guest.
  assert.deepEqual(
    counts().map((n, i) => n - before[i]),
    [1, 1],
  );
  const recovered = (await response.json()).data.identity;
  assert.equal(jar.has(USER_COOKIE), false);
  assert.equal(recovered.mode, "guest");
  assert.deepEqual(recovered, (await (await callIdentity(jar)).json()).data);
  assert.equal(
    await db.userSession.count({ where: { userId: secondUser.id } }),
    0,
  );

  await db.user.update({
    where: { id: secondUser.id },
    data: { mustChangePassword: true },
  });
  response = await callUser(jar, "session", "POST", {
    username: secondName,
    password: password + "new",
  });
  assert.equal(response.status, 200);
  const limited = (await response.json()).data.identity;
  assert.equal(limited.ready, false);
  assert.equal(limited.user.mustChangePassword, true);
  response = await callUser(
    jar,
    "password",
    "POST",
    { currentPassword: password + "new", password },
    limited.scope,
  );
  assert.equal(response.status, 200);
  assert.equal(jar.has(USER_COOKIE), false);
  assert.equal(
    (await db.user.findUniqueOrThrow({ where: { id: secondUser.id } }))
      .mustChangePassword,
    false,
  );
  assert.equal(
    await db.userSession.count({ where: { userId: secondUser.id } }),
    0,
  );
});

test("concurrent response callbacks receive independent viewers without installing a write guard for reads", async (t) => {
  mockCookies(t);
  const a = await seedUser(),
    b = await seedUser();
  let arrivals = 0;
  let release!: () => void;
  const both = new Promise<void>((resolve) => {
    release = resolve;
  });
  const results = await Promise.all(
    [a, b].map(({ token }) =>
      cookieContext.run(new Map([[USER_COOKIE, token]]), () =>
        respond(
          request("/api/user/session"),
          async (identity, viewer) => {
            arrivals++;
            if (arrivals === 2) release();
            await both;
            assert.equal(viewerContext.getStore(), undefined);
            assert.equal(identity, viewer.token);
            return publicViewer(viewer);
          },
          false,
        ),
      ),
    ),
  );
  for (const [i, response] of results.entries()) {
    assert.equal(response.status, 200);
    assert.equal(
      (await response.json()).data.user.username,
      [a, b][i].user.username,
    );
  }
});

test("initial viewer reuse cannot bypass transaction checks after session revocation, disable or guest linking", async (t) => {
  mockCookies(t);
  for (const action of ["revoke", "disable"] as const) {
    const member = await seedUser();
    const viewer = await resolveViewer(member.token);
    let wrote = false;
    const response = await cookieContext.run(
      new Map([[USER_COOKIE, member.token]]),
      () =>
        respond(
          request("/api/reservations", "POST", {}, viewer.scope),
          async () => {
            // Simulate the competing change after respond has resolved this request.
            if (action === "revoke")
              await db.userSession.delete({
                where: { id: digest(member.token) },
              });
            else
              await db.user.update({
                where: { id: member.user.id },
                data: { isActive: false },
              });
            return writeTransaction(async () => {
              wrote = true;
              return true;
            });
          },
        ),
    );
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, "USER_SESSION");
    assert.equal(wrote, false);
  }
  for (const retired of [false, true]) {
    const token = secret(),
      hash = digest(token);
    guests.push(hash);
    const viewer = await resolveViewer(undefined, token);
    let wrote = false;
    const response = await cookieContext.run(
      new Map([[GUEST_COOKIE, token]]),
      () =>
        respond(
          request("/api/reservations", "POST", {}, viewer.scope),
          async () => {
            // Both partial and full claims increment the guest identity version.
            await db.guestIdentity.create({
              data: { hash, version: 1, retired },
            });
            return writeTransaction(async () => {
              wrote = true;
              return true;
            });
          },
        ),
    );
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "IDENTITY_CHANGED");
    assert.equal(wrote, false);
  }
});
