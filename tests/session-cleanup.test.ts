import "./support/isolated";
import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "../server/db";
import { hashPassword } from "../server/admin-auth";
import { loginUser, revokeUserSessions } from "../server/user-accounts";
import { digest, resolveViewer } from "../server/user-identity";

const password = "session-cleanup-password-2026";
const encodedPassword = hashPassword(password);
const cutoff = new Date("2000-01-01T00:00:00.000Z");

after(async () => {
  await db.$disconnect();
});

async function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: cutoff });
  const ids: string[] = [];
  t.after(async () => {
    await db.user.deleteMany({ where: { id: { in: ids } } });
  });
  const createUser = async () => {
    const user = await db.user.create({
      data: {
        username: "cleanup_" + randomUUID().replaceAll("-", "").slice(0, 20),
        nickname: "Cleanup",
        passwordHash: await encodedPassword,
      },
    });
    ids.push(user.id);
    return user;
  };
  return { user: await createUser(), createUser };
}

async function seedSessions(userId: string, count: number, expiresAt: Date) {
  const prefix = randomUUID();
  const rows = Array.from({ length: count }, (_, index) => ({
    id: prefix + "-" + String(index).padStart(4, "0"),
    userId,
    version: 0,
    expiresAt,
  }));
  // Insert in reverse ID order to exercise the explicit tie-breaker.
  await db.userSession.createMany({ data: [...rows].reverse() });
  return rows;
}

type DelegateCall = { model: string; operation: string; args: unknown };
function observeTransaction(t: TestContext) {
  const original = db.$transaction,
    transaction = original.bind(db),
    calls: DelegateCall[] = [];
  t.after(() => {
    db.$transaction = original;
  });
  const intercept = async (
    run: (tx: Prisma.TransactionClient) => Promise<unknown>,
    options?: Parameters<typeof db.$transaction>[1],
  ) =>
    transaction(
      async (tx) =>
        run(
          new Proxy(tx, {
            get(target, model, receiver) {
              const delegate = Reflect.get(target, model, receiver);
              if (model !== "user" && model !== "userSession") return delegate;
              return new Proxy(delegate, {
                get(targetDelegate, operation, delegateReceiver) {
                  const method = Reflect.get(
                    targetDelegate,
                    operation,
                    delegateReceiver,
                  );
                  if (
                    typeof operation !== "string" ||
                    typeof method !== "function"
                  )
                    return method;
                  return (...args: unknown[]) => {
                    calls.push({ model, operation, args: args[0] });
                    return Reflect.apply(method, targetDelegate, args);
                  };
                },
              });
            },
          }),
        ),
      options,
    );
  db.$transaction = intercept as typeof db.$transaction;
  // These are public Prisma delegate calls, not emitted SQL statements.
  return calls;
}

function assertBatchRead(calls: DelegateCall[]) {
  assert.deepEqual(
    calls
      .filter(
        (call) => call.model === "userSession" && call.operation === "findMany",
      )
      .map((call) => call.args),
    [
      {
        where: { expiresAt: { lte: cutoff } },
        orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
        take: 100,
        select: { id: true },
      },
    ],
  );
}

test("login with no expired sessions skips deletion and keeps valid sessions", async (t) => {
  const { user } = await fixture(t);
  const [existing] = await seedSessions(
    user.id,
    1,
    new Date(cutoff.getTime() + 1),
  );
  const calls = observeTransaction(t);
  const auth = await loginUser({ username: user.username, password });
  assertBatchRead(calls);
  assert.deepEqual(
    calls.map((call) => `${call.model}.${call.operation}`),
    ["user.updateMany", "userSession.findMany", "userSession.create"],
  );
  assert.ok(await db.userSession.findUnique({ where: { id: existing.id } }));
  assert.ok(
    await db.userSession.findUnique({ where: { id: digest(auth.token) } }),
  );
});

test("login cleanup includes the exact expiry cutoff and keeps the next millisecond", async (t) => {
  const { user, createUser } = await fixture(t);
  const other = await createUser();
  const before = await seedSessions(
    other.id,
    1,
    new Date(cutoff.getTime() - 1),
  );
  const equal = await seedSessions(user.id, 1, cutoff);
  const [valid] = await seedSessions(
    other.id,
    1,
    new Date(cutoff.getTime() + 1),
  );
  await loginUser({ username: user.username, password });
  assert.equal(
    await db.userSession.count({
      where: { id: { in: [...before, ...equal].map((row) => row.id) } },
    }),
    0,
  );
  assert.ok(await db.userSession.findUnique({ where: { id: valid.id } }));
});

