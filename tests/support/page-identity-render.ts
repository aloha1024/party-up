import "./isolated";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mock } from "node:test";
import { createElement, Fragment, type ReactNode } from "react";
import { db } from "../../server/db";
import { currentViewer } from "../../server/http";
import { currentPageViewer, pageIdentity } from "../../server/page-identity";
import {
  digest,
  memberToken,
  resolveViewer,
  type Viewer,
} from "../../server/user-identity";

const require = createRequire(import.meta.url);
const { renderToReadableStream } =
  require("next/dist/compiled/react-server-dom-webpack/server.node") as {
    renderToReadableStream(
      model: ReactNode,
      manifest?: object,
      options?: { onError(error: unknown): void },
    ): ReadableStream<Uint8Array>;
  };
type Jar = Record<string, string>;
const requests = new AsyncLocalStorage<Jar>();
mock.method(require("next/headers"), "cookies", async () => ({
  get: (name: string) => {
    const value = requests.getStore()?.[name];
    return value ? { value } : undefined;
  },
}));
const sessionRead = db.userSession.findUnique;
const guestRead = db.guestIdentity.findUnique;
let reads = { session: 0, guest: 0 };
let failNext = false;
db.userSession.findUnique = (async (...args) => {
  reads.session++;
  // Keep the lookup pending while sibling components and renders also run.
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (failNext) {
    failNext = false;
    throw new Error("Synthetic identity lookup failure");
  }
  return sessionRead.apply(db.userSession, args);
}) as typeof sessionRead;
db.guestIdentity.findUnique = (async (...args) => {
  reads.guest++;
  await new Promise<void>((resolve) => setImmediate(resolve));
  return guestRead.apply(db.guestIdentity, args);
}) as typeof guestRead;

async function render(jar: Jar, model: ReactNode) {
  return requests.run(jar, async () => {
    const errors: unknown[] = [];
    await new Response(
      renderToReadableStream(model, {}, { onError: (e) => errors.push(e) }),
    ).text();
    assert.deepEqual(errors, []);
  });
}

async function snapshot(jar: Jar) {
  const viewers: Viewer[] = [];
  const tokens: (string | undefined)[] = [];
  async function Layout() {
    const pending = currentPageViewer();
    assert.equal(pending, currentPageViewer());
    viewers.push(await pending);
    return createElement(Nested);
  }
  async function Nested() {
    viewers.push(await currentPageViewer());
    return null;
  }
  async function Page() {
    tokens.push(await pageIdentity());
    return null;
  }
  await render(
    jar,
    createElement(Fragment, null, createElement(Layout), createElement(Page)),
  );
  assert.equal(viewers.length, 2);
  assert.equal(viewers[0], viewers[1]);
  assert.equal(tokens.length, 1);
  return { viewer: viewers[0], token: tokens[0] };
}

const users: string[] = [];
const guest = randomBytes(32).toString("hex");
async function member(nickname: string) {
  const cookie = randomBytes(32).toString("hex");
  const user = await db.user.create({
    data: {
      username: "render_" + randomUUID(),
      nickname,
      passwordHash: "unused-test-fixture",
      sessions: {
        create: {
          id: digest(cookie),
          version: 0,
          expiresAt: new Date(Date.now() + 3600000),
        },
      },
    },
  });
  users.push(user.id);
  return { user, jar: { party_user: cookie, party_identity: guest } };
}
function resetReads() {
  reads = { session: 0, guest: 0 };
}
async function main() {
  try {
    const a = await member("First"),
      b = await member("Second");
    const first = await snapshot(a.jar);
    assert.equal(first.token, memberToken(a.user));
    assert.equal(first.viewer.user?.nickname, "First");
    assert.deepEqual(reads, { session: 1, guest: 0 });

    // Another HTTP render must read current database state even with the same cookie.
    await db.user.update({
      where: { id: a.user.id },
      data: { nickname: "New" },
    });
    assert.equal((await snapshot(a.jar)).viewer.user?.nickname, "New");
    assert.deepEqual(reads, { session: 2, guest: 0 });
    resetReads();
    const pair = await Promise.all([snapshot(a.jar), snapshot(b.jar)]);
    assert.equal(pair[0].token, memberToken(a.user));
    assert.equal(pair[1].token, memberToken(b.user));
    assert.deepEqual(reads, { session: 2, guest: 0 });

    resetReads();
    const guests = await Promise.all([
      snapshot({ party_identity: guest }),
      snapshot({}),
    ]);
    assert.equal(guests[0].token, guest);
    assert.equal(guests[1].viewer.mode, "anonymous");
    assert.deepEqual(reads, { session: 0, guest: 1 });
    await db.guestIdentity.create({
      data: { hash: digest(guest), retired: true },
    });
    assert.equal((await snapshot({ party_identity: guest })).token, undefined);

    await db.user.update({
      where: { id: a.user.id },
      data: { isActive: false },
    });
    const disabled = await snapshot(a.jar);
    assert.equal(disabled.viewer.mode, "invalid");
    assert.equal(disabled.token, undefined);
    await db.user.update({
      where: { id: a.user.id },
      data: { isActive: true, mustChangePassword: true },
    });
    const forced = await snapshot(a.jar);
    assert.equal(forced.viewer.mode, "user");
    assert.equal(forced.token, undefined);
    await db.user.update({
      where: { id: a.user.id },
      data: { mustChangePassword: false, version: { increment: 1 } },
    });
    assert.equal((await snapshot(a.jar)).viewer.mode, "invalid");
    await db.userSession.update({
      where: { id: digest(a.jar.party_user) },
      data: { version: 1, expiresAt: new Date(0) },
    });
    assert.equal((await snapshot(a.jar)).viewer.mode, "invalid");
    assert.equal(
      (await snapshot({ party_user: "invalid", party_identity: guest })).viewer
        .mode,
      "invalid",
    );

    // Raw readers remain fresh even when called from an active React render.
    resetReads();
    async function RawReads() {
      await currentPageViewer();
      await Promise.all([
        currentViewer(),
        currentViewer(),
        resolveViewer(b.jar.party_user),
        resolveViewer(b.jar.party_user),
      ]);
      return null;
    }
    await render(b.jar, createElement(RawReads));
    assert.deepEqual(reads, { session: 5, guest: 0 });

    // A rejected promise is shared in this render, never retained for the next one.
    resetReads();
    failNext = true;
    async function FailedReads() {
      const pending = currentPageViewer();
      assert.equal(pending, currentPageViewer());
      const results = await Promise.allSettled([pending, pageIdentity()]);
      assert.equal(results[0].status, "rejected");
      assert.equal(results[1].status, "rejected");
      if (results[0].status === "rejected" && results[1].status === "rejected")
        assert.equal(results[0].reason, results[1].reason);
      return null;
    }
    await render(b.jar, createElement(FailedReads));
    assert.deepEqual(reads, { session: 1, guest: 0 });
    assert.equal((await snapshot(b.jar)).token, memberToken(b.user));
    assert.deepEqual(reads, { session: 2, guest: 0 });
    console.log("RSC identity checks passed");
  } finally {
    db.userSession.findUnique = sessionRead;
    db.guestIdentity.findUnique = guestRead;
    mock.restoreAll();
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.guestIdentity.deleteMany({ where: { hash: digest(guest) } });
    await db.$disconnect();
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
