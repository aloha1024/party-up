import { test, expect, type Page, type Route } from "@playwright/test";

async function burst(page: Page) {
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
}
async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
async function prepare(page: Page) {
  await page.goto("/account/login");
  await expect(
    page.getByRole("button", { name: "登录账号", exact: true }),
  ).toBeEnabled();
  await settle(page);
  const identity = (await (await page.request.get("/api/identity")).json())
    .data;
  const held: Route[] = [];
  await page.route("**/api/identity", async (route) => {
    expect(route.request().method()).toBe("GET");
    held.push(route);
  });
  return { held, identity };
}
async function release(page: Page, route: Route, data: unknown) {
  const response = page.waitForResponse((r) =>
    r.url().endsWith("/api/identity"),
  );
  await route.fulfill({ status: 200, json: { data } });
  await (await response).finished();
  await settle(page);
}

test("focus, online and visibility share pending checks without caching completed results", async ({
  page,
  context,
}) => {
  const { held, identity } = await prepare(page);
  await page.getByLabel("用户名", { exact: true }).fill("keep_input");
  await burst(page);
  await expect.poll(() => held.length).toBe(1);
  await burst(page);
  await settle(page);
  expect(held).toHaveLength(1);
  await release(page, held[0], identity);
  await burst(page);
  await expect.poll(() => held.length).toBe(2);
  await release(page, held[1], identity);

  await page.evaluate(() =>
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    }),
  );
  await burst(page);
  await settle(page);
  expect(held).toHaveLength(2);
  await page.evaluate(() =>
    Reflect.deleteProperty(document, "visibilityState"),
  );
  await context.setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  await burst(page);
  await settle(page);
  expect(held).toHaveLength(2);
  await context.setOffline(false);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
  await burst(page);
  await expect.poll(() => held.length).toBe(3);
  await release(page, held[2], identity);
  await expect(page.getByLabel("用户名", { exact: true })).toHaveValue(
    "keep_input",
  );
  await expect(
    page.getByText(
      "身份或登录状态已变化，原页面已关闭。请刷新后核对最新记录。",
    ),
  ).toHaveCount(0);
});

test("failed and malformed checks release the slot; fresh valid identity changes close the page", async ({
  page,
}) => {
  const { held, identity } = await prepare(page);
  await burst(page);
  await expect.poll(() => held.length).toBe(1);
  const failed = page.waitForEvent("requestfailed", (r) =>
    r.url().endsWith("/api/identity"),
  );
  await held[0].abort("failed");
  await failed;
  await settle(page);
  await burst(page);
  await expect.poll(() => held.length).toBe(2);
  await release(page, held[1], { scope: "invalid-payload" });
  await expect(
    page.getByRole("button", { name: "登录账号", exact: true }),
  ).toBeVisible();
  await burst(page);
  await expect.poll(() => held.length).toBe(3);
  await release(page, held[2], { ...identity, scope: "changed-scope" });
  await expect(
    page.getByRole("alert").filter({ hasText: "身份或登录状态已变化" }),
  ).toBeVisible();
  await burst(page);
  await settle(page);
  expect(held).toHaveLength(3);
});

test("cross-tab invalidation closes content immediately while a check is pending", async ({
  page,
}) => {
  const { held, identity } = await prepare(page);
  await burst(page);
  await expect.poll(() => held.length).toBe(1);
  await page.evaluate(() =>
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "party-identity-event",
        newValue: "other-tab",
      }),
    ),
  );
  await expect(
    page.getByRole("alert").filter({ hasText: "身份或登录状态已变化" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "登录账号", exact: true }),
  ).toHaveCount(0);
  await release(page, held[0], identity);
  await burst(page);
  await settle(page);
  expect(held).toHaveLength(1);
  await expect(
    page.getByRole("alert").filter({ hasText: "身份或登录状态已变化" }),
  ).toBeVisible();
});
