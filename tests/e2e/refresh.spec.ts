import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

async function clock(page: Page) {
  const now = new Date();
  await page.clock.install({ time: now });
  await page.addInitScript(() => {
    const schedule = window.setTimeout.bind(window);
    (window as any).refreshDelays = [];
    window.setTimeout = ((
      handler: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay && delay >= 13500 && delay <= 60000)
        (window as any).refreshDelays.push(delay);
      return schedule(handler, delay, ...args);
    }) as typeof window.setTimeout;
  });
  return now;
}
async function waitForInterval(page: Page, min: number, max: number) {
  await expect
    .poll(() =>
      page.evaluate(
        ({ min, max }) => {
          const last = (window as any).refreshDelays.at(-1);
          return last >= min && last <= max;
        },
        { min, max },
      ),
    )
    .toBe(true);
}

for (const path of ["/", "/my-reservations"]) {
  test(`idle ${path} reduces actual refresh requests and resets after returning to the tab`, async ({
    page,
  }) => {
    const now = await clock(page);
    await page.goto(path + "?q=" + randomUUID());
    await expect(
      page.getByText(
        path === "/" ? "没有符合条件的预约" : "暂无当前浏览器的预约记录",
        { exact: true },
      ),
    ).toBeVisible();
    await waitForInterval(page, 13500, 15000);
    await page.clock.pauseAt(new Date(now.getTime() + 2000));
    let reads = 0;
    page.on("request", (req) => {
      if (
        req.headers().rsc === "1" &&
        !req.headers()["next-router-prefetch"] &&
        new URL(req.url()).pathname === path
      )
        reads++;
    });
    await page.clock.runFor(15000);
    await waitForInterval(page, 27000, 30000);
    expect(reads).toBe(1);
    await page.clock.runFor(20000);
    expect(reads).toBe(1);
    await page.clock.runFor(10000);
    await waitForInterval(page, 54000, 60000);
    expect(reads).toBe(2);
    await page.clock.runFor(40000);
    expect(reads).toBe(2);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => reads).toBe(3);
    await waitForInterval(page, 13500, 15000);
    // A changed scope must also reset to the base cadence.
    await page.clock.resume();
    await page.goto(path + "?q=" + randomUUID());
    await waitForInterval(page, 13500, 15000);
  });
}

test("detail refresh stays timely and preserves an unfinished nickname", async ({
  page,
  request,
}) => {
  const origin = process.env.TEST_BASE_URL!;
  await request.post("/api/identity", { headers: { Origin: origin } });
  const created = await request.post("/api/reservations", {
    headers: { Origin: origin, "Idempotency-Key": randomUUID() },
    data: {
      gameName: "Refresh-" + randomUUID(),
      hostName: "Host",
      scheduledAt: new Date(Date.now() + 86400000).toISOString(),
      maxPlayers: 3,
    },
  });
  expect(created.ok()).toBe(true);
  const { data } = await created.json();
  const now = await clock(page);
  await page.goto("/reservation/" + data.id);
  const input = page.getByLabel("你的昵称");
  await input.fill("还没提交的昵称");
  await waitForInterval(page, 13500, 15000);
  await page.clock.pauseAt(new Date(now.getTime() + 2000));
  for (let i = 0; i < 2; i++) {
    const edited = await request.patch("/api/reservations/" + data.id, {
      headers: { Origin: origin },
      data: {
        gameName: data.gameName,
        hostName: "Host",
        scheduledAt: data.scheduledAt,
        maxPlayers: 3,
        description: `Updated notes ${i}`,
        editVersion: i,
      },
    });
    expect(edited.ok()).toBe(true);
    const response = page.waitForResponse(
      (res) =>
        res.request().headers().rsc === "1" &&
        new URL(res.url()).pathname === "/reservation/" + data.id,
    );
    await page.clock.runFor(15000);
    await response;
    await expect(
      page.getByText(`Updated notes ${i}`, { exact: true }),
    ).toBeVisible();
    await waitForInterval(page, 13500, 15000);
    await expect(input).toHaveValue("还没提交的昵称");
  }
});

test("cancellation pauses detail refresh until the operation completes", async ({
  page,
}) => {
  const origin = process.env.TEST_BASE_URL!;
  await page.request.post("/api/identity", { headers: { Origin: origin } });
  const created = await page.request.post("/api/reservations", {
    headers: { Origin: origin, "Idempotency-Key": randomUUID() },
    data: {
      gameName: "Cancel-refresh-" + randomUUID(),
      hostName: "Host",
      scheduledAt: new Date(Date.now() + 86400000).toISOString(),
      maxPlayers: 3,
    },
  });
  expect(created.ok()).toBe(true);
  const { data } = await created.json();
  const now = await clock(page);
  await page.goto("/reservation/" + data.id);
  await waitForInterval(page, 13500, 15000);
  await page.clock.pauseAt(new Date(now.getTime() + 2000));
  let release!: () => void;
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/reservations/*/cancel", async (route) => {
    entered();
    await held;
    await route.continue();
  });
  let reads = 0;
  page.on("request", (req) => {
    if (
      req.headers().rsc === "1" &&
      !req.headers()["next-router-prefetch"] &&
      new URL(req.url()).pathname === "/reservation/" + data.id
    )
      reads++;
  });
  await page.evaluate(() => {
    window.confirm = () => true;
  });
  await page.getByRole("button", { name: "取消预约", exact: true }).click();
  await page.getByLabel("取消原因", { exact: true }).fill("测试取消原因");
  try {
    await page.getByRole("button", { name: "确认取消", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "正在取消…", exact: true }),
    ).toBeDisabled();
    await reached;
    const before = reads;
    await page.clock.runFor(14000);
    expect(reads).toBe(before);
  } finally {
    release();
  }
  await expect(page.getByText("测试取消原因", { exact: true })).toBeVisible();
});
