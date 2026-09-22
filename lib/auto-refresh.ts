export type RefreshBrowser = {
  document: Pick<
    Document,
    "visibilityState" | "addEventListener" | "removeEventListener"
  >;
  window: Pick<
    Window,
    "addEventListener" | "removeEventListener" | "setInterval" | "clearInterval"
  >;
  navigator: Pick<Navigator, "onLine">;
};
export function startAutoRefresh(
  refresh: () => void,
  isBusy: () => boolean,
  browser: RefreshBrowser,
  now: () => number = Date.now,
) {
  let last = -Infinity;
  const update = () => {
    if (
      browser.document.visibilityState !== "visible" ||
      !browser.navigator.onLine ||
      isBusy() ||
      now() - last < 1000
    )
      return;
    last = now();
    refresh();
  };
  const timer = browser.window.setInterval(update, 15000);
  browser.window.addEventListener("focus", update);
  browser.window.addEventListener("online", update);
  browser.document.addEventListener("visibilitychange", update);
  return () => {
    browser.window.clearInterval(timer);
    browser.window.removeEventListener("focus", update);
    browser.window.removeEventListener("online", update);
    browser.document.removeEventListener("visibilitychange", update);
  };
}
