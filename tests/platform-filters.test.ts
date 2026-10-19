import "./support/isolated";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "../server/db";
import { hashToken } from "../server/hash-token";
import {
  listAdminReservations,
  listMyReservations,
  listReservations,
} from "../server/reservation-list";
import {
  listSearchParams,
  myReservationListSchema,
  reservationListSchema,
  reservationListUrl,
} from "../lib/reservation-list";
import {
  personalPageSchema,
  personalPageUrl,
} from "../lib/reservation-schedule";

const ids: string[] = [];
const now = new Date("2030-01-01T12:00:00Z");
const token = () => randomBytes(32).toString("hex");
const roster = (...tokens: string[]) => ({
  create: tokens.map((value, index) => ({
    name: `Player ${index}`,
    nameKey: `player ${index}`,
    tokenHash: hashToken(value),
  })),
});
async function seed(
  q: string,
  suffix: string,
  overrides: Partial<Prisma.GameReservationCreateInput> = {},
) {
  const id = `${q}-${suffix}`;
  ids.push(id);
  return db.gameReservation.create({
    data: {
      id,
      gameName: q,
      hostName: "Host",
      platform: "Steam Deck",
      gameServer: "CN-East 1",
      scheduledAt: new Date(now.getTime() + 1000),
      maxPlayers: 3,
      ...overrides,
    },
  });
}
const rowIds = (page: Awaited<ReturnType<typeof listReservations>>) =>
  page.items.map((row) => row.id);
after(async () => {
  await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});

test("platform filters trim without Unicode normalization, reject duplicate or oversized values, and survive list/category/schedule URLs", () => {
  const defaults = reservationListSchema.parse({});
  assert.equal(defaults.platform, "");
  assert.equal(defaults.gameServer, "");
  const parsed = reservationListSchema.parse({
    q: " Ｓｔｅａｍ ",
    platform: " Ｓｔｅａｍ & + ",
    gameServer: " 东京 / A%_ ",
    view: "available",
    date: "2030-01-01",
    pageSize: 24,
    page: 8,
  });
  assert.equal(parsed.q, "Steam");
  assert.equal(parsed.platform, "Ｓｔｅａｍ & +");
  assert.equal(parsed.gameServer, "东京 / A%_");
  for (const field of ["platform", "gameServer"] as const) {
    assert.equal(
      reservationListSchema.parse({ [field]: ` ${"x".repeat(80)} ` })[field],
      "x".repeat(80),
    );
    assert.equal(reservationListSchema.parse({ [field]: " \t " })[field], "");
    for (const value of ["x".repeat(81), ["Steam", "Steam"], 1, null])
      assert.equal(
        reservationListSchema.safeParse({ [field]: value }).success,
        false,
        `${field}: ${JSON.stringify(value)}`,
      );
    assert.equal(
      reservationListSchema.safeParse(
        listSearchParams(new URLSearchParams(`${field}=first&${field}=second`)),
      ).success,
      false,
    );
  }
  for (const path of ["/", "/admin", "/my-reservations"] as const) {
    const url = new URL(
      reservationListUrl(path, parsed, 2, "waiting"),
      "http://localhost",
    );
    assert.equal(url.pathname, path);
    assert.deepEqual(
      reservationListSchema.parse(listSearchParams(url.searchParams)),
      {
        ...parsed,
        page: 2,
      },
    );
    assert.equal(
      url.searchParams.get("tab"),
      path === "/my-reservations" ? "waiting" : null,
    );
  }
  const personal = personalPageSchema.parse({ ...parsed, tab: "hosted" });
  const schedule = new URL(
    personalPageUrl(personal, {
      layout: "schedule",
      range: "today",
      schedulePage: 3,
    }),
    "http://localhost",
  );
  const scheduled = personalPageSchema.parse(
    Object.fromEntries(schedule.searchParams),
  );
  assert.equal(scheduled.platform, parsed.platform);
  assert.equal(scheduled.gameServer, parsed.gameServer);
  const back = new URL(
    personalPageUrl(scheduled, { layout: "list", tab: "joined", page: 1 }),
    "http://localhost",
  );
  const restored = personalPageSchema.parse(
    Object.fromEntries(back.searchParams),
  );
  assert.deepEqual(restored, {
    ...scheduled,
    layout: "list",
    tab: "joined",
    page: 1,
  });
  assert.equal(back.searchParams.has("page"), false);
  const cleared = new URL(
    reservationListUrl("/", { ...parsed, platform: "", gameServer: "" }, 1),
    "http://localhost",
  );
  assert.equal(cleared.searchParams.has("platform"), false);
  assert.equal(cleared.searchParams.has("gameServer"), false);
  assert.equal(
    myReservationListSchema.parse({ platform: " pc ", gameServer: " eu " })
      .platform,
    "pc",
  );
});

