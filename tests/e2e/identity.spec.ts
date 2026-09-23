import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
async function fill(page: Page, name: string) {
  await page.getByLabel("游戏名称", { exact: true }).fill(name);
  await page
    .getByLabel("预约日期", { exact: true })
    .fill(new Date(Date.now() + 172800000).toISOString().slice(0, 10));
  await page.getByLabel("开玩时间 · 北京时间", { exact: true }).fill("20:00");
  await page.getByLabel("发起人昵称", { exact: true }).fill("Identity host");
}
test("two first-use tabs keep ownership after concurrent creation", async ({
  page,
  context,
}, info) => {
  let firstChecks = 0;
  let initializations = 0;
  let releaseChecks!: () => void;
  const bothTabsChecked = new Promise<void>((resolve) => {
    releaseChecks = resolve;
  });
  await context.route("**/api/identity", async (route) => {
    if (route.request().method() === "GET" && firstChecks < 2) {
      firstChecks++;
      if (firstChecks === 2) releaseChecks();
      // Both tabs must observe a missing identity before either can initialize it.
      await bothTabsChecked;
      await route.fulfill({
        status: 200,
        headers: { "Cache-Control": "no-store" },
        json: { data: { ready: false } },
      });
      return;
    }
    if (route.request().method() === "POST") {
      initializations++;
      // Keep the first cookie response pending so a missing mutex exposes the race.
      if (initializations === 1)
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await route.continue();
  });
  const second = await context.newPage();
  await Promise.all([
    page.goto("/reservation/new"),
    second.goto("/reservation/new"),
  ]);
  if (info.project.name === "http-fallback") {
    expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
    expect(await page.evaluate(() => !!navigator.locks)).toBe(false);
  }
  await Promise.all([
    fill(page, "First-" + randomUUID()),
    fill(second, "Second-" + randomUUID()),
  ]);
  await Promise.all([
    page.getByRole("button", { name: "创建预约，召集队友" }).click(),
    second.getByRole("button", { name: "创建预约，召集队友" }).click(),
  ]);
  for (const tab of [page, second]) {
    await expect(tab).toHaveURL(/\/reservation\/(?!new$)[a-z0-9-]+$/);
    await tab.reload();
    await expect(tab.getByText("你已在接龙名单中")).toBeVisible();
    await expect(tab.getByRole("link", { name: "编辑预约" })).toBeVisible();
  }
  expect(firstChecks).toBe(2);
  expect(initializations).toBe(1);
});
test("blocked cookies stop creation with actionable error", async ({
  page,
}) => {
  let mutations = 0;
  await page.route("**/api/identity", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({ status: 200, json: { data: { ready: true } } });
  });
  await page.route("**/api/reservations", async (route) => {
    mutations++;
    await route.continue();
  });
  await page.goto("/reservation/new");
  await fill(page, "Cookie-" + randomUUID());
  await page.getByRole("button", { name: "创建预约，召集队友" }).click();
  await expect(page.locator('form [role="alert"]')).toContainText(
    "允许本站 Cookie",
  );
  expect(mutations).toBe(0);
});
test("HTTP without local storage fails before issuing a new identity", async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== "http-fallback",
    "HTTP storage fallback only",
  );
  await page.addInitScript(() =>
    Object.defineProperty(window, "indexedDB", {
      get() {
        throw new Error("blocked");
      },
    }),
  );
  let initializations = 0;
  await page.route("**/api/identity", async (route) => {
    if (route.request().method() === "POST") initializations++;
    await route.continue();
  });
  await page.goto("/reservation/new");
  await fill(page, "Storage-" + randomUUID());
  await page.getByRole("button", { name: "创建预约，召集队友" }).click();
  await expect(page.locator('form [role="alert"]')).toContainText(
    "允许本站存储",
  );
  expect(initializations).toBe(0);
});

test("existing HTTP identity still creates when IndexedDB is blocked", async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== "http-fallback",
    "HTTP storage fallback only",
  );
  await page.goto("/reservation/new");
  // Use the browser's fetch: party-http.test is resolved by its launch options.
  const initialized = await page.evaluate(async () => {
    const response = await fetch("/api/identity", {
      method: "POST",
      credentials: "same-origin",
    });
    const check = await fetch("/api/identity", {
      cache: "no-store",
      credentials: "same-origin",
    });
    const result = await check.json();
    return { status: response.status, ready: result.data?.ready };
  });
  expect(initialized).toEqual({ status: 200, ready: true });
  await page.addInitScript(() =>
    Object.defineProperty(window, "indexedDB", {
      get() {
        throw new Error("blocked");
      },
    }),
  );
  let initializations = 0;
  await page.route("**/api/identity", async (route) => {
    if (route.request().method() === "POST") initializations++;
    await route.continue();
  });
  await page.reload();
  expect(await page.evaluate(() => !!navigator.locks)).toBe(false);
  expect(
    await page.evaluate(() => {
      try {
        void window.indexedDB;
        return false;
      } catch {
        return true;
      }
    }),
  ).toBe(true);
  await fill(page, "Existing-" + randomUUID());
  await page.getByRole("button", { name: "创建预约，召集队友" }).click();
  await expect(page).toHaveURL(/\/reservation\/(?!new$)[a-z0-9-]+$/);
  await expect(page.getByText("你已在接龙名单中")).toBeVisible();
  await expect(page.getByRole("link", { name: "编辑预约" })).toBeVisible();
  expect(initializations).toBe(0);
});
