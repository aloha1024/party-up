import "./support/isolated";
import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "../server/db";
import { detail, hashToken, reservationPageData } from "../server/reservations";
import { reservationHistory } from "../server/reservation-history";
import { rosterRemovals } from "../server/roster-removals";
import { withRequestBudget } from "../server/request-budget";
import { requestMetrics, withRequestMetrics } from "../server/request-metrics";
import { AppError } from "../server/errors";
import { errorDiagnostics, requestContext } from "../server/request-log";
import { registeredToken } from "./support/member";

const ids: string[] = [];
const secret = () => randomBytes(32).toString("hex");
const admin = { id: 123, sessionVersion: 4 };
const createdAt = new Date("2030-01-01T00:00:00Z");

after(async () => {
  await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});

async function fixture(invite = false) {
  const id = randomUUID();
  const host = secret(),
    member = secret(),
    waiter = secret(),
    visitor = secret();
  ids.push(id);
  await db.gameReservation.create({
    data: {
      id,
      gameName: "详情合并测试",
      hostName: "发起人",
      hostTokenHash: hashToken(host),
      scheduledAt: new Date("2099-01-02T00:00:00Z"),
      maxPlayers: 2,
      visibility: invite ? "INVITE" : "PUBLIC",
      inviteHash: invite ? "private-invite-hash" : null,
      inviteCipher: invite ? "private-invite-cipher" : null,
      participants: {
        create: [
          {
            name: "发起人",
            nameKey: "发起人",
            tokenHash: hashToken(host),
            joinedAt: createdAt,
          },
          {
            name: "正式参与者",
            nameKey: "正式参与者",
            tokenHash: hashToken(member),
            joinedAt: new Date(createdAt.getTime() + 1),
            checkedInAt: createdAt,
            attendanceVersion: 2,
          },
        ],
      },
      waitlist: {
        create: {
          name: "候补者",
          nameKey: "候补者",
          tokenHash: hashToken(waiter),
        },
      },
      changes: {
        create: Array.from({ length: 13 }, (_, index) => ({
          action: "EDIT",
          actorRole: index % 2 ? "ADMIN" : "HOST",
          fields: '["maxPlayers"]',
          maxPlayersBefore: index + 2,
          maxPlayersAfter: index + 3,
          createdAt,
        })),
      },
      removals: {
        create: Array.from({ length: 24 }, (_, index) => ({
          kind: index % 2 ? "waitlist" : "participants",
          entryId: randomUUID(),
          targetTokenHash: hashToken(index % 2 ? waiter : member),
          targetName: index % 2 ? "候补者" : "正式参与者",
          reason: `${index % 2 ? "候补私密原因" : "正式私密原因"} ${index}`,
          actorRole: index % 2 ? "ADMIN" : "HOST",
          createdAt,
        })),
      },
      access: invite
        ? {
            create: { tokenHash: hashToken(visitor), inviteVersion: 1 },
          }
        : undefined,
    },
  });
  return { id, host, member, waiter, visitor };
}

type Options = {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
};

// Count delegate calls, not raw SQL: Prisma may fetch included rosters separately.
// Each observation also identifies the transaction that performed the read.
function trackReads(t: TestContext) {
  const original = db.$transaction;
  const transaction = original.bind(db);
  const calls: { transaction: number; method: string }[] = [];
  const options: (Options | undefined)[] = [];
  let transactions = 0;
  t.after(() => {
    db.$transaction = original;
  });
  db.$transaction = ((
    run: (tx: Prisma.TransactionClient) => Promise<unknown>,
    settings?: Options,
  ) => {
    const number = ++transactions;
    options.push(settings);
    return transaction(
      async (tx) =>
        run(
          new Proxy(tx, {
            get(target, key, receiver) {
              const delegate = Reflect.get(target, key, receiver);
              if (
                ![
                  "gameReservation",
                  "reservationAccess",
                  "reservationChange",
                  "rosterRemoval",
                  "participant",
                  "waitlistEntry",
                  "user",
                  "userReservationFavorite",
                ].includes(String(key))
              )
                return delegate;
              return new Proxy(delegate, {
                get(model, method, modelReceiver) {
                  const value = Reflect.get(model, method, modelReceiver);
                  if (typeof value !== "function") return value;
                  return (...args: unknown[]) => {
                    calls.push({
                      transaction: number,
                      method: `${String(key)}.${String(method)}`,
                    });
                    return Reflect.apply(value, model, args);
                  };
                },
              });
            },
          }),
        ),
      settings,
    );
  }) as typeof db.$transaction;
  return {
    calls,
    options,
    count: (method: string) =>
      calls.filter((call) => call.method === method).length,
    transactions: () => transactions,
    reset() {
      transactions = 0;
      calls.length = 0;
      options.length = 0;
    },
  };
}