test("platform and server filters are ANDed before every status/date count and keep public summaries private", async () => {
  const q = randomUUID();
  const entries = [
    ["open", 1000, "OPEN"],
    ["full", 2000, "OPEN"],
    ["started", -2000, "OPEN"],
    ["cancelled", 3000, "CANCELLED"],
    ["ended", -1000, "ENDED"],
  ] as const;
  for (const [suffix, offset, status] of entries)
    await seed(q, suffix, {
      scheduledAt: new Date(now.getTime() + offset),
      status,
      participants:
        suffix === "full" ? roster(token(), token(), token()) : undefined,
      description: "summary-private-description",
      meetingCipher: "summary-private-cipher",
      inviteHash: "summary-private-invite",
    });
  await seed(q, "platform-mismatch", { platform: "Console" });
  await seed(q, "server-mismatch", { gameServer: "US-West" });
  await seed(q, "legacy-empty", { platform: "", gameServer: "" });
  await seed(q, "private", { visibility: "INVITE" });
  await seed(q, "deleted", { deletedAt: now });
  await seed(q, "next-day", {
    scheduledAt: new Date(now.getTime() + 86400000),
  });
  const filters = {
    q,
    platform: " steam ",
    gameServer: "east",
    date: "2030-01-01",
  };
  for (const [view, expected] of [
    ["all", ["open", "full", "cancelled", "started", "ended"]],
    ["upcoming", ["open", "full"]],
    ["available", ["open"]],
    ["started", ["started"]],
    ["cancelled", ["cancelled"]],
    ["ended", ["ended"]],
  ] as const) {
    const result = await listReservations({ ...filters, view }, now);
    assert.deepEqual(
      rowIds(result),
      expected.map((suffix) => `${q}-${suffix}`),
      view,
    );
    assert.equal(result.total, expected.length, view);
    for (const row of result.items) {
      assert.equal(row.platform, "Steam Deck");
      assert.equal(row.gameServer, "CN-East 1");
      for (const field of [
        "participants",
        "hostTokenHash",
        "meetingCipher",
        "inviteHash",
        "description",
      ])
        assert.equal(field in row, false, field);
    }
  }
  assert.equal((await listAdminReservations(filters, now)).total, 6);
  assert.equal(
    (await listReservations({ ...filters, gameServer: "" }, now)).total,
    6,
  );
  assert.equal(
    (await listReservations({ ...filters, platform: "" }, now)).total,
    6,
  );
  const unfiltered = await listReservations({ q, date: filters.date }, now);
  assert.equal(unfiltered.total, 8);
  assert.ok(rowIds(unfiltered).includes(`${q}-legacy-empty`));
  const blank = await listReservations(
    { q, date: filters.date, platform: "  ", gameServer: " " },
    now,
  );
  assert.deepEqual(blank, unfiltered);
});

test("available filtering paginates after both filters and capacity/recruitment checks, including empty and clamped pages", async () => {
  const q = randomUUID();
  const expected: string[] = [];
  for (let i = 0; i < 13; i++) {
    const available = i % 3 === 0;
    const row = await seed(q, String(i).padStart(2, "0"), {
      scheduledAt: new Date(now.getTime() + (i + 1) * 1000),
      ...(i % 3 === 1
        ? { participants: roster(token(), token(), token()) }
        : {}),
      ...(i % 3 === 2 ? { gameServer: "US-West" } : {}),
    });
    if (available) expected.push(row.id);
  }
  await seed(q, "paused", { recruitmentPaused: true });
  await seed(q, "deadline", { registrationDeadline: now });
  await seed(q, "private", { visibility: "INVITE" });
  await seed(q, "deleted", { deletedAt: now });
  const filters = {
    q,
    platform: "steam",
    gameServer: "east",
    view: "available",
    pageSize: 2,
  };
  const pages = [];
  for (const page of [1, 2, 999])
    pages.push(await listReservations({ ...filters, page }, now));
  assert.deepEqual(pages.flatMap(rowIds), expected);
  assert.deepEqual(
    pages.map((page) => [
      page.total,
      page.page,
      page.pageCount,
      page.items.length,
    ]),
    [
      [5, 1, 3, 2],
      [5, 2, 3, 2],
      [5, 3, 3, 1],
    ],
  );
  for (const view of ["all", "available"])
    for (const missing of [{ platform: "absent" }, { gameServer: "absent" }]) {
      const empty = await listReservations(
        { ...filters, ...missing, view, page: 99 },
        now,
      );
      assert.deepEqual(
        [empty.total, empty.page, empty.pageCount, empty.items.length],
        [0, 1, 1, 0],
      );
    }
});

