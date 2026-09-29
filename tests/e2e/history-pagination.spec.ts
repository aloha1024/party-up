import "../support/isolated";
import { test, expect, type Page, type Route } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { db } from "../../server/db";
import { createReservation } from "../../server/reservations";
import { hashToken } from "../../server/hash-token";
import { ensureAdminRecord } from "../../server/admin";
import { ADMIN_COOKIE, createAdminSession } from "../../server/admin-auth";

const token = () => randomBytes(32).toString("hex");
const adapters = [
  {
    kind: "history",
    region: "变更记录",
    entry: "data-change-id",
    more: "加载更早记录",
    retry: "重试加载记录",
  },
  {
    kind: "roster-removals",
    region: "报名移除记录",
    entry: "data-removal-id",
    more: "加载更早移除记录",
    retry: "重试加载移除记录",
  },
] as const;

async function fixture(owner: string, count = 35) {
  const r = await createReservation(
    {
      gameName: "分页生命周期" + token().slice(0, 6),
      hostName: "分页队长",
      description: "分页初始内容",
      maxPlayers: 3,
      scheduledAt: new Date(Date.now() + 86400000).toISOString(),
    },
    owner,
  );
  await db.reservationChange.createMany({
    data: Array.from({ length: count }, () => ({
      reservationId: r.id,
      action: "EDIT",
      actorRole: "HOST",
      fields: JSON.stringify(["description"]),
    })),
  });
  await db.rosterRemoval.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      reservationId: r.id,
      kind: "participants",
      entryId: "fixture-" + i,
      targetTokenHash: hashToken(token()),
      targetName: "分页成员" + i,
      reason: "分页原因" + i,
      actorRole: "HOST",
    })),
  });
  return r;
}

async function openFrozen(page: Page, id: string) {
  await page.clock.install({ time: new Date() });
  await page.goto(`/reservation/${id}`);
  await expect(
    page.getByRole("heading", { name: "变更记录", exact: true }),
  ).toBeVisible();
  // Freeze after hydration; each test explicitly advances event deduplication.
  await expect(page.getByRole("link", { name: "返回预约大厅" })).toBeVisible();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
}

