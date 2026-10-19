import "../support/isolated";
import { test, expect, type Page } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../../server/db";
import { digest } from "../../server/user-identity";
import { ADMIN_COOKIE, createAdminSession } from "../../server/admin-auth";
import { ensureAdminRecord } from "../../server/admin";

test.afterAll(async () => {
  await db.$disconnect();
});

type Item = {
  id: string;
  gameName: string;
  platform: string;
  gameServer: string;
};
async function fixture(owner: string, ids: string[]) {
  const q = "Platforms-" + randomUUID();
  const date = new Date(Date.now() + 2 * 86400000 + 8 * 3600000)
    .toISOString()
    .slice(0, 10);
  const at = new Date(`${date}T12:00:00+08:00`).getTime();
  const records: Record<
    string,
    {
      platform?: string;
      gameServer?: string;
      status?: string;
      nextDay?: boolean;
    }
  > = {
    first: { platform: "PC Windows", gameServer: "亚洲一区" },
    second: { platform: "PC Linux", gameServer: "亚洲二区" },
    otherPlatform: { platform: "PS5", gameServer: "亚洲一区" },
    otherServer: { platform: "PC Windows", gameServer: "欧洲一区" },
    legacy: {},
    cancelled: {
      platform: "PC Windows",
      gameServer: "亚洲一区",
      status: "CANCELLED",
    },
    otherDate: {
      platform: "PC Windows",
      gameServer: "亚洲一区",
      nextDay: true,
    },
    fullWidth: { platform: "ＰＣ", gameServer: "亚洲一区" },
    long: { platform: "P".repeat(80), gameServer: "服".repeat(80) },
  };
  const items: Record<string, Item> = {};
  for (const [index, [name, record]] of Object.entries(records).entries()) {
    const { nextDay, ...fields } = record;
    const item = await db.gameReservation.create({
      data: {
        gameName: `${q}-${name}`,
        hostName: "筛选队长",
        hostTokenHash: digest(owner),
        scheduledAt: new Date(at + index * 60000 + (nextDay ? 86400000 : 0)),
        maxPlayers: 3,
        ...fields,
        participants: {
          create: {
            name: "筛选队长",
            nameKey: "筛选队长",
            tokenHash: digest(owner),
          },
        },
      },
    });
    ids.push(item.id);
    items[name] = item;
  }
  return { q, date, items };
}

function card(page: Page, item: Item) {
  return page.locator(`a[href="/reservation/${item.id}"]`);
}
async function assertQuery(
  page: Page,
  expected: Record<string, string | null>,
) {
  await expect
    .poll(() => {
      const query = new URL(page.url()).searchParams;
      return Object.fromEntries(
        Object.keys(expected).map((key) => [key, query.get(key)]),
      );
    })
    .toEqual(expected);
}
async function noHorizontalOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
}

