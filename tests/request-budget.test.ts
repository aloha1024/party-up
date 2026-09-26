import "./support/isolated";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { db } from "../server/db";
import { withRequestBudget, writeTransaction } from "../server/request-budget";
import { AppError } from "../server/errors";
import { withRequestMetrics, requestMetrics } from "../server/request-metrics";
test("expired request budget starts no database mutation", async (t) => {
  let now = 100;
  t.mock.method(performance, "now", () => now);
  let called = false;
  await withRequestBudget(async () => {
    now = 10101;
    await assert.rejects(
      writeTransaction(async () => {
        called = true;
      }),
      (e) => e instanceof AppError && e.code === "BUSY",
    );
  });
  assert.equal(called, false);
});
test("transaction retries are bounded and non-retryable failures are not replayed", async (t) => {
  let calls = 0;
  const original = db.$transaction;
  t.after(() => {
    db.$transaction = original;
  });
  // Prisma exposes methods through a Proxy, which node:test's method mock cannot inspect.
  db.$transaction = (async (
    _: unknown,
    options: { maxWait: number; timeout: number },
  ) => {
    calls++;
    assert.ok(options.maxWait <= 1000);
    assert.ok(options.timeout <= 3000);
    throw new Prisma.PrismaClientKnownRequestError("conflict", {
      code: "P2034",
      clientVersion: "test",
    });
  }) as typeof db.$transaction;
  await withRequestMetrics(async () => {
    await assert.rejects(
      writeTransaction(async () => {}),
      (e) => e instanceof AppError && e.code === "BUSY",
    );
    const result = requestMetrics()!;
    assert.deepEqual(
      [result.transactionAttempts, result.transactionRetries, result.busy],
      [3, 2, true],
    );
  });
  assert.equal(calls, 3);
  calls = 0;
  db.$transaction = (async () => {
    calls++;
    throw new AppError("FORBIDDEN", "denied", 403);
  }) as typeof db.$transaction;
  await assert.rejects(
    writeTransaction(async () => {}),
    (e) => e instanceof AppError && e.status === 403,
  );
  assert.equal(calls, 1);
  calls = 0;
  db.$transaction = (async () => {
    if (++calls === 1)
      throw new Prisma.PrismaClientKnownRequestError("conflict", {
        code: "P2034",
        clientVersion: "test",
      });
    return "done";
  }) as unknown as typeof db.$transaction;
  await withRequestMetrics(async () => {
    assert.equal(await writeTransaction(async () => "done"), "done");
    const result = requestMetrics()!;
    assert.deepEqual(
      [result.transactionAttempts, result.transactionRetries, result.busy],
      [2, 1, false],
    );
  });
});
