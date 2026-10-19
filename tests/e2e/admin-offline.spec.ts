import "../support/isolated";
import {
  test,
  expect,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../../server/db";
import { ensureAdminRecord } from "../../server/admin";
import {
  ADMIN_COOKIE,
  createAdminSession,
  hashPassword,
  verifyPasswordHash,
} from "../../server/admin-auth";
import { createReservation } from "../../server/reservations";

type Kind = "panel" | "accounts" | "users" | "trash";
const kinds: Kind[] = ["panel", "accounts", "users", "trash"];
const name = () => "offline_" + randomUUID().replaceAll("-", "").slice(0, 16);
const secret = () => "Fake-" + randomUUID();
const formWith = (page: Page, title: string) =>
  page
    .locator("form")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
const error = (page: Page) => page.locator('p[role="alert"]');
const manual = (page: Page) =>
  page.getByRole("button", { name: "刷新核对状态", exact: true });
const successOffline = "操作已成功，当前离线，请联网后刷新核对。";

async function manager() {
  await ensureAdminRecord();
  const password = secret();
  const record = await db.adminCredential.create({
    data: {
      username: name(),
      passwordHash: await hashPassword(password),
      mustChangePassword: false,
    },
  });
  return { ...record, password };
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
async function cleanManager(id: number) {
  await db.adminAuditLog.deleteMany({
    where: {
      OR: [{ actorId: id }, { targetType: "admin", targetId: String(id) }],
    },
  });
  await db.adminCredential.deleteMany({ where: { id } });
}
async function closePage(page: Page) {
  // Route handlers await their real HTTP result before fixture cleanup begins.
  if (page.isClosed()) return;
  try {
    await page.unrouteAll({ behavior: "wait" });
  } catch {
    // Playwright may already be closing a timed-out test. Preserve its original
    // failure and still reach database/owner cleanup rather than masking it.
    if (!page.isClosed())
      test.info().annotations.push({
        type: "cleanup",
        description: "Route cleanup failed while closing the test page.",
      });
  }
  try {
    if (!page.isClosed()) await page.close();
  } catch {
    if (!page.isClosed())
      test.info().annotations.push({
        type: "cleanup",
        description:
          "The test page could not be closed during fixture cleanup.",
      });
  }
}
async function installClock(page: Page) {
  await page.clock.install({ time: new Date() });
  await page.addInitScript(() => {
    (window as unknown as { adminOnline: boolean }).adminOnline = true;
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => (window as unknown as { adminOnline: boolean }).adminOnline,
    });
  });
}
async function online(page: Page, value: boolean) {
  // Change the observed state without generating an online event/read refresh.
  await page.evaluate((value) => {
    (window as unknown as { adminOnline: boolean }).adminOnline = value;
  }, value);
}
async function freeze(page: Page) {
  await page.clock.pauseAt(
    new Date((await page.evaluate(() => Date.now())) + 1000),
  );
}
function counts(page: Page) {
  const result = { writes: 0, reads: 0, dialogs: 0 };
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/admin/") && request.method() !== "GET")
      result.writes++;
    if (
      request.method() === "GET" &&
      path.startsWith("/admin") &&
      !request.headers()["next-router-prefetch"] &&
      (request.isNavigationRequest() || request.headers().rsc === "1")
    )
      result.reads++;
  });
  page.on("dialog", async (dialog) => {
    result.dialogs++;
    await dialog.accept();
  });
  return result;
}
async function focusWithoutReplay(
  page: Page,
  activity: ReturnType<typeof counts>,
  writes: number,
) {
  await online(page, true);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
  });
  await page.clock.runFor(1100);
  await page.waitForLoadState("networkidle");
  expect(activity.writes).toBe(writes); // Existing read-only refresh is intentionally allowed.
}

