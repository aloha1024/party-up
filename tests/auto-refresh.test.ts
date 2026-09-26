import { test } from "node:test";
import assert from "node:assert/strict";
import {
  startAutoRefresh,
  type RefreshBrowser,
  type RefreshSnapshot,
} from "../lib/auto-refresh";

function harness(fixed = false, random = 0, scheduledAt: number[] = []) {
  const document = Object.assign(new EventTarget(), {
    visibilityState: "visible",
  });
  const navigator = { onLine: true };
  let now = 0,
    calls = 0,
    serial = 0;
  let timer: { id: number; at: number; fn: () => void } | undefined;
  const window = Object.assign(new EventTarget(), {
    setTimeout(fn: () => void, delay: number) {
      timer = { id: ++serial, at: now + delay, fn };
      return serial;
    },
    clearTimeout(id: number) {
      if (timer?.id === id) timer = undefined;
    },
  });
  let snapshot: RefreshSnapshot = {
    sample: "initial",
    signature: "data",
    scope: "page1",
    paused: false,
    pending: false,
    scheduledAt,
  };
  const driver = startAutoRefresh(
    () => calls++,
    snapshot,
    { window, document, navigator } as unknown as RefreshBrowser,
    fixed,
    () => now,
    () => random,
  );
  const update = (patch: Partial<RefreshSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    driver.update(snapshot);
  };
  return {
    document,
    navigator,
    window,
    driver,
    update,
    get calls() {
      return calls;
    },
    get delay() {
      return timer ? timer.at - now : undefined;
    },
    tick() {
      assert.ok(timer);
      const current = timer;
      timer = undefined;
      now = current.at;
      current.fn();
    },
    advance(ms: number) {
      now += ms;
    },
    success(signature = snapshot.signature) {
      update({ pending: true });
      update({ sample: String(++serial), signature, pending: false });
    },
  };
}

test("only successful unchanged samples back off; data, scope and operations reset cadence", () => {
  const h = harness();
  assert.equal(h.delay, 15000);
  h.tick();
  h.success();
  assert.equal(h.delay, 30000);
  h.tick();
  h.success();
  assert.equal(h.delay, 60000);
  h.tick();
  h.success();
  assert.equal(h.delay, 60000);
  h.tick();
  h.success("changed");
  assert.equal(h.delay, 15000);
  h.tick();
  h.success();
  h.update({ scope: "page2" });
  assert.equal(h.delay, 15000);
  h.tick();
  h.success();
  h.update({ paused: true });
  assert.equal(h.delay, undefined);
  h.update({ paused: false });
  assert.equal(h.delay, 15000);
  h.driver.stop();
  assert.equal(h.delay, undefined);
});

test("fixed detail cadence and jitter never exceed their upper bounds", () => {
  for (const random of [0, 0.5, 1]) {
    const h = harness(true, random);
    for (let i = 0; i < 4; i++) {
      assert.ok(h.delay! >= 13500 && h.delay! <= 15000);
      h.tick();
      h.success();
    }
    h.driver.stop();
  }
  const h = harness(false, 1);
  h.tick();
  h.success();
  assert.equal(h.delay, 27000);
  h.tick();
  h.success();
  assert.equal(h.delay, 54000);
  h.driver.stop();
});

test("failed transitions do not count as unchanged; in-flight refreshes never overlap", () => {
  const h = harness();
  h.tick();
  h.success();
  h.tick();
  h.update({ pending: true });
  assert.equal(h.delay, undefined);
  h.window.dispatchEvent(new Event("focus"));
  assert.equal(h.calls, 2);
  h.update({ pending: false });
  assert.equal(h.delay, 15000);
  h.tick();
  h.success("new");
  assert.equal(h.delay, 15000);
  h.driver.stop();
});

test("hidden/offline/operations pause timers; return refreshes once and teardown removes listeners", () => {
  const h = harness();
  h.document.visibilityState = "hidden";
  h.document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(h.delay, undefined);
  h.advance(20000);
  h.document.visibilityState = "visible";
  h.document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(h.calls, 1);
  h.window.dispatchEvent(new Event("focus"));
  assert.equal(h.calls, 1);
  h.success();
  assert.equal(h.delay, 15000);
  h.navigator.onLine = false;
  h.window.dispatchEvent(new Event("offline"));
  assert.equal(h.delay, undefined);
  h.advance(20000);
  h.navigator.onLine = true;
  h.window.dispatchEvent(new Event("online"));
  assert.equal(h.calls, 2);
  h.success();
  h.update({ paused: true });
  h.advance(20000);
  h.window.dispatchEvent(new Event("focus"));
  assert.equal(h.calls, 2);
  h.update({ paused: false });
  assert.equal(h.delay, 15000);
  h.driver.stop();
  h.window.dispatchEvent(new Event("focus"));
  h.window.dispatchEvent(new Event("online"));
  h.document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(h.calls, 2);
  assert.equal(h.delay, undefined);
});

test("visible start-time boundary wakes an idle list without repeatedly firing", () => {
  const h = harness(false, 0, [55000]);
  h.tick();
  h.success(); // 15s, then 30s
  h.tick();
  h.success(); // 45s, next should be the 55s boundary
  assert.equal(h.delay, 10000);
  h.tick();
  h.success("started");
  assert.equal(h.delay, 15000);
  h.driver.stop();
});