test("personal platform filters retain hosted/joined/waiting scope across public and invitation rows without granting anonymous access", async () => {
  const q = randomUUID(),
    viewer = token(),
    other = token();
  for (const [tab, relation] of [
    ["hosted", { hostTokenHash: hashToken(viewer) }],
    ["joined", { participants: roster(viewer) }],
    ["waiting", { waitlist: roster(viewer) }],
  ] as const) {
    for (const visibility of ["PUBLIC", "INVITE"])
      await seed(q, `${tab}-${visibility}`, { ...relation, visibility });
    await seed(q, `${tab}-wrong-platform`, {
      ...relation,
      platform: "Console",
    });
    await seed(q, `${tab}-wrong-server`, {
      ...relation,
      gameServer: "US-West",
    });
    await seed(q, `${tab}-deleted`, { ...relation, deletedAt: now });
  }
  await seed(q, "other", {
    hostTokenHash: hashToken(other),
    participants: roster(other),
    waitlist: roster(token()),
  });
  const filters = {
    q,
    platform: "Steam",
    gameServer: "East",
    pageSize: 1,
    page: 999,
  };
  for (const tab of ["hosted", "joined", "waiting"] as const)
    for (const view of ["all", "available"] as const) {
      const first = await listMyReservations(
        { ...filters, tab, view, page: 1 },
        viewer,
        now,
      );
      const last = await listMyReservations(
        { ...filters, tab, view },
        viewer,
        now,
      );
      assert.deepEqual(
        new Set([...rowIds(first), ...rowIds(last)]),
        new Set([`${q}-${tab}-PUBLIC`, `${q}-${tab}-INVITE`]),
      );
      assert.deepEqual([last.total, last.page, last.pageCount], [2, 2, 2]);
      const none = await listMyReservations(
        { ...filters, tab, view, gameServer: "none" },
        viewer,
        now,
      );
      assert.deepEqual([none.total, none.page, none.pageCount], [0, 1, 1]);
    }
  for (const identity of [undefined, "", "invalid"])
    for (const tab of ["hosted", "joined", "waiting"] as const) {
      const empty = await listMyReservations(
        { ...filters, tab, token: viewer, hostTokenHash: hashToken(viewer) },
        identity,
        now,
      );
      assert.deepEqual(
        [empty.total, empty.page, empty.pageCount, empty.items.length],
        [0, 1, 1, 0],
      );
      assert.equal(empty.filters.platform, "Steam");
      assert.equal(empty.filters.gameServer, "East");
    }
});

test("Prisma and available SQL branches agree on partial, ASCII-case, wildcard, Unicode and punctuation matching while q stays game/host-only", async () => {
  const q = randomUUID();
  for (const [suffix, platform, gameServer] of [
    ["ascii", "Steam", "CN-East"],
    ["wildcard", "Steam_Deck", "CN%North"],
    ["punctuation", 'GOG "x" & +', "C:\\EU"],
    ["fullwidth", "Ｓｔｅａｍ", "東京・東"],
    ["accent", "Élite", "ÅLAND"],
    ["empty", "", ""],
  ])
    await seed(q, suffix, { platform, gameServer });
  for (const [filters, suffixes] of [
    [{ platform: "steam" }, ["ascii", "wildcard"]],
    [{ platform: "Steam_" }, ["wildcard"]],
    [
      { platform: "%" },
      ["accent", "ascii", "empty", "fullwidth", "punctuation", "wildcard"],
    ],
    [{ gameServer: "cn_" }, ["ascii", "wildcard"]],
    [{ platform: '"x" & +', gameServer: "\\" }, ["punctuation"]],
    [{ platform: "Ｓｔｅａｍ", gameServer: "東" }, ["fullwidth"]],
    [{ platform: "élite" }, []],
    [{ platform: "Éli", gameServer: "ÅL" }, ["accent"]],
    [{ platform: "' OR 1=1 --" }, []],
  ] as const) {
    const regular = await listReservations({ q, ...filters }, now);
    const available = await listReservations(
      { q, ...filters, view: "available" },
      now,
    );
    assert.deepEqual(
      rowIds(regular),
      suffixes.map((suffix) => `${q}-${suffix}`),
      JSON.stringify(filters),
    );
    assert.deepEqual(available.items, regular.items, JSON.stringify(filters));
    assert.equal(available.total, regular.total);
  }
  const only = await seed(q, "q-only", {
    gameName: `Game-${q}`,
    hostName: `Host-${q}`,
    platform: `Platform-${q}`,
    gameServer: `Server-${q}`,
  });
  for (const view of ["all", "available"])
    for (const [query, expected] of [
      [only.gameName, 1],
      [only.hostName, 1],
      [only.platform, 0],
      [only.gameServer, 0],
    ] as const)
      assert.equal(
        (
          await listReservations(
            { q: query, platform: only.platform, view },
            now,
          )
        ).total,
        expected,
      );
});

