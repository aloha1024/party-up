import { test } from "node:test";
import assert from "node:assert/strict";
import {
  errorCategory,
  requestContext,
  routeLabel,
} from "../server/request-log";
import { Prisma } from "@prisma/client";
import { buildVersion } from "../server/build-version";

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
