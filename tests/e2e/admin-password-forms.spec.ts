import "../support/isolated";
import {
  test,
  expect,
  type BrowserContext,
  type Locator,
  type Page,
  type Request,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { db } from "../../server/db";
import { ensureAdminRecord } from "../../server/admin";
import {
  ADMIN_COOKIE,
  createAdminSession,
  hashPassword,
  verifyPasswordHash,
} from "../../server/admin-auth";

const name = () => "form_" + randomUUID().replaceAll("-", "").slice(0, 18);
const secret = () => "Fake-" + randomUUID();
const releases = new Set<() => void>();
const routeCancels = new Map<Page, Set<() => void>>();
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.add(release);
  return { promise, release };
}
async function administrator(firstLogin = false) {
  await ensureAdminRecord(); // Never consume the isolated root's ID or first-login flow.
  const password = secret();
  const record = await db.adminCredential.create({
    data: {
      username: name(),
      passwordHash: await hashPassword(password),
      mustChangePassword: firstLogin,
    },
  });
  return { ...record, password };
}
async function cleanAdministrator(id: number) {
  await db.adminAuditLog.deleteMany({
    where: {
      OR: [{ actorId: id }, { targetType: "admin", targetId: String(id) }],
    },
  });
  await db.adminCredential.deleteMany({ where: { id } });
}
async function authenticate(
  context: BrowserContext,
  admin: { id: number; sessionVersion: number },
) {
  await context.addCookies([
    {
      name: ADMIN_COOKIE,
      value: createAdminSession(admin.id, admin.sessionVersion),
      url: process.env.TEST_BASE_URL!,
    },
  ]);
}
async function withOwner(
  task: (owner: Awaited<ReturnType<typeof ensureAdminRecord>>) => Promise<void>,
) {
  const owner = await ensureAdminRecord();
  await db.adminCredential.update({
    where: { id: owner.id },
    data: { mustChangePassword: false },
  });
  try {
    await task(owner);
  } finally {
    // Preserve bootstrap password, session version and the original first-login test.
    await db.adminCredential.update({
      where: { id: owner.id },
      data: { mustChangePassword: owner.mustChangePassword },
    });
  }
}
const formWith = (page: Page, heading: string, includeHidden = false) =>
  page.locator("form").filter({
    has: page.getByRole("heading", {
      name: heading,
      exact: true,
      includeHidden,
    }),
  });
async function noScriptNotice(page: Page) {
  const notice = page
    .locator("noscript p:visible")
    .filter({
      hasText: "密码操作需要启用 JavaScript",
    })
    .first();
  await expect(notice).toContainText(
    "密码操作需要启用 JavaScript，请启用后刷新页面。",
  );
  await expect(notice).toBeVisible();
}
async function disabledFields(form: Locator) {
  await expect(form.locator("fieldset")).toHaveJSProperty("disabled", true);
  for (const input of await form.locator("input").all())
    await expect(input).toBeDisabled();
  for (const button of await form.locator("button").all())
    await expect(button).toBeDisabled();
}
function guardUrls(page: Page, secrets: string[]) {
  const urls: string[] = [];
  page.on("request", (request) => urls.push(request.url()));
  return () => {
    for (const url of [...urls, page.url()]) {
      for (const value of secrets) {
        expect(decodeURIComponent(url)).not.toContain(value);
      }
    }
  };
}
async function holdWrite(page: Page, url: string, method: string) {
  const deferred = gate();
  const requests: Request[] = [];
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    deferred.release();
  };
  const cleanups = routeCancels.get(page) ?? new Set<() => void>();
  cleanups.add(cancel);
  routeCancels.set(page, cleanups);
  await page.route(url, async (route) => {
    if (route.request().method() !== method) return route.continue();
    requests.push(route.request());
    await deferred.promise;
    if (cancelled) return route.abort();
    // Await the real server result so cleanup cannot race a committed write.
    const response = await route.fetch();
    await route.fulfill({ response });
  });
  return { requests, release: deferred.release };
}
async function closePage(page: Page) {
  for (const cancel of routeCancels.get(page) ?? []) cancel();
  await page.unrouteAll({ behavior: "wait" });
  await page.close();
  routeCancels.delete(page);
}
async function fillNewPassword(
  form: Locator,
  password: string,
  confirmation = password,
) {
  await form.getByLabel(/^新密码/).fill(password);
  await form.getByLabel("确认新密码", { exact: true }).fill(confirmation);
}