async function scenario(kind: Kind, page: Page, context: BrowserContext) {
  const admin = await manager();
  const owner = kind === "accounts" ? await ensureAdminRecord() : undefined;
  if (owner)
    await db.adminCredential.update({
      where: { id: owner.id },
      data: { mustChangePassword: false },
    });
  const user =
    kind === "users"
      ? await db.user.create({
          data: {
            username: name(),
            nickname: "离线管理测试",
            passwordHash: await hashPassword(secret()),
          },
        })
      : undefined;
  const reservation =
    kind === "panel" || kind === "trash"
      ? await createReservation(
          {
            gameName: name(),
            hostName: "离线队长",
            maxPlayers: 3,
            scheduledAt: new Date(Date.now() + 86400000).toISOString(),
          },
          randomBytes(32).toString("hex"),
        )
      : undefined;
  if (kind === "trash")
    await db.gameReservation.update({
      where: { id: reservation!.id },
      data: { deletedAt: new Date() },
    });
  const actor = owner ?? admin,
    password = secret();
  const path =
    kind === "panel"
      ? `/admin?q=${reservation!.gameName}`
      : kind === "trash"
        ? `/admin/trash?q=${reservation!.gameName}`
        : kind === "users"
          ? `/admin/users?q=${user!.username}`
          : "/admin/accounts";
  const endpoint =
    kind === "panel"
      ? `/api/admin/reservations/${reservation!.id}`
      : kind === "trash"
        ? `/api/admin/trash/${reservation!.id}`
        : kind === "users"
          ? `/api/admin/users/${user!.id}`
          : `/api/admin/accounts/${admin.id}`;
  const method =
    kind === "panel" ? "DELETE" : kind === "trash" ? "POST" : "PATCH";
  async function cleanup() {
    try {
      await closePage(page);
      if (reservation) {
        await db.adminAuditLog.deleteMany({
          where: { targetType: "reservation", targetId: reservation.id },
        });
        await db.gameReservation.deleteMany({ where: { id: reservation.id } });
        await db.creationRequest.deleteMany({
          where: { reservationId: reservation.id },
        });
      }
      if (user) {
        await db.adminAuditLog.deleteMany({
          where: { targetType: "user", targetId: user.id },
        });
        await db.user.deleteMany({ where: { id: user.id } });
      }
      await cleanManager(admin.id);
    } finally {
      if (owner)
        await db.adminCredential.update({
          where: { id: owner.id },
          data: { mustChangePassword: owner.mustChangePassword },
        });
    }
  }
  try {
    let form: Locator | undefined;
    await authenticate(context, actor);
    await installClock(page);
    await page.goto(path, { waitUntil: "networkidle" });
    if (kind === "accounts") {
      await page
        .locator("li")
        .filter({ hasText: admin.username })
        .getByRole("button", { name: "重置密码", exact: true })
        .click();
      form = formWith(page, "重置密码：" + admin.username);
      await form.getByLabel("新临时密码", { exact: true }).fill(password);
      await form.getByLabel("确认临时密码", { exact: true }).fill(password);
    } else if (kind === "users") {
      await page.getByRole("button", { name: "重置密码", exact: true }).click();
      form = formWith(page, `重置 ${user!.username} 的密码`);
      await form.getByLabel("临时密码", { exact: true }).fill(password);
    }
    const button =
      kind === "panel"
        ? page.getByRole("button", { name: "移入回收站", exact: true })
        : kind === "trash"
          ? page.getByRole("button", { name: "恢复预约", exact: true })
          : form!.getByRole("button", { name: "确认重置", exact: true });
    await expect(button).toBeEnabled();
    await freeze(page);
    const activity = counts(page);
    return {
      admin,
      owner,
      user,
      reservation,
      actor,
      password,
      path,
      endpoint,
      method,
      form,
      button,
      activity,
      async retained() {
        if (kind === "accounts")
          await expect(
            form!.getByLabel("新临时密码", { exact: true }),
          ).toHaveValue(password);
        else if (kind === "users")
          await expect(
            form!.getByLabel("临时密码", { exact: true }),
          ).toHaveValue(password);
        else
          await expect(
            page.getByText(reservation!.gameName, { exact: true }),
          ).toBeVisible();
      },
      async committed(expected = true) {
        if (kind === "accounts") {
          const record = await db.adminCredential.findUniqueOrThrow({
            where: { id: admin.id },
          });
          expect(await verifyPasswordHash(password, record.passwordHash)).toBe(
            expected,
          );
          expect(record.sessionVersion).toBe(
            expected ? admin.sessionVersion + 1 : admin.sessionVersion,
          );
        } else if (kind === "users") {
          const record = await db.user.findUniqueOrThrow({
            where: { id: user!.id },
          });
          expect(await verifyPasswordHash(password, record.passwordHash)).toBe(
            expected,
          );
          expect(record.version).toBe(
            expected ? user!.version + 1 : user!.version,
          );
        } else {
          const record = await db.gameReservation.findUniqueOrThrow({
            where: { id: reservation!.id },
          });
          expect(record.deletedAt !== null).toBe(
            kind === "panel" ? expected : !expected,
          );
        }
      },
      cleanup,
    };
  } catch (cause) {
    await cleanup();
    throw cause;
  }
}