async function previousPage(
  id: string,
  token?: string,
  actor: typeof admin | null = null,
) {
  return {
    reservation: await detail(id, token, !!actor),
    history: await reservationHistory(id, undefined, token, !!actor),
    removals: await rosterRemovals(id, token, actor),
    favorite: null,
  };
}

test("detail transactions measure success and failures without changing reads, errors or private logs", async (t) => {
  const publicFixture = await fixture();
  const invited = await fixture(true);
  const deleted = await fixture();
  await db.gameReservation.update({
    where: { id: deleted.id },
    data: { deletedAt: new Date() },
  });
  const failure = new Error(
    "private nickname password invite-token SQL and exception content",
  );
  const cases = [
    {
      id: publicFixture.id,
      expected: await detail(publicFixture.id),
      accessReads: 0,
    },
    {
      id: invited.id,
      token: invited.visitor,
      expected: await detail(invited.id, invited.visitor),
      accessReads: 1,
    },
    {
      id: invited.id,
      admin: true,
      expected: await detail(invited.id, undefined, true),
      accessReads: 0,
    },
    {
      id: invited.id,
      token: secret(),
      code: "INVITATION_REQUIRED",
      accessReads: 1,
      membershipReads: 1,
    },
    { id: randomUUID(), code: "NOT_FOUND", accessReads: 0 },
    { id: deleted.id, code: "NOT_FOUND", accessReads: 0 },
    { id: publicFixture.id, code: "INTERNAL", failure, accessReads: 0 },
  ];
  const reads = trackReads(t);
  const tracked = db.$transaction;
  let injectedFailure: Error | undefined;
  let clock = 100000;
  t.mock.method(performance, "now", () => clock);
  const lines: string[] = [];
  for (const level of ["info", "warn", "error"] as const)
    t.mock.method(console, level, (line: string) => lines.push(line));
  db.$transaction = ((
    run: (tx: Prisma.TransactionClient) => Promise<unknown>,
    options?: Options,
  ) => {
    clock += 7;
    return tracked
      .call(
        db,
        async (tx: Prisma.TransactionClient) => {
          const result = await run(tx);
          if (injectedFailure) throw injectedFailure;
          return result;
        },
        options,
      )
      .finally(() => {
        clock += 11;
      });
  }) as typeof db.$transaction;
  try {
    for (const scenario of cases) {
      reads.reset();
      lines.length = 0;
      injectedFailure = scenario.failure;
      await withRequestMetrics(async () => {
        const context = requestContext(
          "GET",
          `/api/reservations/${scenario.id}`,
        );
        let caught: unknown;
        let result: Awaited<ReturnType<typeof detail>> | undefined;
        try {
          result = await detail(scenario.id, scenario.token, scenario.admin);
        } catch (error) {
          caught = error;
        }
        if (scenario.failure) assert.equal(caught, scenario.failure);
        else if (scenario.code) {
          assert.ok(caught instanceof AppError);
          assert.equal(caught.code, scenario.code);
          assert.equal(caught.status, 404);
        } else {
          assert.equal(caught, undefined);
          assert.deepEqual(result, scenario.expected);
        }
        assert.deepEqual(requestMetrics(), {
          transactionAttempts: 1,
          transactionRetries: 0,
          transactionMs: 18,
          busy: false,
        });
        const status =
          caught instanceof AppError ? caught.status : caught ? 503 : 200;
        context.finish(
          status,
          scenario.code,
          scenario.failure ? errorDiagnostics(caught) : undefined,
        );
        context.finish(status, scenario.code);
        assert.equal(lines.length, 1);
        const log = JSON.parse(lines[0]);
        assert.equal(log.status, status);
        assert.equal(log.code, scenario.code ?? "OK");
        assert.equal(log.route, "/api/reservations/:id");
        assert.equal(log.transactionAttempts, 1);
        assert.equal(log.transactionRetries, 0);
        assert.equal(log.transactionMs, 18);
        assert.equal(log.busy, false);
        for (const value of [
          scenario.id,
          scenario.token,
          publicFixture.host,
          hashToken(publicFixture.host),
          "详情合并测试",
          "发起人",
          "private-invite-cipher",
          "private-invite-hash",
          failure.message,
          process.cwd(),
        ])
          if (value) assert.equal(lines[0].includes(value), false);
      });
      assert.equal(requestMetrics(), undefined);
      assert.equal(reads.transactions(), 1);
      assert.equal(reads.count("gameReservation.findUnique"), 1);
      assert.equal(
        reads.count("reservationAccess.findUnique"),
        scenario.accessReads,
      );
      assert.equal(
        reads.count("participant.count"),
        scenario.membershipReads ?? 0,
      );
      assert.equal(
        reads.count("waitlistEntry.count"),
        scenario.membershipReads ?? 0,
      );
      assert.equal(
        reads.calls.length,
        1 + scenario.accessReads + 2 * (scenario.membershipReads ?? 0),
      );
      assert.deepEqual(reads.options, [undefined]);
    }
  } finally {
    db.$transaction = tracked;
  }
});