test.afterEach(async () => {
  for (const page of routeCancels.keys()) await closePage(page);
  for (const release of releases) release();
  releases.clear();
});
test.afterAll(() => db.$disconnect());

test("without JavaScript password forms use POST, remain disabled and explain how to enable them", async ({
  browser,
  page,
}) => {
  const admin = await administrator();
  const user = await db.user.create({
    data: {
      username: name(),
      nickname: "无脚本密码表单测试",
      passwordHash: await hashPassword(secret()),
    },
  });
  try {
    await withOwner(async (owner) => {
      for (const scenario of [
        { path: "/admin", heading: "管理员登录", admin: undefined },
        { path: "/admin/password", heading: "修改管理员密码", admin },
        { path: "/admin/accounts", heading: "创建管理员", admin: owner },
      ]) {
        const context = await browser.newContext({
          baseURL: process.env.TEST_BASE_URL,
          viewport: page.viewportSize(),
          javaScriptEnabled: false,
        });
        try {
          if (scenario.admin) await authenticate(context, scenario.admin);
          const view = await context.newPage();
          const value = secret(),
            assertSafeUrls = guardUrls(view, [value]);
          let navigations = 0;
          view.on("request", (request) => {
            if (request.isNavigationRequest()) navigations++;
          });
          await view.goto(scenario.path);
          // Dynamic pages can retain the no-script loading boundary while the
          // streamed form is hidden. Its native submission protections still apply.
          const form = formWith(view, scenario.heading, true);
          await expect(form).toHaveAttribute("method", "post");
          await disabledFields(form);
          await noScriptNotice(view);
          await form
            .locator('input[type="password"]')
            .first()
            .evaluate((input, password) => {
              (input as HTMLInputElement).value = password;
            }, value);
          const before = navigations;
          await form
            .locator("button")
            .first()
            .evaluate((button) => (button as HTMLButtonElement).click());
          await view.keyboard.press("Enter");
          expect(navigations).toBe(before);
          expect(new URL(view.url()).pathname).toBe(scenario.path);
          assertSafeUrls();
        } finally {
          await context.close();
        }
      }
      const context = await browser.newContext({
        baseURL: process.env.TEST_BASE_URL,
        viewport: page.viewportSize(),
        javaScriptEnabled: false,
      });
      try {
        await authenticate(context, admin);
        const view = await context.newPage();
        await view.goto("/admin/users?q=" + user.username);
        await expect(view.getByText("共 1 个普通账号")).toHaveCount(1);
        await noScriptNotice(view);
        await expect(
          view.getByRole("button", {
            name: "重置密码",
            exact: true,
            includeHidden: true,
          }),
        ).toBeDisabled();
        const search = view
          .locator("form")
          .filter({ has: view.getByLabel("搜索普通账号") });
        await expect(search).toHaveJSProperty("method", "get");
        await expect(
          search.getByRole("button", {
            name: "搜索",
            exact: true,
            includeHidden: true,
          }),
        ).toBeEnabled();
        await expect(search.getByLabel("搜索普通账号")).toBeEnabled();
        await search.evaluate((element, query) => {
          const form = element as HTMLFormElement;
          (form.elements.namedItem("q") as HTMLInputElement).value = query;
          HTMLFormElement.prototype.submit.call(form);
        }, user.username + "_missing");
        await expect(view.getByText("共 0 个普通账号")).toHaveCount(1);
        expect(new URL(view.url()).searchParams.get("q")).toBe(
          user.username + "_missing",
        );
      } finally {
        await context.close();
      }
    });
  } finally {
    await db.user.deleteMany({ where: { id: user.id } });
    await cleanAdministrator(admin.id);
  }
});