test.afterAll(() => db.$disconnect());

for (const kind of kinds) {
  test(`${kind}: offline blocks writes before confirmation and keeps the current input`, async ({
    page,
    context,
  }) => {
    const fixture = await scenario(kind, page, context);
    try {
      await online(page, false);
      await context.setOffline(true);
      await fixture.button.click();
      await expect(error(page)).toContainText("离线");
      await fixture.retained();
      if (kind === "trash")
        await page
          .getByRole("button", { name: "永久删除", exact: true })
          .click();
      if (kind === "panel")
        await page
          .getByRole("button", { name: "退出登录", exact: true })
          .click();
      if (kind === "accounts") {
        await page
          .locator("li")
          .filter({ hasText: fixture.admin.username })
          .getByRole("button", { name: "禁用账号", exact: true })
          .click();
        const create = formWith(page, "创建管理员");
        await create.getByLabel("账号", { exact: true }).fill(name());
        await create
          .getByLabel("临时密码", { exact: true })
          .fill(fixture.password);
        await create
          .getByLabel("确认临时密码", { exact: true })
          .fill(fixture.password);
        await create
          .getByRole("button", { name: "创建管理员", exact: true })
          .click();
        await expect(
          create.getByLabel("临时密码", { exact: true }),
        ).toHaveValue(fixture.password);
      }
      if (kind === "users") {
        await page.getByRole("button", { name: "停用", exact: true }).click();
        await page
          .getByRole("button", { name: "退出所有设备", exact: true })
          .click();
      }
      await manual(page).click();
      await expect(error(page)).toContainText("离线");
      await page.clock.runFor(100);
      expect(fixture.activity).toEqual({ writes: 0, reads: 0, dialogs: 0 });
      await fixture.committed(false);
    } finally {
      await fixture.cleanup();
    }
  });

  test(`${kind}: a committed write with a lost response preserves the page and is never replayed`, async ({
    page,
    context,
  }) => {
    const fixture = await scenario(kind, page, context);
    try {
      let responseStatus: number | undefined;
      await page.route("**" + fixture.endpoint, async (route) => {
        if (route.request().method() !== fixture.method)
          return route.continue();
        const response = await route.fetch();
        responseStatus = response.status();
        await route.abort("failed");
      });
      await fixture.button.click();
      await expect(error(page)).toContainText("不会自动重发");
      expect(responseStatus).toBe(200);
      await fixture.retained();
      await fixture.committed();
      expect(fixture.activity.writes).toBe(1);
      expect(fixture.activity.reads).toBe(0);
      expect(new URL(page.url()).pathname).toBe(
        new URL(fixture.path, process.env.TEST_BASE_URL).pathname,
      );
      await focusWithoutReplay(page, fixture.activity, 1);
      await online(page, false);
      const reads = fixture.activity.reads;
      const previousMessage = await error(page).textContent();
      await manual(page).click();
      await expect(error(page)).toContainText(previousMessage!);
      await expect(error(page)).toContainText("当前离线");
      const offlineMessage = await error(page).textContent();
      await manual(page).click();
      await expect(error(page)).toHaveText(offlineMessage!);
      expect(fixture.activity.reads).toBe(reads);
      expect(fixture.activity.writes).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  test(`${kind}: success arriving after connectivity loss does not refresh or navigate`, async ({
    page,
    context,
  }) => {
    const fixture = await scenario(kind, page, context);
    try {
      await page.route("**" + fixture.endpoint, async (route) => {
        if (route.request().method() !== fixture.method)
          return route.continue();
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        await online(page, false);
        await route.fulfill({ response });
      });
      const url = page.url();
      await fixture.button.click();
      await expect(error(page)).toContainText(successOffline);
      await fixture.committed();
      expect(page.url()).toBe(url);
      expect(fixture.activity.writes).toBe(1);
      expect(fixture.activity.reads).toBe(0);
      await manual(page).click();
      await expect(error(page)).toContainText("离线");
      expect(fixture.activity.reads).toBe(0);
      await focusWithoutReplay(page, fixture.activity, 1);
      const reads = fixture.activity.reads;
      await manual(page).click();
      await expect.poll(() => fixture.activity.reads).toBeGreaterThan(reads);
      expect(fixture.activity.writes).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  test(`${kind}: a real revoked administrator session immediately hides management content`, async ({
    page,
    context,
  }) => {
    const fixture = await scenario(kind, page, context);
    try {
      // Root bootstrap state is restored by cleanup; other tests use a new manager.
      await db.adminCredential.update({
        where: { id: fixture.actor.id },
        data: { mustChangePassword: true },
      });
      const response = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === fixture.endpoint &&
          response.request().method() === fixture.method,
      );
      await fixture.button.click();
      const failure = await response;
      expect(failure.status()).toBe(401);
      expect((await failure.json()).code).toBe("UNAUTHORIZED");
      await expect(
        page.getByRole("heading", { name: "管理会话已结束", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("navigation", { name: "管理员导航" }),
      ).toHaveCount(0);
      await expect(fixture.button).toHaveCount(0);
      if (fixture.form) await expect(fixture.form).toHaveCount(0);
      expect(fixture.activity.reads).toBe(0);
      expect(fixture.activity.writes).toBe(1);
      await fixture.committed(false);
      await online(page, false);
      await page
        .getByRole("button", { name: "前往管理员登录", exact: true })
        .click();
      await expect(
        page.getByText("当前离线，请联网后前往管理员登录。", { exact: true }),
      ).toBeVisible();
      expect(fixture.activity.reads).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });
}

test("a pending reservation removal shares the panel lock and pauses refresh without disabling navigation", async ({
  page,
  context,
}) => {
  const fixture = await scenario("panel", page, context);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await page.route("**" + fixture.endpoint, async (route) => {
      if (route.request().method() !== fixture.method) return route.continue();
      await held;
      await route.fulfill({
        status: 409,
        json: { code: "CONFLICT", error: "请刷新后核对预约" },
      });
    });
    await fixture.button.click();
    await expect.poll(() => fixture.activity.writes).toBe(1);
    await expect(fixture.button).toBeDisabled();
    const logout = page.getByRole("button", { name: "退出登录", exact: true });
    await expect(logout).toBeDisabled();
    await expect(
      page
        .getByRole("navigation", { name: "管理员导航" })
        .getByRole("link", { name: "修改密码", exact: true }),
    ).toBeEnabled();
    await page.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
    });
    // Cross the next scheduled refresh without hitting the 15-second request timeout.
    await page.clock.runFor(14000);
    expect(fixture.activity.writes).toBe(1);
    expect(fixture.activity.reads).toBe(0);
    release();
    await expect(error(page)).toContainText("请刷新后核对预约");
    await expect(fixture.button).toBeEnabled();
    await expect(logout).toBeEnabled();
    expect(fixture.activity.reads).toBe(0);
    await fixture.committed(false);
  } finally {
    release();
    await fixture.cleanup();
  }
});

test("wrong current password is a recoverable field error; offline password operations send nothing", async ({
  page,
  context,
}) => {
  const admin = await manager(),
    nextPassword = secret(),
    wrong = secret();
  try {
    await authenticate(context, admin);
    await installClock(page);
    await page.goto("/admin/password", { waitUntil: "networkidle" });
    const form = formWith(page, "修改管理员密码");
    await form.getByLabel("当前密码", { exact: true }).fill(wrong);
    await form.getByLabel(/^新密码/).fill(nextPassword);
    await form.getByLabel("确认新密码", { exact: true }).fill(nextPassword);
    await freeze(page);
    const activity = counts(page);
    await online(page, false);
    await form.getByRole("button", { name: "修改密码", exact: true }).click();
    await expect(error(page)).toContainText("离线");
    await form
      .getByRole("button", { name: "退出所有设备", exact: true })
      .click();
    expect(activity).toEqual({ writes: 0, reads: 0, dialogs: 0 });
    await online(page, true);
    const response = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/admin/session") &&
        response.request().method() === "PATCH",
    );
    await form.getByRole("button", { name: "修改密码", exact: true }).click();
    const failure = await response;
    expect(failure.status()).toBe(401);
    expect((await failure.json()).code).toBe("INVALID_PASSWORD");
    await expect(error(page)).toContainText("当前密码错误");
    await expect(form.getByLabel("当前密码", { exact: true })).toHaveValue(
      wrong,
    );
    await expect(form.getByLabel(/^新密码/)).toHaveValue(nextPassword);
    await expect(
      page.getByRole("heading", { name: "管理会话已结束", exact: true }),
    ).toHaveCount(0);
    expect(activity.writes).toBe(1);
    expect(activity.reads).toBe(0);
  } finally {
    await closePage(page);
    await cleanManager(admin.id);
  }
});

for (const all of [false, true]) {
  test(`successful ${all ? "all-device" : "current-device"} logout hides old content even when the response arrives offline`, async ({
    page,
    context,
  }) => {
    const admin = await manager();
    try {
      await authenticate(context, admin);
      await installClock(page);
      await page.goto("/admin/password", { waitUntil: "networkidle" });
      const form = formWith(page, "修改管理员密码");
      await expect(form.getByLabel("当前密码", { exact: true })).toBeEnabled();
      await freeze(page);
      const activity = counts(page);
      const endpoint = "/api/admin/session" + (all ? "/all" : "");
      await page.route("**" + endpoint, async (route) => {
        if (route.request().method() !== "DELETE") return route.continue();
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        await online(page, false);
        await route.fulfill({ response });
      });
      await page
        .getByRole("button", {
          name: all ? "退出所有设备" : "退出登录",
          exact: true,
        })
        .click();
      await expect(
        page.getByRole("heading", { name: "管理会话已结束", exact: true }),
      ).toBeVisible();
      await expect(form).toHaveCount(0);
      await expect(
        page.getByRole("navigation", { name: "管理员导航" }),
      ).toHaveCount(0);
      expect(activity.writes).toBe(1);
      expect(activity.reads).toBe(0);
      const updated = await db.adminCredential.findUniqueOrThrow({
        where: { id: admin.id },
      });
      expect(updated.sessionVersion).toBe(admin.sessionVersion + (all ? 1 : 0));
      await page
        .getByRole("button", { name: "前往管理员登录", exact: true })
        .click();
      await expect(
        page.getByText("当前离线，请联网后前往管理员登录。", { exact: true }),
      ).toBeVisible();
      expect(activity.reads).toBe(0);
      await online(page, true);
      await page
        .getByRole("button", { name: "前往管理员登录", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "管理员登录", exact: true }),
      ).toBeVisible();
      expect(activity.writes).toBe(1);
    } finally {
      await closePage(page);
      await cleanManager(admin.id);
    }
  });
}

test("online soft delete, restore and permanent delete still refresh their lists exactly once per successful operation", async ({
  page,
  context,
}) => {
  const fixture = await scenario("panel", page, context);
  async function visit(path: string, button: Locator) {
    // Streaming page reveal uses browser timers. Let the new document hydrate,
    // then pause again before measuring the next business action's refresh.
    await page.clock.resume();
    await page.goto(path, { waitUntil: "networkidle" });
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
    await freeze(page);
  }
  try {
    const title = fixture.reservation!.gameName;
    await fixture.button.click();
    await expect(page.getByText(title, { exact: true })).toHaveCount(0);
    expect(fixture.activity.writes).toBe(1);
    expect(fixture.activity.reads).toBe(1);
    await fixture.committed();
    await visit(
      "/admin/trash?q=" + title,
      page.getByRole("button", { name: "恢复预约", exact: true }),
    );
    const reads = fixture.activity.reads;
    await page.getByRole("button", { name: "恢复预约", exact: true }).click();
    await expect(page.getByText(title, { exact: true })).toHaveCount(0);
    expect(fixture.activity.writes).toBe(2);
    expect(fixture.activity.reads).toBe(reads + 1);
    await fixture.committed(false);
    await visit(fixture.path, fixture.button);
    await fixture.button.click();
    await expect(page.getByText(title, { exact: true })).toHaveCount(0);
    await visit(
      "/admin/trash?q=" + title,
      page.getByRole("button", { name: "永久删除", exact: true }),
    );
    const beforeDelete = fixture.activity.reads;
    await page.getByRole("button", { name: "永久删除", exact: true }).click();
    await expect(page.getByText(title, { exact: true })).toHaveCount(0);
    expect(
      await db.gameReservation.count({
        where: { id: fixture.reservation!.id },
      }),
    ).toBe(0);
    expect(fixture.activity.writes).toBe(4);
    expect(fixture.activity.reads).toBe(beforeDelete + 1);
  } finally {
    await fixture.cleanup();
  }
});

test("anonymous login and first-login password setup preserve input and send nothing while offline", async ({
  page,
}) => {
  const admin = await manager(),
    nextPassword = secret();
  await db.adminCredential.update({
    where: { id: admin.id },
    data: { mustChangePassword: true },
  });
  try {
    await installClock(page);
    await page.goto("/admin", { waitUntil: "networkidle" });
    let form = formWith(page, "管理员登录");
    await form.getByLabel("账号", { exact: true }).fill(admin.username);
    await form.getByLabel("密码", { exact: true }).fill(admin.password);
    await freeze(page);
    const activity = counts(page);
    await online(page, false);
    await form.getByRole("button", { name: "登录", exact: true }).click();
    await expect(error(page)).toContainText("离线");
    await expect(form.getByLabel("账号", { exact: true })).toHaveValue(
      admin.username,
    );
    await expect(form.getByLabel("密码", { exact: true })).toHaveValue(
      admin.password,
    );
    expect(activity).toEqual({ writes: 0, reads: 0, dialogs: 0 });
    await online(page, true);
    await form.getByRole("button", { name: "登录", exact: true }).click();
    form = formWith(page, "设置管理员密码");
    await expect(form).toBeVisible();
    expect(activity.writes).toBe(1);
    await form.getByLabel(/^新密码/).fill(nextPassword);
    await form.getByLabel("确认新密码", { exact: true }).fill(nextPassword);
    await online(page, false);
    await form
      .getByRole("button", { name: "设置密码并登录", exact: true })
      .click();
    await expect(error(page)).toContainText("离线");
    await expect(form.getByLabel("临时密码", { exact: true })).toHaveValue(
      admin.password,
    );
    await expect(form.getByLabel(/^新密码/)).toHaveValue(nextPassword);
    await expect(form.getByLabel("确认新密码", { exact: true })).toHaveValue(
      nextPassword,
    );
    expect(activity).toEqual({ writes: 1, reads: 0, dialogs: 0 });
    const updated = await db.adminCredential.findUniqueOrThrow({
      where: { id: admin.id },
    });
    expect(updated.mustChangePassword).toBe(true);
    expect(updated.sessionVersion).toBe(admin.sessionVersion);
    expect(await verifyPasswordHash(admin.password, updated.passwordHash)).toBe(
      true,
    );
  } finally {
    await closePage(page);
    await cleanManager(admin.id);
  }
});

test("simulated PASSWORD_CHANGED closes an authenticated page but first login can return and retry manually", async ({
  page,
  context,
  browser,
}) => {
  const admin = await manager(),
    first = await manager();
  await db.adminCredential.update({
    where: { id: first.id },
    data: { mustChangePassword: true },
  });
  const guestContext = await browser.newContext({
    baseURL: process.env.TEST_BASE_URL,
    viewport: page.viewportSize(),
  });
  let guest: Page | undefined;
  const conflict = {
    code: "PASSWORD_CHANGED",
    error: "管理员密码已被修改，请重新登录",
  };
  try {
    await authenticate(context, admin);
    await installClock(page);
    await page.goto("/admin/password", { waitUntil: "networkidle" });
    const form = formWith(page, "修改管理员密码"),
      nextPassword = secret();
    await form.getByLabel("当前密码", { exact: true }).fill(admin.password);
    await form.getByLabel(/^新密码/).fill(nextPassword);
    await form.getByLabel("确认新密码", { exact: true }).fill(nextPassword);
    await freeze(page);
    const activity = counts(page);
    await page.route("**/api/admin/session", async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      // The lock-time conflict is injected; real 401 revocation is covered above.
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify(conflict),
      });
    });
    await form.getByRole("button", { name: "修改密码", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "管理会话已结束", exact: true }),
    ).toBeVisible();
    await expect(form).toHaveCount(0);
    expect(activity.writes).toBe(1);
    expect(activity.reads).toBe(0);

    guest = await guestContext.newPage();
    await installClock(guest);
    await guest.goto("/admin", { waitUntil: "networkidle" });
    let login = formWith(guest, "管理员登录");
    await login.getByLabel("账号", { exact: true }).fill(first.username);
    await login.getByLabel("密码", { exact: true }).fill(first.password);
    await freeze(guest);
    const anonymous = counts(guest);
    await guest.route("**/api/admin/session", async (route) => {
      if (
        route.request().method() !== "POST" ||
        !route.request().postDataJSON().newPassword
      )
        return route.continue();
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify(conflict),
      });
    });
    await login.getByRole("button", { name: "登录", exact: true }).click();
    login = formWith(guest, "设置管理员密码");
    await expect(login).toBeVisible();
    await login.getByLabel(/^新密码/).fill(nextPassword);
    await login.getByLabel("确认新密码", { exact: true }).fill(nextPassword);
    await login
      .getByRole("button", { name: "设置密码并登录", exact: true })
      .click();
    await expect(error(guest)).toContainText(conflict.error);
    await expect(login.getByLabel(/^新密码/)).toHaveValue(nextPassword);
    await expect(
      guest.getByRole("heading", { name: "管理会话已结束", exact: true }),
    ).toHaveCount(0);
    expect(anonymous.writes).toBe(2);
    expect(anonymous.reads).toBe(0);
    await login.getByRole("button", { name: "返回登录", exact: true }).click();
    login = formWith(guest, "管理员登录");
    await login.getByLabel("密码", { exact: true }).fill(first.password);
    await login.getByRole("button", { name: "登录", exact: true }).click();
    await expect(formWith(guest, "设置管理员密码")).toBeVisible();
    expect(anonymous.writes).toBe(3);
    expect(anonymous.reads).toBe(0);
    for (const original of [admin, first]) {
      const record = await db.adminCredential.findUniqueOrThrow({
        where: { id: original.id },
      });
      expect(record.sessionVersion).toBe(original.sessionVersion);
      expect(
        await verifyPasswordHash(original.password, record.passwordHash),
      ).toBe(true);
    }
  } finally {
    if (guest) await closePage(guest);
    await guestContext.close();
    await closePage(page);
    await cleanManager(admin.id);
    await cleanManager(first.id);
  }
});

test("losing connectivity while the confirmation dialog is open prevents every administrative write", async ({
  browser,
  page,
}) => {
  for (const kind of kinds) {
    const context = await browser.newContext({
      baseURL: process.env.TEST_BASE_URL,
      viewport: page.viewportSize(),
    });
    const view = await context.newPage();
    const fixture = await scenario(kind, view, context);
    try {
      await view.evaluate(() => {
        const state = window as unknown as {
          adminOnline: boolean;
          confirmations: number;
        };
        state.confirmations = 0;
        window.confirm = () => {
          state.confirmations++;
          state.adminOnline = false;
          return true;
        };
      });
      const button =
        kind === "trash"
          ? view.getByRole("button", { name: "永久删除", exact: true })
          : fixture.button;
      await button.click();
      await expect(error(view)).toContainText("离线");
      expect(
        await view.evaluate(
          () => (window as unknown as { confirmations: number }).confirmations,
        ),
      ).toBe(1);
      expect(fixture.activity).toEqual({ writes: 0, reads: 0, dialogs: 0 });
      await fixture.retained();
      await fixture.committed(false);
    } finally {
      await fixture.cleanup();
      await context.close();
    }
  }
});
