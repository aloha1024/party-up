export type RefreshBrowser = {
  document: Pick<
    Document,
    "visibilityState" | "addEventListener" | "removeEventListener"
  >;
  window: Pick<
    Window,
    "addEventListener" | "removeEventListener" | "setTimeout" | "clearTimeout"
  >;
  navigator: Pick<Navigator, "onLine">;
};
export type RefreshSnapshot = {
  sample: string;
  signature: string;
  scope: string;
  scheduledAt: number[];
  paused: boolean;
  pending: boolean;
};

// A new server sample acknowledges a successful read, even when data is unchanged.
// Transition completion alone is not evidence of a successful refresh.
export function startAutoRefresh(
  refresh: () => void,
  initial: RefreshSnapshot,
  browser: RefreshBrowser,
  fixed = false,
  now: () => number = Date.now,
  random: () => number = Math.random,
) {
  let snapshot = initial;
  let interval = 15000;
  let last = -Infinity;
  let flight = false;
  let observedPending = false;
  let canBackoff = false;
  let stopped = false;
  let timer: number | undefined;
  const boundary = () =>
    Math.min(...snapshot.scheduledAt.filter((at) => at > now()));
  let nextBoundary = boundary();
  const clear = () => {
    if (timer !== undefined) browser.window.clearTimeout(timer);
    timer = undefined;
  };
  const visible = () =>
    browser.document.visibilityState === "visible" && browser.navigator.onLine;
  function schedule() {
    clear();
    if (stopped || !visible() || snapshot.paused || snapshot.pending) return;
    const jitter =
      (flight ? 15000 : interval) *
      (1 - 0.1 * Math.max(0, Math.min(1, random())));
    const delay = Math.max(
      0,
      1000 - (now() - last),
      Math.min(jitter, nextBoundary - now()),
    );
    timer = browser.window.setTimeout(tick, delay);
  }
  function tick(allowBackoff = true) {
    timer = undefined;
    if (stopped || !visible() || snapshot.paused || snapshot.pending) return;
    // If no transition/sample arrived before this timer, retry at the base cadence.
    if (flight) {
      flight = false;
      interval = 15000;
    }
    if (now() - last < 1000) {
      schedule();
      return;
    }
    if (nextBoundary <= now()) nextBoundary = Infinity;
    last = now();
    flight = true;
    observedPending = false;
    canBackoff = allowBackoff;
    refresh();
    schedule();
  }
  function resume() {
    interval = 15000;
    canBackoff = false;
    clear();
    if (visible() && !snapshot.paused && !snapshot.pending && !flight)
      tick(false);
    else schedule();
  }
  browser.window.addEventListener("focus", resume);
  browser.window.addEventListener("online", resume);
  browser.window.addEventListener("offline", resume);
  browser.document.addEventListener("visibilitychange", resume);
  schedule();
  return {
    update(next: RefreshSnapshot) {
      if (stopped) return;
      const previous = snapshot;
      snapshot = next;
      const scopeChanged = previous.scope !== next.scope;
      const operationChanged = previous.paused !== next.paused;
      const sampleChanged = previous.sample !== next.sample;
      if (sampleChanged) {
        interval =
          !fixed &&
          flight &&
          canBackoff &&
          !scopeChanged &&
          !next.paused &&
          previous.signature === next.signature
            ? Math.min(60000, interval * 2)
            : 15000;
        flight = false;
        nextBoundary = boundary();
      }
      if (scopeChanged || operationChanged) {
        interval = 15000;
        canBackoff = false;
        if (scopeChanged) {
          flight = false;
          nextBoundary = boundary();
        }
      }
      if (flight && next.pending) observedPending = true;
      if (flight && observedPending && !next.pending) {
        flight = false;
        interval = 15000;
      }
      if (
        sampleChanged ||
        scopeChanged ||
        operationChanged ||
        previous.pending !== next.pending
      )
        schedule();
    },
    stop() {
      stopped = true;
      clear();
      browser.window.removeEventListener("focus", resume);
      browser.window.removeEventListener("online", resume);
      browser.window.removeEventListener("offline", resume);
      browser.document.removeEventListener("visibilitychange", resume);
    },
  };
}