test("overlapping detail requests keep separate metrics and calls outside a request stay uninstrumented", async () => {
  const f = await fixture(true);
  assert.equal(requestMetrics(), undefined);
  const expected = await detail(f.id, f.visitor);
  assert.equal(requestMetrics(), undefined);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = db.$transaction;
  let calls = 0;
  db.$transaction = (async (
    run: (tx: Prisma.TransactionClient) => Promise<unknown>,
    options?: Options,
  ) => {
    if (++calls === 1) {
      entered();
      await gate;
    }
    return original.call(db, run, options);
  }) as typeof db.$transaction;
  const first = withRequestMetrics(async () => {
    assert.deepEqual(await detail(f.id, f.visitor), expected);
    await detail(f.id, f.visitor);
    return requestMetrics()!;
  });
  try {
    await started;
    const second = await withRequestMetrics(async () => {
      assert.deepEqual(await detail(f.id, f.visitor), expected);
      return requestMetrics()!;
    });
    assert.equal(second.transactionAttempts, 1);
    assert.equal(second.transactionRetries, 0);
    assert.equal(second.busy, false);
    release();
    const firstMetrics = await first;
    assert.equal(firstMetrics.transactionAttempts, 2);
    assert.equal(firstMetrics.transactionRetries, 0);
    assert.equal(firstMetrics.busy, false);
    assert.ok(firstMetrics.transactionMs >= 0 && second.transactionMs >= 0);
    assert.equal(calls, 3);
    assert.equal(requestMetrics(), undefined);
  } finally {
    release();
    await first.catch(() => {});
    db.$transaction = original;
  }
});

test("detail page shares one bounded transaction and one reservation/invitation read, preserving the old page data", async (t) => {
  const f = await fixture(true);
  const reads = trackReads(t);
  const previous = await previousPage(f.id, f.visitor);
  assert.equal(reads.transactions(), 3);
  assert.equal(reads.count("gameReservation.findUnique"), 3);
  assert.equal(reads.count("reservationAccess.findUnique"), 3);
  reads.reset();
  const merged = await withRequestMetrics(async () => {
    const result = await reservationPageData(f.id, f.visitor);
    const metrics = requestMetrics()!;
    assert.equal(metrics.transactionAttempts, 1);
    assert.equal(metrics.transactionRetries, 0);
    assert.equal(metrics.busy, false);
    assert.ok(metrics.transactionMs >= 0);
    return result;
  });
  assert.deepEqual(merged, previous);
  assert.equal(reads.transactions(), 1);
  assert.deepEqual(
    reads.calls.map((call) => call.method),
    [
      "gameReservation.findUnique",
      "reservationAccess.findUnique",
      "reservationChange.findMany",
      "rosterRemoval.findMany",
    ],
  );
  assert.ok(reads.calls.every((call) => call.transaction === 1));
  assert.equal(reads.options[0]!.isolationLevel, "Serializable");
  assert.ok(
    reads.options[0]!.maxWait! > 0 && reads.options[0]!.maxWait! <= 1000,
  );
  assert.ok(
    reads.options[0]!.timeout! > 0 && reads.options[0]!.timeout! <= 3000,
  );
});

test("anonymous pages skip private row reads and denied invitations never load either history", async (t) => {
  const f = await fixture();
  await db.reservationChange.deleteMany({ where: { reservationId: f.id } });
  await db.rosterRemoval.deleteMany({ where: { reservationId: f.id } });
  const reads = trackReads(t);
  const empty = await reservationPageData(f.id);
  assert.deepEqual(empty.history, { items: [], nextBefore: null });
  assert.deepEqual(empty.removals.items, []);
  assert.equal(empty.removals.nextBefore, null);
  assert.equal(reads.count("rosterRemoval.findMany"), 0);
  assert.equal(reads.transactions(), 1);
  await db.gameReservation.update({
    where: { id: f.id },
    data: { visibility: "INVITE" },
  });
  reads.reset();
  await assert.rejects(reservationPageData(f.id), {
    code: "INVITATION_REQUIRED",
    status: 404,
  });
  assert.equal(reads.transactions(), 1);
  assert.equal(reads.count("reservationChange.findMany"), 0);
  assert.equal(reads.count("rosterRemoval.findMany"), 0);
});

