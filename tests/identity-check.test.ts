import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createIdentityCheck } from "../lib/identity-check";
import {
  getClientIdentity,
  getClientIdentityRevision,
  setClientIdentity,
} from "../lib/client-identity";
import { request } from "../lib/client-request";
import type { PublicIdentity } from "../lib/user-account";

const identity = (scope: string): PublicIdentity => ({
  scope,
  mode: "user",
  ready: true,
  storageKey: scope,
  user: { username: "user", nickname: "昵称", mustChangePassword: false },
  capabilities: {
    createInvitation: true,
    copyReservation: true,
    calendar: true,
  },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const reply = (scope = "A") => Response.json({ data: identity(scope) });
function setup(t: TestContext) {
  setClientIdentity(identity("A"));
  const calls: ReturnType<typeof deferred<Response>>[] = [];
  let visible = true,
    online = true,
    invalidations = 0,
    broadcasts = 0;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const events = new EventTarget();
  events.addEventListener("party-identity-stale", () => broadcasts++);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: events,
  });
  t.after(() => {
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  t.mock.method(globalThis, "fetch", (_url: unknown, init: RequestInit) => {
    assert.equal(_url, "/api/identity");
    assert.equal(init.method, "GET");
    assert.equal(init.cache, "no-store");
    const call = deferred<Response>();
    calls.push(call);
    return call.promise;
  });
  const make = () =>
    createIdentityCheck({
      canCheck: () => visible && online,
      invalidate: () => invalidations++,
    });
  return {
    calls,
    make,
    visible: (value: boolean) => {
      visible = value;
    },
    online: (value: boolean) => {
      online = value;
    },
    invalidations: () => invalidations,
    broadcasts: () => broadcasts,
  };
}

test("identity revision changes only with scope, including A to B to A", () => {
  setClientIdentity(identity("A"));
  const before = getClientIdentityRevision();
  setClientIdentity({ ...identity("A"), user: null });
  assert.equal(getClientIdentityRevision(), before);
  setClientIdentity(identity("B"));
  setClientIdentity(identity("A"));
  assert.equal(getClientIdentityRevision(), before + 2);
});

test("event bursts share only the current pending check, never a completed response", async (t) => {
  const f = setup(t),
    check = f.make();
  const first = check.check();
  assert.equal(check.check(), first);
  assert.equal(check.check(), first);
  await flush();
  assert.equal(f.calls.length, 1);
  f.calls[0].resolve(reply());
  await first;
  const second = check.check();
  assert.notEqual(second, first);
  await flush();
  assert.equal(f.calls.length, 2);
  f.calls[1].resolve(reply());
  await second;
  assert.equal(f.invalidations(), 0);
});

test("hidden and offline events skip requests; resumed checks do not initialize identity", async (t) => {
  const f = setup(t),
    check = f.make();
  f.visible(false);
  await check.check();
  f.visible(true);
  f.online(false);
  await check.check();
  assert.equal(f.calls.length, 0);
  f.online(true);
  const pending = check.check();
  await flush();
  f.calls[0].resolve(reply());
  await pending;
  assert.equal(f.calls.length, 1);
});

test("network errors, HTTP failures and invalid schemas release checks without invalidation or retry", async (t) => {
  const f = setup(t),
    check = f.make();
  for (let i = 0; i < 3; i++) {
    const pending = check.check();
    await flush();
    assert.equal(f.calls.length, i + 1);
    if (i === 0) f.calls[i].reject(new Error("offline"));
    else
      f.calls[i].resolve(
        i === 1
          ? Response.json({ error: "busy", code: "BUSY" }, { status: 503 })
          : Response.json({ data: { scope: "different-but-invalid" } }),
      );
    await pending;
    assert.equal(f.invalidations(), 0);
    assert.equal(f.broadcasts(), 0);
  }
  const pending = check.check();
  await flush();
  f.calls[3].resolve(reply());
  await pending;
});

test("changed identity closes the old page once without installing server identity", async (t) => {
  const f = setup(t),
    check = f.make();
  const pending = check.check();
  await flush();
  f.calls[0].resolve(reply("B"));
  await pending;
  assert.equal(f.invalidations(), 1);
  assert.equal(getClientIdentity()?.scope, "A");
  await check.check();
  assert.equal(f.calls.length, 1);
});

test("old completion cannot clear a newer identity's pending slot", async (t) => {
  const f = setup(t),
    check = f.make();
  const old = check.check();
  await flush();
  setClientIdentity(identity("B"));
  const fresh = check.check();
  await flush();
  f.calls[0].resolve(reply("unexpected"));
  await old;
  assert.equal(check.check(), fresh);
  assert.equal(f.invalidations(), 0);
  f.calls[1].resolve(reply("B"));
  await fresh;
  assert.equal(f.calls.length, 2);

  // The new identity may also finish first; the old response stays obsolete.
  const older = check.check();
  await flush();
  setClientIdentity(identity("C"));
  const newer = check.check();
  await flush();
  f.calls[3].resolve(reply("C"));
  await newer;
  f.calls[2].resolve(Response.json({ code: "USER_SESSION" }, { status: 401 }));
  await older;
  assert.equal(f.invalidations(), 0);
  assert.equal(f.broadcasts(), 0);
});

test("A to B to A invalidates late successful and session-error responses before side effects", async (t) => {
  const f = setup(t),
    check = f.make();
  for (const response of [
    reply("B"),
    Response.json({ code: "USER_SESSION" }, { status: 401 }),
    Response.json({ code: "IDENTITY_CHANGED" }, { status: 409 }),
  ]) {
    const pending = check.check();
    await flush();
    setClientIdentity(identity("B"));
    setClientIdentity(identity("A"));
    f.calls.at(-1)!.resolve(response);
    await pending;
    assert.equal(f.invalidations(), 0);
    assert.equal(f.broadcasts(), 0);
  }
});

test("disposed Effects cannot affect a replacement Effect or send further requests", async (t) => {
  const f = setup(t),
    oldCheck = f.make();
  const old = oldCheck.check();
  await flush();
  oldCheck.dispose();
  const freshCheck = f.make(),
    fresh = freshCheck.check();
  await flush();
  f.calls[0].resolve(Response.json({ code: "USER_SESSION" }, { status: 401 }));
  await old;
  await oldCheck.check();
  assert.equal(freshCheck.check(), fresh);
  assert.equal(f.broadcasts(), 0);
  f.calls[1].resolve(reply());
  await fresh;
  assert.equal(f.invalidations(), 0);
  const neverStarted = f.make();
  const queued = neverStarted.check();
  neverStarted.dispose();
  await queued;
  assert.equal(f.calls.length, 2);
});

test("timeout releases the slot and even a late response body cannot broadcast or apply data", async (t) => {
  const f = setup(t),
    check = f.make();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const lateBody of [
    { code: "USER_SESSION" },
    { code: "IDENTITY_CHANGED" },
  ]) {
    const pending = check.check();
    await flush();
    const body = deferred<unknown>();
    f.calls.at(-1)!.resolve({
      ok: false,
      status: 401,
      json: () => body.promise,
    } as Response);
    await flush();
    t.mock.timers.tick(15000);
    await pending;
    const fresh = check.check();
    await flush();
    body.resolve(lateBody);
    await flush();
    assert.equal(check.check(), fresh);
    assert.equal(f.broadcasts(), 0);
    f.calls.at(-1)!.resolve(reply());
    await fresh;
  }
  const pending = check.check();
  await flush();
  const late = f.calls.at(-1)!;
  t.mock.timers.tick(15000);
  await pending;
  late.resolve(reply("B"));
  await flush();
  assert.equal(f.invalidations(), 0);

  // Timeout itself closes the request guard, even if the caller stays current.
  const guarded = request("/api/identity", "GET", undefined, {
    isCurrent: () => true,
  });
  const rejection = assert.rejects(guarded, { code: "TIMEOUT" });
  const lateError = f.calls.at(-1)!;
  t.mock.timers.tick(15000);
  await rejection;
  lateError.resolve(Response.json({ code: "USER_SESSION" }, { status: 401 }));
  await flush();
  assert.equal(f.broadcasts(), 0);
});

test("request validity guard prevents sending obsolete checks; current session errors still notify", async (t) => {
  const f = setup(t);
  await assert.rejects(
    request("/api/identity", "GET", undefined, { isCurrent: () => false }),
    { serverCode: "IDENTITY_CHANGED" },
  );
  assert.equal(f.calls.length, 0);
  const check = f.make();
  const pending = check.check();
  await flush();
  f.calls[0].resolve(Response.json({ code: "USER_SESSION" }, { status: 401 }));
  await pending;
  assert.equal(f.broadcasts(), 1);
});