async function refreshWithMarker(
  page: Page,
  id: string,
  marker: string,
  event = "focus",
) {
  await db.gameReservation.update({
    where: { id },
    data: { description: marker },
  });
  await page.clock.runFor(1100);
  await page.evaluate((event) => window.dispatchEvent(new Event(event)), event);
  await expect(page.getByText(marker, { exact: true })).toBeVisible();
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Fulfillment = Parameters<Route["fulfill"]>[0];
async function holdPages(page: Page, path: string) {
  const pending: { finish: (override?: Fulfillment) => Promise<void> }[] = [];
  await page.route(`**${path}?*`, async (route) => {
    const response = await route.fetch();
    const released = deferred();
    const delivered = deferred();
    let override: Fulfillment | undefined;
    pending.push({
      async finish(value) {
        override = value;
        released.resolve();
        await delivered.promise;
        await page.clock.runFor(10);
      },
    });
    await released.promise;
    try {
      await route.fulfill(override ?? { response });
    } finally {
      delivered.resolve();
    }
  });
  return pending;
}

async function pauseWithRename(page: Page, id: string) {
  const reached = deferred();
  const released = deferred();
  await page.route(
    `**/api/reservations/${id}/participants`,
    async (route) => {
      reached.resolve();
      await released.promise;
      await route.fulfill({ status: 409, json: { error: "请保留输入后重试" } });
    },
    { times: 1 },
  );
  await page.getByRole("button", { name: "修改昵称", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("新昵称").fill("尚未提交的新昵称");
  await dialog.getByRole("button", { name: "保存昵称", exact: true }).click();
  await reached.promise;
  await expect(dialog.getByLabel("新昵称")).toBeDisabled();
  return async () => {
    released.resolve();
    await expect(dialog.getByRole("alert")).toHaveText("请保留输入后重试");
    await expect(dialog.getByLabel("新昵称")).toHaveValue("尚未提交的新昵称");
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  };
}

test.afterAll(async () => {
  await db.$disconnect();
});

for (const adapter of adapters) {
  test(`${adapter.kind}: same-head refresh does not fetch and failed paging needs explicit retry`, async ({
    page,
    context,
  }) => {
    const owner = token();
    const r = await fixture(owner);
    let reads = 0;
    let fail = true;
    const path = `/api/reservations/${r.id}/${adapter.kind}`;
    try {
      await context.addCookies([
        {
          name: "party_identity",
          value: owner,
          url: process.env.TEST_BASE_URL!,
        },
      ]);
      await page.route(`**${path}?*`, async (route) => {
        reads++;
        if (fail)
          await route.fulfill({
            status: 200,
            json: { data: { items: "invalid" } },
          });
        else await route.continue();
      });
      await openFrozen(page, r.id);
      const region = page.getByRole("region", {
        name: adapter.region,
        exact: true,
      });
      const entries = region.locator(`[${adapter.entry}]`);
      await expect(entries).toHaveCount(10);
      expect(reads).toBe(0);
      await refreshWithMarker(page, r.id, "同一历史头刷新");
      expect(reads).toBe(0);
      await region
        .getByRole("button", { name: adapter.more, exact: true })
        .click();
      await expect(region.getByRole("alert")).toContainText(
        "服务器返回内容异常",
      );
      expect(reads).toBe(1);
      fail = false;
      await refreshWithMarker(page, r.id, "失败后仍等待明确重试", "online");
      await expect(entries).toHaveCount(10);
      await expect(
        region.getByRole("button", { name: adapter.retry, exact: true }),
      ).toBeEnabled();
      expect(reads).toBe(1);
      await region
        .getByRole("button", { name: adapter.retry, exact: true })
        .click();
      await expect(entries).toHaveCount(20);
      expect(reads).toBe(2);
      await refreshWithMarker(page, r.id, "加载后同一历史头刷新");
      await expect(entries).toHaveCount(20);
      expect(reads).toBe(2);
    } finally {
      await db.gameReservation.delete({ where: { id: r.id } });
    }
  });

  test(`${adapter.kind}: paused paging resumes once and ignores superseded errors and success`, async ({
    page,
    context,
  }) => {
    test.setTimeout(60000);
    const owner = token();
    const r = await fixture(owner);
    const pending = await holdPages(
      page,
      `/api/reservations/${r.id}/${adapter.kind}`,
    );
    try {
      await context.addCookies([
        {
          name: "party_identity",
          value: owner,
          url: process.env.TEST_BASE_URL!,
        },
      ]);
      await openFrozen(page, r.id);
      const region = page.getByRole("region", {
        name: adapter.region,
        exact: true,
      });
      const entries = region.locator(`[${adapter.entry}]`);
      for (let round = 0; round < 2; round++) {
        const offset = round * 2;
        const count = 10 + round * 10;
        await region
          .getByRole("button", { name: adapter.more, exact: true })
          .click();
        await expect.poll(() => pending.length).toBe(offset + 1);
        const resume = await pauseWithRename(page, r.id);
        await expect(region.getByRole("button")).toBeDisabled();
        await page.clock.runFor(100);
        expect(pending.length).toBe(offset + 1);
        await resume();
        await expect.poll(() => pending.length).toBe(offset + 2);
        await expect(
          region.getByRole("button", { name: "正在加载…", exact: true }),
        ).toBeDisabled();
        await pending[offset].finish(
          round === 0
            ? {
                status: 403,
                json: { error: "已失效的旧分页响应", code: "USER_SESSION" },
              }
            : undefined,
        );
        await expect(entries).toHaveCount(count);
        await expect(region.getByRole("alert")).toHaveCount(0);
        await expect(
          region.getByRole("button", { name: "正在加载…", exact: true }),
        ).toBeDisabled();
        expect(pending.length).toBe(offset + 2);
        await pending[offset + 1].finish();
        await expect(entries).toHaveCount(count + 10);
        await expect(
          region.getByRole("button", { name: adapter.more, exact: true }),
        ).toBeEnabled();
      }
      const ids = await entries.evaluateAll(
        (nodes, attr) => nodes.map((node) => Number(node.getAttribute(attr))),
        adapter.entry,
      );
      expect(new Set(ids).size).toBe(30);
      expect(ids).toEqual([...ids].sort((a, b) => b - a));
      expect(pending.length).toBe(4);
    } finally {
      // Release any gated request even when an assertion fails.
      for (const request of pending) await request.finish();
      await db.gameReservation.delete({ where: { id: r.id } });
    }
  });

  test(`${adapter.kind}: navigation discards loaded pages and late permission errors`, async ({
    page,
    context,
  }) => {
    const owner = token();
    const first = await fixture(owner);
    const second = await fixture(owner, 1);
    const pending = await holdPages(
      page,
      `/api/reservations/${first.id}/${adapter.kind}`,
    );
    try {
      await context.addCookies([
        {
          name: "party_identity",
          value: owner,
          url: process.env.TEST_BASE_URL!,
        },
      ]);
      await openFrozen(page, first.id);
      const region = page.getByRole("region", {
        name: adapter.region,
        exact: true,
      });
      await region
        .getByRole("button", { name: adapter.more, exact: true })
        .click();
      await expect.poll(() => pending.length).toBe(1);
      // A real Next Link unmounts the panel without destroying its JS document.
      await page.getByRole("link", { name: "返回预约大厅" }).click();
      await expect(page).toHaveURL(process.env.TEST_BASE_URL! + "/");
      let lateRefreshes = 0;
      page.on("request", (req) => {
        if (
          req.headers().rsc === "1" &&
          !req.headers()["next-router-prefetch"] &&
          new URL(req.url()).pathname === "/"
        )
          lateRefreshes++;
      });
      await pending[0].finish({
        status: 403,
        json: { error: "旧页面失效", code: "VIEWER_CHANGED" },
      });
      expect(lateRefreshes).toBe(0);
      await expect(region).toHaveCount(0);
      // The frozen clock belongs to the completed late-response assertion.
      // Let the next document finish its normal hydration before checking reset.
      await page.clock.resume();
      await page.goto(`/reservation/${second.id}`);
      await expect(region.locator(`[${adapter.entry}]`)).toHaveCount(1);
      await expect(region.getByRole("alert")).toHaveCount(0);
      await expect(region.getByRole("button")).toHaveCount(0);
    } finally {
      for (const request of pending) await request.finish();
      await db.gameReservation.deleteMany({
        where: { id: { in: [first.id, second.id] } },
      });
    }
  });
}

test("private pagination clears old permission scope and ignores its late response", async ({
  page,
  context,
}) => {
  const owner = token();
  const r = await fixture(owner);
  const root = await ensureAdminRecord();
  const admin = await db.adminCredential.create({
    data: {
      username: "paging-" + token().slice(0, 12),
      passwordHash: root.passwordHash,
      mustChangePassword: false,
    },
  });
  const pending = await holdPages(
    page,
    `/api/reservations/${r.id}/roster-removals`,
  );
  try {
    await context.addCookies([
      {
        name: "party_identity",
        value: token(),
        url: process.env.TEST_BASE_URL!,
      },
      {
        name: ADMIN_COOKIE,
        value: createAdminSession(admin.id, 0),
        url: process.env.TEST_BASE_URL!,
      },
    ]);
    await openFrozen(page, r.id);
    const region = page.getByRole("region", {
      name: "报名移除记录",
      exact: true,
    });
    await expect(region.locator("[data-removal-id]")).toHaveCount(10);
    await region
      .getByRole("button", { name: "加载更早移除记录", exact: true })
      .click();
    await expect.poll(() => pending.length).toBe(1);
    await page.getByLabel("你的昵称").fill("权限切换保留昵称");
    await db.adminCredential.update({
      where: { id: admin.id },
      data: { isActive: false },
    });
    await refreshWithMarker(page, r.id, "新的私密查看范围");
    await expect(region).toHaveCount(0);
    let lateRefreshes = 0;
    page.on("request", (req) => {
      if (
        req.headers().rsc === "1" &&
        !req.headers()["next-router-prefetch"] &&
        new URL(req.url()).pathname === `/reservation/${r.id}`
      )
        lateRefreshes++;
    });
    await pending[0].finish({
      status: 403,
      json: { error: "旧范围失效", code: "VIEWER_CHANGED" },
    });
    expect(lateRefreshes).toBe(0);
    await expect(region).toHaveCount(0);
    await expect(page.getByLabel("你的昵称")).toHaveValue("权限切换保留昵称");
  } finally {
    for (const request of pending) await request.finish();
    await db.gameReservation.delete({ where: { id: r.id } });
    await db.adminCredential.delete({ where: { id: admin.id } });
  }
});