test("merged page retains public details and private removal filtering and scope for every viewer", async () => {
  const f = await fixture();
  const scopes = new Set<string>();
  for (const [token, actor, reasons] of [
    [f.host, null, "all"],
    [undefined, admin, "all"],
    [f.member, null, "正式私密原因"],
    [f.waiter, null, "候补私密原因"],
    [f.visitor, null, "none"],
    [undefined, null, "none"],
    ["invalid-cookie", null, "none"],
  ] as const) {
    const merged = await reservationPageData(f.id, token, actor);
    assert.deepEqual(merged, await previousPage(f.id, token, actor));
    if (reasons === "none") {
      assert.deepEqual(merged.removals.items, []);
      assert.equal(merged.removals.nextBefore, null);
    } else {
      assert.equal(merged.removals.items.length, 10);
      if (reasons !== "all")
        assert.ok(
          merged.removals.items.every((item) =>
            item.reason.startsWith(reasons),
          ),
        );
    }
    if (token !== "invalid-cookie") {
      assert.equal(scopes.has(merged.removals.scope), false);
      scopes.add(merged.removals.scope);
    }
    const serialized = JSON.stringify(merged);
    for (const secretValue of [
      f.host,
      f.member,
      f.waiter,
      f.visitor,
      hashToken(f.host),
      hashToken(f.member),
      "tokenHash",
      "inviteHash",
      "inviteCipher",
      "private-invite-cipher",
    ])
      assert.equal(serialized.includes(secretValue), false, secretValue);
    assert.equal(merged.reservation.participants[0].isHost, true);
    assert.equal(
      merged.reservation.participants[1].checkedInAt,
      createdAt.toISOString(),
    );
    assert.equal(merged.reservation.participants[1].attendanceVersion, 2);
    assert.equal(merged.reservation.waitlist.length, 1);
  }
  const anonymous = await reservationPageData(f.id);
  const invalid = await reservationPageData(f.id, "invalid-cookie");
  assert.equal(invalid.removals.scope, anonymous.removals.scope);
  assert.notEqual(
    (
      await reservationPageData(f.id, undefined, {
        ...admin,
        sessionVersion: admin.sessionVersion + 1,
      })
    ).removals.scope,
    (await reservationPageData(f.id, undefined, admin)).removals.scope,
  );
});

test("merged page and independent history APIs reject lost invitation access and deleted reservations", async () => {
  const f = await fixture(true);
  for (const token of [undefined, "invalid-cookie", secret()]) {
    await assert.rejects(reservationPageData(f.id, token), {
      code: "INVITATION_REQUIRED",
      status: 404,
    });
  }
  // Existing roster membership still grants viewing when no grant row exists.
  for (const token of [f.host, f.member, f.waiter, f.visitor]) {
    assert.deepEqual(
      await reservationPageData(f.id, token),
      await previousPage(f.id, token),
    );
  }
  assert.equal(
    (await reservationPageData(f.id, undefined, admin)).removals.items.length,
    10,
  );
  await db.gameReservation.update({
    where: { id: f.id },
    data: { inviteVersion: 2 },
  });
  for (const read of [
    () => reservationPageData(f.id, f.visitor),
    () => detail(f.id, f.visitor),
    () => reservationHistory(f.id, undefined, f.visitor),
    () => rosterRemovals(f.id, f.visitor),
  ])
    await assert.rejects(read, { code: "INVITATION_REQUIRED", status: 404 });
  await db.reservationAccess.update({
    where: {
      reservationId_tokenHash: {
        reservationId: f.id,
        tokenHash: hashToken(f.visitor),
      },
    },
    data: { hasJoined: true },
  });
  assert.equal(
    (await reservationPageData(f.id, f.visitor)).reservation.id,
    f.id,
  );
  await db.gameReservation.update({
    where: { id: f.id },
    data: { deletedAt: new Date() },
  });
  for (const [token, actor] of [
    [f.host, null],
    [f.visitor, null],
    [undefined, admin],
  ] as const)
    await assert.rejects(reservationPageData(f.id, token, actor), {
      code: "NOT_FOUND",
      status: 404,
    });
  await db.gameReservation.update({
    where: { id: f.id },
    data: { deletedAt: null },
  });
  assert.equal(
    (await reservationPageData(f.id, f.host)).history.items.length,
    10,
  );
  await assert.rejects(reservationPageData(randomUUID(), undefined, admin), {
    code: "NOT_FOUND",
    status: 404,
  });
});

