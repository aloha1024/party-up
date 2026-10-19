import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

const password = "autofill-browser-password";
const username = () =>
  "autofill_" + randomUUID().replaceAll("-", "").slice(0, 16);
const origin = { Origin: process.env.TEST_BASE_URL! };
const formWith = (page: Page, heading: string) =>
  page.locator("form").filter({
    has: page.getByRole("heading", { name: heading, exact: true }),
  });

async function register(context: BrowserContext, name: string) {
  const response = await context.request.post("/api/user/register", {
    headers: origin,
    data: { username: name, nickname: "自动填充测试", password },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).data as { recoveryCode: string };
}
async function login(page: Page, name: string, secret: string) {
  await page.goto("/account/login");
  await page.getByLabel("用户名", { exact: true }).fill(name);
  await page.getByLabel("密码", { exact: true }).fill(secret);
  await page.getByRole("button", { name: "登录账号", exact: true }).click();
  await expect(page).toHaveURL(/\/account$/);
}

test("ordinary password fields explicitly distinguish saved and new passwords", async ({
  page,
  context,
}) => {
  for (const [mode, purpose] of [
    ["login", "current-password"],
    ["register", "new-password"],
    ["recover", "new-password"],
  ] as const) {
    await page.goto(`/account/${mode}`);
    await expect(page.locator('input[name="username"]')).toHaveAttribute(
      "autocomplete",
      "username",
    );
    await expect(page.locator('input[name="password"]')).toHaveAttribute(
      "autocomplete",
      purpose,
    );
    const confirmation = page.locator('input[name="confirmation"]');
    if (mode === "login") await expect(confirmation).toHaveCount(0);
    else
      await expect(confirmation).toHaveAttribute(
        "autocomplete",
        "new-password",
      );
    if (mode === "recover")
      await expect(page.getByLabel("恢复码", { exact: true })).toHaveAttribute(
        "autocomplete",
        "off",
      );
  }

  const name = username();
  await register(context, name);
  await page.goto("/account");
  const change = formWith(page, "修改密码");
  const recovery = formWith(page, "生成新的恢复码");
  for (const form of [change, recovery]) {
    await expect(form.getByLabel("当前密码", { exact: true })).toHaveAttribute(
      "autocomplete",
      "current-password",
    );
    const association = form.locator('input[autocomplete="username"]');
    await expect(association).toHaveValue(name);
    await expect(association).toBeHidden();
    await expect(association).toHaveJSProperty("readOnly", true);
    expect(await association.getAttribute("id")).toBeTruthy();
    expect(await association.getAttribute("name")).toBeNull();
    expect(
      await form.evaluate((node) =>
        new FormData(node as HTMLFormElement).has("username"),
      ),
    ).toBe(false);
  }
  for (const label of ["新密码", "确认新密码"])
    await expect(change.getByLabel(label, { exact: true })).toHaveAttribute(
      "autocomplete",
      "new-password",
    );
});

test("registration and login preserve validation, exact JSON bodies and entered passwords", async ({
  page,
}) => {
  const name = username();
  const writes: { path: string; data: Record<string, string> }[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() === "POST" &&
      ["/api/user/register", "/api/user/session"].includes(path)
    )
      writes.push({ path, data: request.postDataJSON() });
  });
  await page.goto("/account/register");
  await page.getByLabel("用户名", { exact: true }).fill(name);
  await page.getByLabel("默认昵称", { exact: true }).fill("自动填充注册");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page
    .getByLabel("确认密码", { exact: true })
    .fill(password + "mismatch");
  await page.getByRole("button", { name: "注册账号", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "两次输入的密码不一致",
  );
  expect(writes).toHaveLength(0);
  await expect(page.getByLabel("密码", { exact: true })).toHaveValue(password);
  await page.getByLabel("确认密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "注册账号", exact: true }).click();
  await expect(page.getByLabel("恢复码", { exact: true })).toHaveText(
    /^[a-f0-9]{64}$/,
  );
  expect(writes).toEqual([
    {
      path: "/api/user/register",
      data: { username: name, nickname: "自动填充注册", password },
    },
  ]);
  await page.getByRole("button", { name: "我已保存，进入账号" }).click();
  await page.getByRole("button", { name: "退出账号，使用游客模式" }).click();
  await expect(page).toHaveURL(new URL("/", process.env.TEST_BASE_URL!).href);
  await page.goto("/account/login");
  await page.getByLabel("用户名", { exact: true }).fill(name);
  await page.getByLabel("密码", { exact: true }).fill(password + "wrong");
  const rejected = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/user/session" &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "登录账号", exact: true }).click();
  expect((await rejected).ok()).toBe(false);
  await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
  await expect(page.getByLabel("密码", { exact: true })).toHaveValue(
    password + "wrong",
  );
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录账号", exact: true }).click();
  await expect(page).toHaveURL(/\/account$/);
  expect(writes.slice(1)).toEqual([
    {
      path: "/api/user/session",
      data: { username: name, password: password + "wrong" },
    },
    { path: "/api/user/session", data: { username: name, password } },
  ]);
});

test("account verification, password change and recovery submit their original fields once", async ({
  page,
  context,
}) => {
  const name = username();
  await register(context, name);
  const writes: { path: string; data: Record<string, string> }[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() === "POST" &&
      [
        "/api/user/recovery",
        "/api/user/password",
        "/api/user/recovery/reset",
      ].includes(path)
    )
      writes.push({ path, data: request.postDataJSON() });
  });
  await page.goto("/account");
  const recovery = formWith(page, "生成新的恢复码");
  await recovery.getByLabel("当前密码", { exact: true }).fill(password);
  await recovery
    .getByRole("button", { name: "生成恢复码", exact: true })
    .click();
  const output = page.getByLabel("恢复码", { exact: true });
  await expect(output).toHaveText(/^[a-f0-9]{64}$/);
  const recoveryCode = (await output.textContent())!;
  expect(writes).toEqual([{ path: "/api/user/recovery", data: { password } }]);
  await page.getByRole("button", { name: "我已保存，进入账号" }).click();

  const changed = password + "changed";
  const change = formWith(page, "修改密码");
  await change.getByLabel("当前密码", { exact: true }).fill(password);
  await change.getByLabel("新密码", { exact: true }).fill(changed);
  await change
    .getByLabel("确认新密码", { exact: true })
    .fill(changed + "mismatch");
  await change.getByRole("button", { name: "修改密码并重新登录" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "两次输入的密码不一致",
  );
  expect(writes).toHaveLength(1);
  await expect(change.getByLabel("当前密码", { exact: true })).toHaveValue(
    password,
  );
  await change.getByLabel("确认新密码", { exact: true }).fill(changed);
  await change.getByRole("button", { name: "修改密码并重新登录" }).click();
  await expect(page).toHaveURL(/\/account\/login$/);
  expect(writes[1]).toEqual({
    path: "/api/user/password",
    data: { currentPassword: password, password: changed },
  });
  await login(page, name, changed);

  const recovered = password + "recovered";
  await page.goto("/account/recover");
  await page.getByLabel("用户名", { exact: true }).fill(name);
  await page.getByLabel("恢复码", { exact: true }).fill(recoveryCode);
  await page.getByLabel("新密码", { exact: true }).fill(recovered);
  await page.getByLabel("确认密码", { exact: true }).fill(recovered);
  await page.getByRole("button", { name: "找回密码", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("密码已重置");
  expect(writes).toHaveLength(3);
  expect(writes[2]).toEqual({
    path: "/api/user/recovery/reset",
    data: { username: name, recoveryCode, password: recovered },
  });
  await expect(page.getByLabel("新密码", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("恢复码", { exact: true })).toHaveValue("");
  await login(page, name, recovered);
});