test("delayed scripts cannot submit SSR password forms and hydration never automatically submits", async ({
  browser,
  page,
}) => {
  const admin = await administrator();
  try {
    await withOwner(async (owner) => {
      for (const scenario of [
        { path: "/admin", heading: "管理员登录", admin: undefined },
        { path: "/admin/password", heading: "修改管理员密码", admin },
        { path: "/admin/accounts", heading: "创建管理员", admin: owner },
      ]) {
        const context = await browser.newContext({
          baseURL: process.env.TEST_BASE_URL,
          viewport: page.viewportSize(),
        });
        const deferred = gate();
        try {
          if (scenario.admin) await authenticate(context, scenario.admin);
          const view = await context.newPage();
          let scripts = 0,
            writes = 0;
          await view.route("**/_next/static/**", async (route) => {
            if (route.request().resourceType() !== "script")
              return route.continue();
            scripts++;
            await deferred.promise;
            await route.continue();
          });
          view.on("request", (request) => {
            if (
              request.url().includes("/api/admin/") &&
              request.method() !== "GET"
            )
              writes++;
          });
          await view.goto(scenario.path, { waitUntil: "commit" });
          const form = formWith(view, scenario.heading);
          await expect(form).toBeVisible();
          await expect.poll(() => scripts).toBeGreaterThan(0);
          await disabledFields(form);
          await form
            .locator("button")
            .first()
            .evaluate((button) => (button as HTMLButtonElement).click());
          await view.keyboard.press("Enter");
          expect(writes).toBe(0);
          deferred.release();
          await expect(
            form.locator('input[type="password"]').first(),
          ).toBeEnabled();
          await expect(form.locator("fieldset")).toHaveJSProperty(
            "disabled",
            false,
          );
          expect(writes).toBe(0);
        } finally {
          deferred.release();
          await context.close();
        }
      }
    });
  } finally {
    await cleanAdministrator(admin.id);
  }
});

test("login and first password change retain credentials on rejection and submit once with complete fields", async ({
  page,
}) => {
  const admin = await administrator(true);
  const finalPassword = secret(),
    wrong = secret();
  const assertSafeUrls = guardUrls(page, [
    admin.password,
    finalPassword,
    wrong,
  ]);
  try {
    const held = await holdWrite(page, "**/api/admin/session", "POST");
    await page.goto("/admin");
    let form = formWith(page, "管理员登录");
    await form.getByLabel("账号", { exact: true }).fill(admin.username);
    await form.getByLabel("密码", { exact: true }).fill(wrong);
    await form.getByRole("button", { name: "登录", exact: true }).click();
    await expect.poll(() => held.requests.length).toBe(1);
    await disabledFields(form);
    expect(held.requests[0].postDataJSON()).toEqual({
      username: admin.username,
      password: wrong,
    });
    held.release();
    await expect(page.locator('p[role="alert"]')).toContainText(
      "账号或密码错误",
    );
    await expect(form.getByLabel("密码", { exact: true })).toHaveValue(wrong);
    await form.getByLabel("密码", { exact: true }).fill(admin.password);
    await form.getByRole("button", { name: "登录", exact: true }).click();
    form = formWith(page, "设置管理员密码");
    await expect(form).toBeVisible();
    await expect(form.getByLabel("账号", { exact: true })).toBeDisabled();
    await expect(form.getByLabel("临时密码", { exact: true })).toBeDisabled();
    expect(held.requests).toHaveLength(2);
    await fillNewPassword(form, finalPassword, wrong);
    await form.getByRole("button", { name: "设置密码并登录" }).click();
    await expect(page.locator('p[role="alert"]')).toContainText(
      "两次输入的新密码不一致",
    );
    expect(held.requests).toHaveLength(2);
    await fillNewPassword(form, admin.password);
    await form.getByRole("button", { name: "设置密码并登录" }).click();
    await expect(page.locator('p[role="alert"]')).toContainText(
      "新密码不能与临时密码相同",
    );
    await expect(form.getByLabel(/^新密码/)).toHaveValue(admin.password);
    await fillNewPassword(form, finalPassword);
    await form.getByRole("button", { name: "设置密码并登录" }).click();
    await expect(
      page.getByRole("button", { name: "退出登录", exact: true }),
    ).toBeVisible();
    expect(held.requests).toHaveLength(4);
    expect(held.requests[3].postDataJSON()).toEqual({
      username: admin.username,
      password: admin.password,
      newPassword: finalPassword,
    });
    const updated = await db.adminCredential.findUniqueOrThrow({
      where: { id: admin.id },
    });
    expect(updated.mustChangePassword).toBe(false);
    expect(await verifyPasswordHash(finalPassword, updated.passwordHash)).toBe(
      true,
    );
    assertSafeUrls();
  } finally {
    await closePage(page);
    await cleanAdministrator(admin.id);
  }
});