test("first-page history and private removals retain stable cursors and subsequent reads see fresh data", async () => {
  const f = await fixture();
  const first = await reservationPageData(f.id, f.member);
  assert.equal(first.history.items.length, 10);
  assert.equal(first.history.nextBefore, first.history.items.at(-1)!.id);
  const older = await reservationHistory(
    f.id,
    first.history.nextBefore!,
    f.member,
  );
  assert.equal(older.items.length, 3);
  assert.equal(older.nextBefore, null);
  const historyIds = [...first.history.items, ...older.items].map(
    (row) => row.id,
  );
  assert.equal(new Set(historyIds).size, 13);
  assert.deepEqual(
    historyIds,
    historyIds.toSorted((a, b) => b - a),
  );
  const removals = await rosterRemovals(
    f.id,
    f.member,
    null,
    first.removals.nextBefore!,
    first.removals.scope,
  );
  assert.equal(removals.items.length, 2);
  assert.equal(removals.nextBefore, null);
  assert.ok(
    [...first.removals.items, ...removals.items].every((row) =>
      row.reason.startsWith("正式私密原因"),
    ),
  );
  assert.equal(
    new Set([...first.removals.items, ...removals.items].map((row) => row.id))
      .size,
    12,
  );
  await assert.rejects(
    rosterRemovals(
      f.id,
      f.waiter,
      null,
      first.removals.nextBefore!,
      first.removals.scope,
    ),
    { code: "VIEWER_CHANGED", status: 409 },
  );
  await db.gameReservation.update({
    where: { id: f.id },
    data: {
      description: "新的页面内容",
      changes: {
        create: {
          action: "EDIT",
          actorRole: "HOST",
          fields: '["description"]',
          createdAt,
        },
      },
      removals: {
        create: {
          kind: "participants",
          entryId: randomUUID(),
          targetTokenHash: hashToken(f.member),
          targetName: "正式参与者",
          reason: "新的本人私密记录",
          actorRole: "HOST",
          createdAt,
        },
      },
    },
  });
  const fresh = await reservationPageData(f.id, f.member);
  assert.equal(fresh.reservation.description, "新的页面内容");
  assert.ok(fresh.history.items[0].id > first.history.items[0].id);
  assert.equal(fresh.removals.items[0].reason, "新的本人私密记录");
  assert.equal(fresh.removals.scope, first.removals.scope);
  assert.equal(
    (await reservationPageData(f.id, f.waiter)).removals.items.some(
      (row) => row.reason === "新的本人私密记录",
    ),
    false,
  );
});

test("expired page request budget rejects before opening a transaction", async (t) => {
  const reads = trackReads(t);
  let time = 0;
  t.mock.method(performance, "now", () => time);
  await withRequestBudget(async () => {
    time = 10001;
    await assert.rejects(reservationPageData(randomUUID()), {
      code: "BUSY",
      status: 503,
    });
  });
  assert.equal(reads.transactions(), 0);
});

test("account detail reads favorite state in the same snapshot without rechecking invitation access", async (t) => {
  const f = await fixture(true);
  const token = await registeredToken();
  const user = await db.user.findUniqueOrThrow({
    where: { identityKey: token.slice(5) },
  });
  t.after(() => db.user.delete({ where: { id: user.id } }));
  await db.reservationAccess.create({
    data: {
      reservationId: f.id,
      tokenHash: hashToken(token),
      inviteVersion: 1,
    },
  });
  await db.userReservationFavorite.create({
    data: { userId: user.id, reservationId: f.id },
  });
  const reads = trackReads(t);
  const page = await reservationPageData(f.id, token);
  assert.deepEqual(page.favorite, { saved: true, allowed: true });
  assert.equal(reads.transactions(), 1);
  assert.equal(reads.count("gameReservation.findUnique"), 1);
  assert.equal(reads.count("reservationAccess.findUnique"), 1);
  assert.equal(reads.count("userReservationFavorite.findUnique"), 1);
  assert.ok(reads.calls.every((call) => call.transaction === 1));
  assert.equal("favorite" in (await detail(f.id, token)), false);
  await db.gameReservation.update({
    where: { id: f.id },
    data: { inviteVersion: 2 },
  });
  // The independent admin identity can inspect details, but cannot grant the
  // normal account a bookmark's invitation access.
  const privileged = await reservationPageData(f.id, token, admin);
  assert.deepEqual(privileged.favorite, { saved: true, allowed: false });
  await assert.rejects(reservationPageData(f.id, token), {
    code: "INVITATION_REQUIRED",
  });
});