for (const path of ["/", "/my-reservations", "/admin"] as const) {
  test(`platform and server filters on ${path} combine with existing filters and show only nonempty labels on narrow screens`, async ({
    page,
    context,
    baseURL,
  }, info) => {
    const owner = randomBytes(32).toString("hex");
    const ids: string[] = [];
    let adminId: number | undefined;
    try {
      const { q, date, items } = await fixture(owner, ids);
      await context.addCookies([
        { name: "party_identity", value: owner, url: baseURL! },
      ]);
      if (path === "/admin") {
        await ensureAdminRecord();
        const admin = await db.adminCredential.create({
          data: {
            username: "platforms-" + randomUUID(),
            passwordHash: "unused",
            mustChangePassword: false,
          },
        });
        adminId = admin.id;
        await context.addCookies([
          {
            name: ADMIN_COOKIE,
            value: createAdminSession(admin.id, admin.sessionVersion),
            url: baseURL!,
          },
        ]);
      }
      const tab = path === "/my-reservations" ? "&tab=joined" : "";
      await page.goto(`${path}?q=${q}&pageSize=1&page=3${tab}`);
      const form = page.getByRole("search", { name: "筛选预约" });
      const pagination = page.getByRole("navigation", { name: "预约分页" });
      await expect(form.getByLabel("平台", { exact: true })).toHaveAttribute(
        "name",
        "platform",
      );
      await expect(form.getByLabel("区服", { exact: true })).toHaveAttribute(
        "name",
        "gameServer",
      );
      for (const label of ["平台", "区服"])
        await expect(form.getByLabel(label, { exact: true })).toHaveAttribute(
          "maxlength",
          "80",
        );
      await form.getByLabel("平台", { exact: true }).fill(" PC ");
      await form.getByLabel("区服", { exact: true }).fill(" 亚洲 ");
      await form
        .getByRole("combobox", { name: "预约状态", exact: true })
        .selectOption("available");
      await form.getByLabel("开玩日期（北京时间）", { exact: true }).fill(date);
      await form.getByRole("button", { name: "筛选", exact: true }).click();
      const expected = {
        q,
        platform: "PC",
        gameServer: "亚洲",
        view: "available",
        date,
        pageSize: "1",
        tab: path === "/my-reservations" ? "joined" : null,
      };
      await assertQuery(page, { ...expected, page: null });
      await expect(form.getByLabel("平台", { exact: true })).toHaveValue("PC");
      await expect(form.getByLabel("区服", { exact: true })).toHaveValue(
        "亚洲",
      );
      await expect(card(page, items.first)).toBeVisible();
      await expect(pagination).toContainText("共 2 场");
      await expect(page.locator("[data-reservation-platform]")).toHaveText(
        "平台：PC Windows",
      );
      await expect(page.locator("[data-reservation-server]")).toHaveText(
        "区服：亚洲一区",
      );
      await pagination
        .getByRole("link", { name: "下一页", exact: true })
        .click();
      await assertQuery(page, { ...expected, page: "2" });
      await expect(card(page, items.second)).toBeVisible();
      await expect(card(page, items.first)).toHaveCount(0);
      await page.reload();
      await expect(card(page, items.second)).toBeVisible();
      await expect(form.getByLabel("平台", { exact: true })).toHaveValue("PC");
      await expect(form.getByLabel("区服", { exact: true })).toHaveValue(
        "亚洲",
      );

      // Each field narrows independently; the full-width platform remains distinct.
      await form.getByLabel("平台", { exact: true }).fill("");
      await form.getByRole("button", { name: "筛选", exact: true }).click();
      await assertQuery(page, { ...expected, platform: null, page: null });
      await expect(pagination).toContainText("共 4 场");
      await form.getByLabel("平台", { exact: true }).fill(" ＰＣ ");
      await form.getByRole("button", { name: "筛选", exact: true }).click();
      await assertQuery(page, { ...expected, platform: "ＰＣ", page: null });
      await expect(card(page, items.fullWidth)).toBeVisible();
      await expect(pagination).toContainText("共 1 场");
      await expect(form.getByLabel("平台", { exact: true })).toHaveValue(
        "ＰＣ",
      );
      await form.getByLabel("平台", { exact: true }).fill("PC");
      await form.getByLabel("区服", { exact: true }).fill("");
      await form.getByRole("button", { name: "筛选", exact: true }).click();
      await assertQuery(page, { ...expected, gameServer: null, page: null });
      await expect(pagination).toContainText("共 3 场");

      await form.getByLabel("平台", { exact: true }).fill("不存在的平台");
      await form.getByRole("button", { name: "筛选", exact: true }).click();
      await expect(
        page.getByText("没有符合条件的预约", { exact: true }),
      ).toBeVisible();
      await expect(pagination).toContainText("共 0 场");
      await expect(page.locator("[data-reservation-platform]")).toHaveCount(0);
      await expect(page.locator("[data-reservation-server]")).toHaveCount(0);

      await form.getByRole("link", { name: "重置", exact: true }).click();
      await assertQuery(page, {
        q: null,
        platform: null,
        gameServer: null,
        view: null,
        date: null,
        pageSize: null,
        page: null,
        tab: expected.tab,
      });
      await expect(form.getByLabel("平台", { exact: true })).toHaveValue("");
      await expect(form.getByLabel("区服", { exact: true })).toHaveValue("");
      await page.goto(`${path}?q=${items.legacy.gameName}${tab}`);
      await expect(card(page, items.legacy)).toBeVisible();
      await expect(page.locator("[data-reservation-platform]")).toHaveCount(0);
      await expect(page.locator("[data-reservation-server]")).toHaveCount(0);
      await page.goto(`${path}?q=${items.long.gameName}${tab}`);
      await expect(card(page, items.long)).toBeVisible();
      await expect(page.locator("[data-reservation-platform]")).toHaveText(
        `平台：${items.long.platform}`,
      );
      await expect(page.locator("[data-reservation-server]")).toHaveText(
        `区服：${items.long.gameServer}`,
      );
      await page.setViewportSize({ width: 320, height: 740 });
      await expect(form.getByLabel("平台", { exact: true })).toBeVisible();
      await expect(form.getByLabel("区服", { exact: true })).toBeVisible();
      await noHorizontalOverflow(page);
      await page.screenshot({
        path: info.outputPath("platform-filters.png"),
        fullPage: true,
      });
    } finally {
      await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
      if (adminId) await db.adminCredential.delete({ where: { id: adminId } });
    }
  });
}

