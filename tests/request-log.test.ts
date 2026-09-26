import { test } from "node:test";
import assert from "node:assert/strict";
import {
  errorCategory,
  requestContext,
  routeLabel,
  slowRequestThreshold,
  errorDiagnostics,
} from "../server/request-log";
import { Prisma } from "@prisma/client";
import { buildVersion } from "../server/build-version";
import {
  withRequestMetrics,
  requestMetrics,
  measureTransaction,
  recordRetry,
  recordBusy,
} from "../server/request-metrics";

test("slow threshold validates limits and emits only one completed request at the correct level", (t) => {
  for (const input of [
    "",
    "99",
    "60001",
    "100.1",
    "NaN",
    "Infinity",
    "-1",
    "1e3",
  ])
    assert.equal(slowRequestThreshold(input), 1000);
  for (const input of ["100", "1000", "60000"])
    assert.equal(slowRequestThreshold(input), Number(input));
  const old = process.env.SLOW_REQUEST_MS;
  process.env.SLOW_REQUEST_MS = "1000";
  t.after(() => {
    if (old === undefined) delete process.env.SLOW_REQUEST_MS;
    else process.env.SLOW_REQUEST_MS = old;
  });
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const lines: { level: string; entry: any }[] = [];
  for (const level of ["info", "warn", "error"] as const)
    t.mock.method(console, level, (line: string) =>
      lines.push({ level, entry: JSON.parse(line) }),
    );
  for (const [duration, status, level] of [
    [999, 200, "info"],
    [1000, 200, "warn"],
    [1, 400, "warn"],
    [2000, 503, "error"],
  ] as const) {
    const context = requestContext("GET", "/api/reservations");
    now += duration;
    const before = lines.length;
    context.finish(status);
    context.finish(status);
    assert.equal(lines.length, before + 1);
    assert.equal(lines.at(-1)?.level, level);
    assert.equal(lines.at(-1)?.entry.slow, duration >= 1000);
  }
});

test("error diagnostics allow only safe relative locations and ignore exception contents", () => {
  const secret = "private-password-cookie-sql";
  const root = process.cwd().replaceAll("\\", "/");
  const error = new TypeError(secret);
  error.stack = `TypeError: ${secret}\n    at ${secret} (${root}/server/reservations.ts:42:8)`;
  const info = errorDiagnostics(error);
  assert.equal(info.errorLocation, "server/reservations.ts:42:8");
  assert.match(info.errorFingerprint, /^[a-f0-9]{16}$/);
  assert.equal(JSON.stringify(info).includes(secret), false);
  assert.equal(JSON.stringify(info).includes(root), false);
  error.message = "different";
  assert.deepEqual(errorDiagnostics(error), info);
  for (const location of [
    `${root}/server/${secret}.ts:1:1`,
    `${root}/server/../.env:1:1`,
    `${root}/server/http.ts?${secret}:1:1`,
    `/another-project/server/http.ts:1:1`,
  ]) {
    error.stack = `Error: ${secret}\n    at secret (${location})`;
    assert.equal(errorDiagnostics(error).errorLocation, undefined);
  }
  error.stack = `Error: ${secret}\n    at f (${root}/.next/server/chunks/[root-of-the-server]__abc123._.js:2:5)`;
  assert.equal(
    errorDiagnostics(error).errorLocation,
    ".next/server/chunks/[root-of-the-server]__abc123._.js:2:5",
  );
});

test("transaction metrics are isolated across overlapping requests and absent outside requests", async () => {
  assert.equal(requestMetrics(), undefined);
  assert.equal(await measureTransaction(async () => 7), 7);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = withRequestMetrics(async () => {
    await measureTransaction(async () => {
      await gate;
    });
    recordRetry();
    recordBusy();
    return requestMetrics()!;
  });
  const second = await withRequestMetrics(async () => {
    await measureTransaction(async () => {});
    await measureTransaction(async () => {});
    return requestMetrics()!;
  });
  release();
  const a = await first;
  assert.deepEqual(
    [a.transactionAttempts, a.transactionRetries, a.busy],
    [1, 1, true],
  );
  assert.deepEqual(
    [second.transactionAttempts, second.transactionRetries, second.busy],
    [2, 0, false],
  );
  assert.ok(a.transactionMs >= 0);
  assert.equal(requestMetrics(), undefined);
});

test("request logs correlate responses without recording identifiers or private payloads", (t) => {
  const lines: string[] = [];
  for (const level of ["info", "warn", "error"] as const)
    t.mock.method(console, level, (line: string) => lines.push(line));
  const context = requestContext("PATCH", "/api/admin/reservations/private-id");
  context.finish(503, "BUSY");
  const result = JSON.parse(lines[0]);
  assert.equal(result.requestId, context.requestId);
  assert.equal(result.route, "/api/admin/reservations/:id");
  assert.equal(result.code, "BUSY");
  assert.equal(result.status, 503);
  assert.ok(result.durationMs >= 0);
  assert.equal(JSON.stringify(result).includes("private-id"), false);
  assert.equal(
    routeLabel("/api/reservations/another-id/join"),
    "/api/reservations/:id/join",
  );
  assert.equal(
    routeLabel("/api/reservations/submission"),
    "/api/reservations/submission",
  );
});
test("only a valid build revision is exposed to the admin page", (t) => {
  const previous = process.env.APP_VERSION;
  t.after(() => {
    if (previous === undefined) delete process.env.APP_VERSION;
    else process.env.APP_VERSION = previous;
  });
  process.env.APP_VERSION = "a".repeat(40);
  assert.equal(buildVersion(), "a".repeat(40));
  process.env.APP_VERSION = "private-configuration";
  assert.equal(buildVersion(), "本地构建");
});

test("internal errors retain safe categories without messages, SQL or credentials", (t) => {
  const secret = "private-password-and-query";
  const error = new Prisma.PrismaClientKnownRequestError(secret, {
    code: "P2021",
    clientVersion: "test",
    meta: { password: secret },
  });
  const lines: string[] = [];
  t.mock.method(console, "error", (line: string) => lines.push(line));
  requestContext("POST", "/api/admin/session").finish(
    503,
    "INTERNAL",
    errorCategory(error),
  );
  assert.equal(JSON.parse(lines[0]).errorType, "PRISMA_P2021");
  assert.equal(lines[0].includes(secret), false);
  assert.equal(errorCategory(new TypeError(secret)), "TYPE_ERROR");
  assert.equal(errorCategory({ name: secret, code: secret }), "UNEXPECTED");
});