test("changing the administrator password preserves failed inputs and keeps navigation outside the disabled form", async ({
  page,
  context,
}) => {
  const admin = await administrator();
  const nextPassword = secret(),
    wrong = secret();
  const assertSafeUrls = guardUrls(page, [admin.password, nextPassword, wrong]);
  try {
    await authenticate(context, admin);
    await page.goto("/admin/password");
    const form = formWith(page, "修改管理员密码");
    const held = await holdWrite(page, "**/api/admin/session", "PATCH");
    await form.getByLabel("当前密码", { exact: true }).fill(wrong);
    await fillNewPassword(form, nextPassword, wrong);
    await form.getByRole("button", { name: "修改密码", exact: true }).click();
    await expect(page.locator('p[role="alert"]')).toContainText(
      "两次输入的新密码不一致",
    );
    expect(held.requests).toHaveLength(0);
    await fillNewPassword(form, nextPassword);
    await form.getByRole("button", { name: "修改密码", exact: true }).click();
    await expect.poll(() => held.requests.length).toBe(1);
    await disabledFields(form);
    await expect(
      page.getByRole("button", { name: "退出登录", exact: true }),
    ).toBeDisabled();
    await expect(
      page
        .getByRole("navigation", { name: "管理员导航" })
        .getByRole("link", { name: "普通账号", exact: true }),
    ).toBeEnabled();
    expect(held.requests[0].postDataJSON()).toEqual({
      currentPassword: wrong,
      newPassword: nextPassword,
    });
    held.release();
    await expect(page.locator('p[role="alert"]')).toContainText("当前密码错误");
    await expect(
      page.getByRole("button", { name: "退出登录", exact: true }),
    ).toBeEnabled();
    await expect(form.getByLabel("当前密码", { exact: true })).toHaveValue(
      wrong,
    );
    await expect(form.getByLabel(/^新密码/)).toHaveValue(nextPassword);
    await form.getByLabel("当前密码", { exact: true }).fill(admin.password);
    await form.getByRole("button", { name: "修改密码", exact: true }).click();
    await expect(form.getByLabel("当前密码", { exact: true })).toHaveValue("");
    expect(held.requests).toHaveLength(2);
    expect(held.requests[1].postDataJSON()).toEqual({
      currentPassword: admin.password,
      newPassword: nextPassword,
    });
    const updated = await db.adminCredential.findUniqueOrThrow({
      where: { id: admin.id },
    });
    expect(updated.sessionVersion).toBe(admin.sessionVersion + 1);
    expect(await verifyPasswordHash(nextPassword, updated.passwordHash)).toBe(
      true,
    );
    assertSafeUrls();
  } finally {
    await closePage(page);
    await cleanAdministrator(admin.id);
  }
});