for (const count of [100, 105]) {
  test(`login removes only the first 100 of ${count} expired sessions in expiry and ID order`, async (t) => {
    const { user } = await fixture(t);
    const rows = await seedSessions(user.id, count, cutoff);
    // These late IDs expire first; a take without orderBy would remove the
    // wrong set even if it happened to respect the 100-row limit.
    await db.userSession.updateMany({
      where: { id: { in: rows.slice(-3).map((row) => row.id) } },
      data: { expiresAt: new Date(cutoff.getTime() - 1) },
    });
    const ordered = [...rows.slice(-3), ...rows.slice(0, -3)];
    const calls = observeTransaction(t);
    await loginUser({ username: user.username, password });
    assertBatchRead(calls);
    assert.deepEqual(
      calls.map((call) => `${call.model}.${call.operation}`),
      [
        "user.updateMany",
        "userSession.findMany",
        "userSession.deleteMany",
        "userSession.create",
      ],
    );
    assert.deepEqual(
      calls.find((call) => call.operation === "deleteMany")!.args,
      {
        where: {
          id: { in: ordered.slice(0, 100).map((row) => row.id) },
          expiresAt: { lte: cutoff },
        },
      },
    );
    const remaining = await db.userSession.findMany({
      where: { userId: user.id, expiresAt: { lte: cutoff } },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    assert.deepEqual(
      remaining,
      ordered.slice(100).map(({ id }) => ({ id })),
    );
  });
}

test("failed session creation rolls back the login's entire cleanup batch", async (t) => {
  const { user } = await fixture(t);
  await seedSessions(user.id, 105, cutoff);
  const before = await db.userSession.findMany({
    where: { userId: user.id },
    orderBy: { id: "asc" },
  });
  await db.$executeRawUnsafe(
    `CREATE TRIGGER fail_cleanup_login BEFORE INSERT ON UserSession WHEN NEW.userId = '${user.id}' BEGIN SELECT RAISE(ABORT, 'test session failure'); END`,
  );
  try {
    await assert.rejects(loginUser({ username: user.username, password }));
  } finally {
    await db.$executeRawUnsafe("DROP TRIGGER fail_cleanup_login");
  }
  assert.deepEqual(
    await db.userSession.findMany({
      where: { userId: user.id },
      orderBy: { id: "asc" },
    }),
    before,
  );
  assert.deepEqual(
    await db.user.findUniqueOrThrow({ where: { id: user.id } }),
    user,
  );
});

test("invalid credentials and disabled accounts do not perform session cleanup", async (t) => {
  const { user } = await fixture(t);
  await seedSessions(user.id, 3, cutoff);
  const calls = observeTransaction(t);
  await assert.rejects(
    loginUser({ username: user.username, password: password + "wrong" }),
    { code: "USER_CREDENTIALS" },
  );
  await db.user.update({ where: { id: user.id }, data: { isActive: false } });
  await assert.rejects(loginUser({ username: user.username, password }), {
    code: "USER_CREDENTIALS",
  });
  assert.deepEqual(calls, []);
  assert.equal(await db.userSession.count({ where: { userId: user.id } }), 3);
});

test("concurrent successful logins each consume one cleanup batch and preserve both new sessions", async (t) => {
  const { user } = await fixture(t);
  await seedSessions(user.id, 205, cutoff);
  const results = await Promise.all([
    loginUser({ username: user.username, password }),
    loginUser({ username: user.username, password }),
  ]);
  assert.notEqual(results[0].token, results[1].token);
  assert.equal(
    await db.userSession.count({
      where: { userId: user.id, expiresAt: { lte: cutoff } },
    }),
    5,
  );
  assert.equal(
    await db.userSession.count({
      where: { userId: user.id, expiresAt: { gt: cutoff } },
    }),
    2,
  );
  for (const result of results)
    assert.equal((await resolveViewer(result.token)).mode, "user");
});

test("explicit revoke-all still removes more than a cleanup batch of valid sessions", async (t) => {
  const { user } = await fixture(t);
  const auth = await loginUser({ username: user.username, password });
  await seedSessions(user.id, 105, new Date(cutoff.getTime() + 86400000));
  await revokeUserSessions(await resolveViewer(auth.token));
  assert.equal(await db.userSession.count({ where: { userId: user.id } }), 0);
  assert.equal(
    (await db.user.findUniqueOrThrow({ where: { id: user.id } })).version,
    user.version + 1,
  );
});
