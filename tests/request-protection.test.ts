import "./support/isolated";
import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter, requestSource, limitLogin } from "../server/rate-limit";
import { AppError } from "../server/errors";
import { readJsonBody } from "../server/request-body";
import { randomUUID } from "node:crypto";
test("rate buckets isolate callers, expire, report retry time and stay bounded", () => {
  const limiter = new RateLimiter(2);
  limiter.take("a", 1, 1000, 100);
  assert.throws(
    () => limiter.take("a", 1, 1000, 200),
    (e) => e instanceof AppError && e.status === 429 && e.retryAfter === 1,
  );
  limiter.take("b", 1, 1000, 200);
  assert.throws(() => limiter.take("c", 1, 1000, 200));
  limiter.take("c", 1, 1000, 1200);
  limiter.take("a", 1, 1000, 1200);
});
test("forwarded sources are ignored by default; login accounts have separate quotas", (t) => {
  const original = process.env.TRUST_PROXY;
  t.after(() => {
    if (original === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = original;
  });
  delete process.env.TRUST_PROXY;
  const headers = new Headers({
    "x-real-ip": "203.0.113.1",
    "x-forwarded-for": "1.2.3.4",
  });
  assert.equal(requestSource(headers), null);
  const account = randomUUID();
  for (let i = 0; i < 20; i++) limitLogin(headers, account);
  assert.throws(
    () => limitLogin(headers, account),
    (e) => e instanceof AppError && e.status === 429,
  );
  limitLogin(headers, randomUUID());
  process.env.TRUST_PROXY = "1";
  assert.equal(requestSource(headers), "203.0.113.1");
  assert.equal(
    requestSource(new Headers({ "x-real-ip": "invalid, 1.2.3.4" })),
    null,
  );
});
test("body limit counts UTF-8 bytes and rejects declared or streamed oversized bodies", async () => {
  assert.deepEqual(
    await readJsonBody(
      new Request("http://localhost", {
        method: "POST",
        body: '{"name":"中文"}',
      }),
    ),
    { name: "中文" },
  );
  await assert.rejects(
    readJsonBody(
      new Request("http://localhost", {
        method: "POST",
        body: "{}",
        headers: { "content-length": "99999" },
      }),
    ),
    (e) => e instanceof AppError && e.status === 413,
  );
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      c.enqueue(new TextEncoder().encode("中".repeat(100)));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    readJsonBody(
      new Request("http://localhost", {
        method: "POST",
        body,
        duplex: "half",
      } as RequestInit),
      500,
    ),
    (e) => e instanceof AppError && e.status === 413,
  );
  assert.equal(cancelled, true);
});
test("slow request bodies time out and cancel the stream", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    readJsonBody(
      new Request("http://localhost", {
        method: "POST",
        body,
        duplex: "half",
      } as RequestInit),
      16384,
      20,
    ),
    (e) => e instanceof AppError && e.code === "BODY_TIMEOUT",
  );
  assert.equal(cancelled, true);
});
