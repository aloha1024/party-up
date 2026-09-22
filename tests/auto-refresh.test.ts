import { test } from "node:test";
import assert from "node:assert/strict";
import { startAutoRefresh, type RefreshBrowser } from "../lib/auto-refresh";
test("refresh pauses when hidden/offline/busy, resumes on return, deduplicates events and cleans up", () => {
  const document = Object.assign(new EventTarget(), {
    visibilityState: "visible",
  });
  const navigator = { onLine: true };
  let callback: (() => void) | undefined;
  let cleared = false,
    busy = false,
    calls = 0,
    now = 0;
  const window = Object.assign(new EventTarget(), {
    setInterval: (fn: () => void, interval: number) => {
      assert.equal(interval, 15000);
      callback = fn;
      return 1;
    },
    clearInterval: (id: number) => {
      assert.equal(id, 1);
      cleared = true;
    },
  });
  const stop = startAutoRefresh(
    () => calls++,
    () => busy,
    { window, document, navigator } as unknown as RefreshBrowser,
    () => now,
  );
  const tick = () => {
    now += 15000;
    callback!();
  };
  tick();
  assert.equal(calls, 1);
  document.visibilityState = "hidden";
  tick();
  window.dispatchEvent(new Event("focus"));
  assert.equal(calls, 1);
  document.visibilityState = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(calls, 2);
  window.dispatchEvent(new Event("focus"));
  assert.equal(calls, 2);
  navigator.onLine = false;
  tick();
  assert.equal(calls, 2);
  navigator.onLine = true;
  window.dispatchEvent(new Event("online"));
  assert.equal(calls, 3);
  busy = true;
  tick();
  window.dispatchEvent(new Event("focus"));
  assert.equal(calls, 3);
  busy = false;
  tick();
  assert.equal(calls, 4);
  stop();
  assert.equal(cleared, true);
  now += 15000;
  window.dispatchEvent(new Event("focus"));
  window.dispatchEvent(new Event("online"));
  document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(calls, 4);
});