test("personal platform filters survive category changes, browser back and a round trip through the schedule", async ({
  page,
  context,
  baseURL,
}) => {
  const owner = randomBytes(32).toString("hex");
  const ids: string[] = [];
  try {
    const { q, date, items } = await fixture(owner, ids);
    await context.addCookies([
      { name: "party_identity", value: owner, url: baseURL! },
    ]);
    const query = new URLSearchParams({
      tab: "joined",
      q,
      platform: "PC",
      gameServer: "亚洲",
      view: "available",
      date,
      pageSize: "1",
      page: "2",
    });
    await page.goto(`/my-reservations?${query}`);
    await expect(card(page, items.second)).toBeVisible();
    await page
      .getByRole("navigation", { name: "我的预约分类" })
      .getByRole("link", { name: "我发起的", exact: true })
      .click();
    await assertQuery(page, {
      ...Object.fromEntries(query),
      tab: "hosted",
      page: null,
    });
    await expect(card(page, items.first)).toBeVisible();
    await page.goBack();
    await assertQuery(page, Object.fromEntries(query));
    await expect(card(page, items.second)).toBeVisible();
    const views = page.getByRole("navigation", { name: "我的预约视图" });
    await views.getByRole("link", { name: "日程", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "我的日程." }),
    ).toBeVisible();
    await assertQuery(page, {
      ...Object.fromEntries(query),
      layout: "schedule",
    });
    await page.reload();
    await views.getByRole("link", { name: "列表", exact: true }).click();
    await assertQuery(page, { ...Object.fromEntries(query), layout: null });
    await expect(card(page, items.second)).toBeVisible();
    const form = page.getByRole("search", { name: "筛选预约" });
    await expect(form.getByLabel("搜索预约", { exact: true })).toHaveValue(q);
    await expect(form.getByLabel("平台", { exact: true })).toHaveValue("PC");
    await expect(form.getByLabel("区服", { exact: true })).toHaveValue("亚洲");
    await expect(
      form.getByRole("combobox", { name: "预约状态", exact: true }),
    ).toHaveValue("available");
    await expect(
      form.getByLabel("开玩日期（北京时间）", { exact: true }),
    ).toHaveValue(date);
    await page.setViewportSize({ width: 320, height: 740 });
    await noHorizontalOverflow(page);
  } finally {
    await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
  }
});

test("available platform filters refresh matching results and preserve literal all values", async ({
  page,
}) => {
  const q = "Platform-refresh-" + randomUUID();
  const item = await db.gameReservation.create({
    data: {
      gameName: q,
      hostName: "刷新队长",
      hostTokenHash: digest(randomBytes(32).toString("hex")),
      scheduledAt: new Date(Date.now() + 2 * 86400000),
      maxPlayers: 3,
      platform: "all",
      gameServer: "all",
    },
  });
  try {
    await page.clock.install({ time: new Date() });
    await page.addInitScript(() => {
      const schedule = window.setTimeout.bind(window);
      (window as any).platformRefreshDelays = [];
      window.setTimeout = ((
        handler: TimerHandler,
        delay?: number,
        ...args: unknown[]
      ) => {
        if (delay && delay >= 13500 && delay <= 15000)
          (window as any).platformRefreshDelays.push(delay);
        return schedule(handler, delay, ...args);
      }) as typeof window.setTimeout;
    });
    const intervalCount = () =>
      page.evaluate(
        () => (window as any).platformRefreshDelays.length as number,
      );
    const waitForNewInterval = async (previous: number) => {
      await expect.poll(intervalCount).toBeGreaterThan(previous);
    };
    await page.goto(`/?q=${q}`);
    await expect(card(page, item)).toBeVisible();
    await waitForNewInterval(0);
    const form = page.getByRole("search", { name: "筛选预约" });
    await form.getByLabel("平台", { exact: true }).fill("all");
    await form.getByLabel("区服", { exact: true }).fill("all");
    await form
      .getByRole("combobox", { name: "预约状态", exact: true })
      .selectOption("available");
    const beforeFilter = await intervalCount();
    await form.getByRole("button", { name: "筛选", exact: true }).click();
    const expected = {
      q,
      platform: "all",
      gameServer: "all",
      view: "available",
    };
    await assertQuery(page, expected);
    await expect(card(page, item)).toBeVisible();
    // Wait for hydration and the new filter scope to schedule its own timer.
    await waitForNewInterval(beforeFilter);
    await page.clock.pauseAt(
      new Date((await page.evaluate(() => Date.now())) + 1000),
    );

    for (const platform of ["PC", "all"]) {
      const previous = await intervalCount();
      const response = page.waitForResponse((res) => {
        const req = res.request();
        const url = new URL(res.url());
        return (
          req.headers().rsc === "1" &&
          !req.headers()["next-router-prefetch"] &&
          url.pathname === "/" &&
          Object.entries(expected).every(
            ([key, value]) => url.searchParams.get(key) === value,
          )
        );
      });
      await db.gameReservation.update({
        where: { id: item.id },
        data: { platform },
      });
      await page.clock.runFor(15000);
      await response;
      if (platform === "PC") {
        await expect(card(page, item)).toHaveCount(0);
        await expect(
          page.getByText("没有符合条件的预约", { exact: true }),
        ).toBeVisible();
      } else {
        await expect(card(page, item)).toBeVisible();
        await expect(page.locator("[data-reservation-platform]")).toHaveText(
          "平台：all",
        );
        await expect(page.locator("[data-reservation-server]")).toHaveText(
          "区服：all",
        );
      }
      await waitForNewInterval(previous);
      await assertQuery(page, expected);
      await expect(form.getByLabel("搜索预约", { exact: true })).toHaveValue(q);
      await expect(form.getByLabel("平台", { exact: true })).toHaveValue("all");
      await expect(form.getByLabel("区服", { exact: true })).toHaveValue("all");
      await expect(
        form.getByRole("combobox", { name: "预约状态", exact: true }),
      ).toHaveValue("available");
    }
  } finally {
    await db.gameReservation.deleteMany({ where: { id: item.id } });
  }
});