test("creating and resetting an administrator validates confirmation and disables only local password forms", async ({
  page,
  context,
}, info) => {
  const username = name(),
    password = secret(),
    resetPassword = secret();
  const assertSafeUrls = guardUrls(page, [password, resetPassword]);
  let targetId: number | undefined;
  await withOwner(async (owner) => {
    try {
      await authenticate(context, owner);
      await page.goto("/admin/accounts");
      const create = formWith(page, "创建管理员");
      const creation = await holdWrite(page, "**/api/admin/accounts", "POST");
      await create.getByLabel("账号", { exact: true }).fill(username);
      await create.getByLabel("临时密码", { exact: true }).fill(password);
      await create
        .getByLabel("确认临时密码", { exact: true })
        .fill(resetPassword);
      await create
        .getByRole("button", { name: "创建管理员", exact: true })
        .click();
      await expect(page.locator('p[role="alert"]')).toContainText(
        "两次输入的临时密码不一致",
      );
      expect(creation.requests).toHaveLength(0);
      await create.getByLabel("确认临时密码", { exact: true }).fill(password);
      await create
        .getByRole("button", { name: "创建管理员", exact: true })
        .click();
      await expect.poll(() => creation.requests.length).toBe(1);
      await disabledFields(create);
      expect(creation.requests[0].postDataJSON()).toEqual({
        username,
        password,
      });
      creation.release();
      const row = page.locator("li").filter({ hasText: username });
      await expect(row).toBeVisible();
      await expect(create.getByLabel("临时密码", { exact: true })).toHaveValue(
        "",
      );
      const target = await db.adminCredential.findUniqueOrThrow({
        where: { username },
      });
      targetId = target.id;
      expect(await verifyPasswordHash(password, target.passwordHash)).toBe(
        true,
      );
      // Actual duplicate rejection must retain the values instead of resetting the form.
      await create.getByLabel("账号", { exact: true }).fill(username);
      await create.getByLabel("临时密码", { exact: true }).fill(password);
      await create.getByLabel("确认临时密码", { exact: true }).fill(password);
      await create
        .getByRole("button", { name: "创建管理员", exact: true })
        .click();
      await expect(page.locator('p[role="alert"]')).toContainText(
        "该管理员账号已存在",
      );
      await expect(create.getByLabel("临时密码", { exact: true })).toHaveValue(
        password,
      );
      expect(creation.requests).toHaveLength(2);
      await row.getByRole("button", { name: "重置密码", exact: true }).click();
      const reset = formWith(page, "重置密码：" + username);
      await expect(reset).toHaveAttribute("method", "post");
      const resetting = await holdWrite(
        page,
        `**/api/admin/accounts/${target.id}`,
        "PATCH",
      );
      await reset.getByLabel("新临时密码", { exact: true }).fill(resetPassword);
      await reset.getByLabel("确认临时密码", { exact: true }).fill(password);
      await reset
        .getByRole("button", { name: "确认重置", exact: true })
        .click();
      await expect(page.locator('p[role="alert"]')).toContainText(
        "两次输入的密码不一致",
      );
      expect(resetting.requests).toHaveLength(0);
      await reset
        .getByLabel("确认临时密码", { exact: true })
        .fill(resetPassword);
      page.once("dialog", (dialog) => dialog.accept());
      await reset
        .getByRole("button", { name: "确认重置", exact: true })
        .click();
      await expect.poll(() => resetting.requests.length).toBe(1);
      await disabledFields(reset);
      expect(resetting.requests[0].postDataJSON()).toEqual({
        action: "resetPassword",
        password: resetPassword,
      });
      resetting.release();
      await expect(reset).toHaveCount(0);
      const updated = await db.adminCredential.findUniqueOrThrow({
        where: { id: target.id },
      });
      expect(updated.mustChangePassword).toBe(true);
      expect(updated.sessionVersion).toBe(target.sessionVersion + 1);
      expect(
        await verifyPasswordHash(resetPassword, updated.passwordHash),
      ).toBe(true);
      expect(resetting.requests).toHaveLength(1);
      assertSafeUrls();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath("admin-password-forms.png"),
        fullPage: true,
      });
    } finally {
      await closePage(page);
      const target =
        targetId ??
        (await db.adminCredential.findUnique({ where: { username } }))?.id;
      if (target) await cleanAdministrator(target);
    }
  });
});