test("independent filters do not add statistics queries or roster reads to either listing branch", async (t) => {
  const q = randomUUID();
  await seed(q, "future");
  await seed(q, "past", { scheduledAt: new Date(now.getTime() - 1000) });
  let calls: Record<string, number> = {};
  const original = db.$transaction,
    transaction = original.bind(db);
  t.after(() => {
    db.$transaction = original;
  });
  db.$transaction = ((
    run: (tx: Prisma.TransactionClient) => Promise<unknown>,
    options: { isolationLevel?: Prisma.TransactionIsolationLevel },
  ) =>
    transaction(async (tx) => {
      const delegate = new Proxy(tx.gameReservation, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver);
          if (key !== "count" && key !== "findMany") return value;
          return (...args: unknown[]) => {
            calls[String(key)] = (calls[String(key)] ?? 0) + 1;
            return Reflect.apply(value, target, args);
          };
        },
      });
      return run(
        new Proxy(tx, {
          get(target, key, receiver) {
            if (key === "gameReservation") return delegate;
            const value = Reflect.get(target, key, receiver);
            if (key !== "$queryRaw") return value;
            return (...args: unknown[]) => {
              calls.raw = (calls.raw ?? 0) + 1;
              return Reflect.apply(value, target, args);
            };
          },
        }),
      );
    }, options)) as typeof db.$transaction;
  for (const [view, expected] of [
    ["all", { count: 2, findMany: 2 }],
    ["upcoming", { count: 1, findMany: 1 }],
    ["started", { count: 1, findMany: 1 }],
    ["available", { raw: 2, findMany: 1 }],
  ] as const) {
    calls = {};
    await listReservations(
      { q, view, platform: "steam", gameServer: "east" },
      now,
    );
    assert.deepEqual(calls, expected, view);
    calls = {};
    await listReservations(
      { q, view, platform: "absent", gameServer: "east" },
      now,
    );
    assert.deepEqual(
      calls,
      view === "available" ? { raw: 1 } : { count: 1 },
      `empty ${view}`,
    );
  }
  calls = {};
  await listMyReservations(
    { platform: "steam", gameServer: "east" },
    undefined,
    now,
  );
  assert.deepEqual(calls, {});
});

test(
  "platform HTTP filters validate duplicates and lengths, expose public summaries only, and do not create identities",
  { skip: !process.env.TEST_BASE_URL },
  async () => {
    const base = process.env.TEST_BASE_URL!,
      q = randomUUID();
    const matching = await seed(q, "match", {
      scheduledAt: new Date(Date.now() + 86400000),
    });
    await seed(q, "wrong-platform", {
      platform: "Console",
      scheduledAt: matching.scheduledAt,
    });
    await seed(q, "wrong-server", {
      gameServer: "US-West",
      scheduledAt: matching.scheduledAt,
    });
    await seed(q, "invite", {
      visibility: "INVITE",
      scheduledAt: matching.scheduledAt,
    });
    await seed(q, "deleted", {
      deletedAt: new Date(),
      scheduledAt: matching.scheduledAt,
    });
    for (const view of ["all", "available"]) {
      const query = new URLSearchParams({
        q,
        platform: " steam ",
        gameServer: " East ",
        view,
        page: "99",
        pageSize: "1",
      });
      const response = await fetch(`${base}/api/reservations?${query}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("set-cookie"), null);
      const { data } = await response.json();
      assert.deepEqual(
        data.items.map((row: { id: string }) => row.id),
        [matching.id],
      );
      assert.deepEqual([data.total, data.page, data.pageCount], [1, 1, 1]);
      assert.equal(data.items[0].platform, matching.platform);
      assert.equal(data.items[0].gameServer, matching.gameServer);
      assert.equal(data.filters.platform, "steam");
      assert.equal(data.filters.gameServer, "East");
    }
    for (const field of ["platform", "gameServer"])
      for (const query of [
        `${field}=a&${field}=a`,
        `${field}=${"x".repeat(81)}`,
      ]) {
        const response = await fetch(`${base}/api/reservations?${query}`);
        assert.equal(response.status, 400, query);
        assert.equal(response.headers.get("set-cookie"), null);
      }
  },
);
