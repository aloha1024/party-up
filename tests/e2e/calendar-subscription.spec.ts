import "../support/isolated";
import { test, expect } from "@playwright/test";
import { db } from "../../server/db";
import { createReservation } from "../../server/reservations";
import { registeredToken, browserCookie } from "../support/member";
test.afterAll(async () => {
  await db.$disconnect();
});
test("account calendar reveals link once, defaults public and explicit rotation can include invitations without private data", async ({
  page,
  context,
  baseURL,
}) => {
  const member = await registeredToken(),
    ids: string[] = [];
  try {
    for (const visibility of ["PUBLIC", "INVITE"]) {
      const r = await createReservation(
        {
          gameName: visibility === "PUBLIC" ? "公开订阅场次" : "邀请订阅场次",
          hostName: "队长",
          maxPlayers: 3,
          description: "订阅不应包含的备注",
          scheduledAt: new Date(Date.now() + 86400000).toISOString(),
          visibility,
        },
        member,
      );
      ids.push(r.id);
    }
    await context.addCookies([{ ...browserCookie(member), url: baseURL! }]);
    await page.goto("/account/calendar");
    await expect(page.getByRole("checkbox")).not.toBeChecked();
    page.once("dialog", (d) => d.accept());
    await page
      .getByRole("button", { name: "生成订阅链接", exact: true })
      .click();
    const field = page.getByLabel("日历订阅链接");
    await expect(field).toBeVisible();
    const first = await field.inputValue();
    const content = await (await context.request.get(first)).text();
    expect(content).toContain("公开订阅场次");
    expect(content).not.toContain("邀请订阅场次");
    expect(content).not.toContain("订阅不应包含的备注");
    const storage = await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    );
    expect(storage).not.toContain(new URL(first).searchParams.get("token")!);
    await page.getByRole("button", { name: "关闭链接", exact: true }).click();
    await expect(field).toHaveCount(0);
    await page.getByRole("checkbox").check();
    page.once("dialog", (d) => d.accept());
    await page
      .getByRole("button", { name: "更换订阅链接", exact: true })
      .click();
    await expect(field).toBeVisible();
    const second = await field.inputValue();
    expect(second).not.toBe(first);
    expect((await context.request.get(first)).status()).toBe(404);
    expect(await (await context.request.get(second)).text()).toContain(
      "邀请订阅场次",
    );
    await page.reload();
    await expect(field).toHaveCount(0);
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "停用订阅", exact: true }).click();
    await expect(
      page.getByText("订阅未启用或已失效", { exact: true }),
    ).toBeVisible();
    expect((await context.request.get(second)).status()).toBe(404);
  } finally {
    await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
  }
});