test("ordinary account reset keeps GET search and submits a complete protected password request", async ({
  page,
  context,
}) => {
  const admin = await administrator(),
    password = secret();
  const user = await db.user.create({
    data: {
      username: name(),
      nickname: "密码表单测试",
      passwordHash: await hashPassword(secret()),
    },
  });
  const assertSafeUrls = guardUrls(page, [password]);
  try {
    await authenticate(context, admin);
    await page.goto("/admin/users?q=" + user.username);
    await expect(page.getByText("共 1 个普通账号")).toBeVisible();
    const search = page
      .locator("form")
      .filter({ has: page.getByLabel("搜索普通账号") });
    await expect(search).toHaveJSProperty("method", "get");
    await page.getByRole("button", { name: "重置密码", exact: true }).click();
    const form = formWith(page, `重置 ${user.username} 的密码`);
    await expect(form).toHaveAttribute("method", "post");
    const held = await holdWrite(
      page,
      `**/api/admin/users/${user.id}`,
      "PATCH",
    );
    await form.getByLabel("临时密码", { exact: true }).fill(password);
    page.once("dialog", (dialog) => dialog.accept());
    await form.getByRole("button", { name: "确认重置", exact: true }).click();
    await expect.poll(() => held.requests.length).toBe(1);
    await disabledFields(form);
    await expect(search.getByRole("button", { name: "搜索" })).toBeEnabled();
    expect(held.requests[0].postDataJSON()).toEqual({
      action: "reset",
      version: user.version,
      password,
    });
    held.release();
    await expect(form).toHaveCount(0);
    await expect(
      page.getByText("启用 · 需修改密码", { exact: true }),
    ).toBeVisible();
    const updated = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.mustChangePassword).toBe(true);
    expect(updated.version).toBe(user.version + 1);
    expect(await verifyPasswordHash(password, updated.passwordHash)).toBe(true);
    expect(held.requests).toHaveLength(1);
    assertSafeUrls();
  } finally {
    await closePage(page);
    await db.adminAuditLog.deleteMany({
      where: { targetType: "user", targetId: user.id },
    });
    await db.user.deleteMany({ where: { id: user.id } });
    await cleanAdministrator(admin.id);
  }
});

test("native form fallback sends POST body without password query strings even when hydration protection is bypassed", async ({
  browser,
  page,
}) => {
  const admin = await administrator();
  const context = await browser.newContext({
    baseURL: process.env.TEST_BASE_URL,
    viewport: page.viewportSize(),
    javaScriptEnabled: false,
  });
  try {
    await authenticate(context, admin);
    const view = await context.newPage();
    const currentPassword = secret(),
      newPassword = secret();
    const assertSafeUrls = guardUrls(view, [currentPassword, newPassword]);
    await view.goto("/admin/password");
    const form = formWith(view, "修改管理员密码", true);
    await disabledFields(form);
    const requests: Request[] = [];
    await view.route("**/admin/password", async (route) => {
      if (!route.request().isNavigationRequest()) return route.continue();
      requests.push(route.request());
      // Capture locally; do not send the synthetic password body to any server.
      await route.fulfill({
        status: 200,
        contentType: "text/plain",
        body: "Native submission captured",
      });
    });
    await form.evaluate(
      (element, values) => {
        const nativeForm = element as HTMLFormElement;
        for (const fieldset of nativeForm.querySelectorAll("fieldset"))
          fieldset.disabled = false;
        for (const [name, value] of Object.entries(values)) {
          (nativeForm.elements.namedItem(name) as HTMLInputElement).value =
            value;
        }
        HTMLFormElement.prototype.submit.call(nativeForm);
      },
      { currentPassword, newPassword, confirmation: newPassword },
    );
    await expect(view.getByText("Native submission captured")).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0].method()).toBe("POST");
    const body = new URLSearchParams(requests[0].postData()!);
    expect(body.get("currentPassword")).toBe(currentPassword);
    expect(body.get("newPassword")).toBe(newPassword);
    expect(new URL(requests[0].url()).search).toBe("");
    assertSafeUrls();
  } finally {
    await context.close();
    await cleanAdministrator(admin.id);
  }
});
