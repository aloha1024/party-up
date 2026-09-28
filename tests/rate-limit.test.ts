import "./support/isolated";
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../server/errors";
import { RateLimiter } from "../server/rate-limit";

type Bucket = { count: number; reset: number };
type Limiter = Pick<RateLimiter, "take">;

function buckets(limiter: RateLimiter): Map<string, Bucket> {
  return (limiter as unknown as { buckets: Map<string, Bucket> }).buckets;
}

function cleanupSize(limiter: RateLimiter): number {
  return (limiter as unknown as { expirations: unknown[] }).expirations.length;
}

function snapshot(state: Map<string, Bucket>) {
  return [...state].map(([key, bucket]) => [key, bucket.count, bucket.reset]);
}

function outcome(
  limiter: Limiter,
  key: string,
  limit: number,
  windowMs: number | undefined,
  now: number,
) {
  try {
    limiter.take(key, limit, windowMs, now);
    return { success: true };
  } catch (error) {
    assert.ok(error instanceof AppError);
    return {
      success: false,
      code: error.code,
      message: error.message,
      status: error.status,
      retryAfter: error.retryAfter,
    };
  }
}

// Keep the previous full-scan implementation as an independent behavior oracle.
class FullScanLimiter implements Limiter {
  readonly buckets = new Map<string, Bucket>();
  constructor(private maximum: number) {}
  take(key: string, limit: number, windowMs = 60000, now = Date.now()) {
    for (const [existingKey, bucket] of this.buckets) {
      if (bucket.reset <= now) this.buckets.delete(existingKey);
    }
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maximum) {
        throw new AppError("RATE_LIMIT", "请求较多，请稍后重试", 429, 60);
      }
      bucket = { count: 0, reset: now + windowMs };
      this.buckets.set(key, bucket);
    }
    if (bucket.count >= limit) {
      const seconds = Math.max(1, Math.ceil((bucket.reset - now) / 1000));
      throw new AppError(
        "RATE_LIMIT",
        `操作过于频繁，请 ${seconds} 秒后重试`,
        429,
        seconds,
      );
    }
    bucket.count++;
  }
}

test("rate windows expire at the exact boundary and round Retry-After upwards", () => {
  const limiter = new RateLimiter();
  limiter.take("caller", 1, 2001, 100);
  assert.deepEqual(outcome(limiter, "caller", 1, 2001, 100), {
    success: false,
    code: "RATE_LIMIT",
    message: "操作过于频繁，请 3 秒后重试",
    status: 429,
    retryAfter: 3,
  });
  assert.equal(outcome(limiter, "caller", 1, 2001, 101).retryAfter, 2);
  assert.equal(outcome(limiter, "caller", 1, 2001, 2100).retryAfter, 1);
  assert.deepEqual(outcome(limiter, "caller", 1, 2001, 2101), {
    success: true,
  });
  assert.deepEqual(snapshot(buckets(limiter)), [["caller", 1, 4102]]);
});

test("mixed windows reclaim expired buckets regardless of insertion order", () => {
  const limiter = new RateLimiter(4);
  limiter.take("long", 2, 10000, 100);
  limiter.take("middle", 2, 3000, 100);
  limiter.take("short", 2, 1000, 100);
  limiter.take("shorter", 2, 500, 100);
  limiter.take("replacement", 2, 5000, 1100);
  assert.deepEqual(snapshot(buckets(limiter)), [
    ["long", 1, 10100],
    ["middle", 1, 3100],
    ["replacement", 1, 6100],
  ]);
  limiter.take("long", 2, 1, 3100);
  assert.deepEqual(snapshot(buckets(limiter)), [
    ["long", 2, 10100],
    ["replacement", 1, 6100],
  ]);
});

test("full capacity rejects new keys without evicting or changing live quotas", () => {
  const limiter = new RateLimiter(2);
  limiter.take("a", 2, 1000, 0);
  limiter.take("b", 1, 2000, 0);
  const original = snapshot(buckets(limiter));
  assert.deepEqual(outcome(limiter, "c", 10, 3000, 999), {
    success: false,
    code: "RATE_LIMIT",
    message: "请求较多，请稍后重试",
    status: 429,
    retryAfter: 60,
  });
  assert.deepEqual(snapshot(buckets(limiter)), original);
  limiter.take("a", 2, 5000, 999);
  assert.equal(outcome(limiter, "b", 1, 2000, 999).retryAfter, 2);
  limiter.take("c", 1, 3000, 1000);
  assert.deepEqual(snapshot(buckets(limiter)), [
    ["b", 1, 2000],
    ["c", 1, 4000],
  ]);
});

test("hot key successes and rejections preserve the original fixed window", () => {
  const limiter = new RateLimiter(1);
  limiter.take("hot", 2, 60000, 0);
  limiter.take("hot", 2, 1, 1);
  for (let now = 2; now < 200; now++) {
    assert.equal(outcome(limiter, "hot", 2, 600000, now).status, 429);
    assert.equal(cleanupSize(limiter), 1);
  }
  assert.deepEqual(snapshot(buckets(limiter)), [["hot", 2, 60000]]);
  limiter.take("hot", 1, 10, 60000);
  assert.deepEqual(snapshot(buckets(limiter)), [["hot", 1, 60010]]);
});

test("same key reuse and simultaneous expirations retain no obsolete quota", () => {
  const limiter = new RateLimiter(128);
  for (let generation = 0; generation < 8; generation++) {
    const now = generation * 1000;
    for (let index = 0; index < 128; index++) {
      limiter.take(`key-${index}`, 1, 1000, now);
    }
    assert.equal(buckets(limiter).size, 128);
    assert.equal(cleanupSize(limiter), 128);
    for (const bucket of buckets(limiter).values()) {
      assert.equal(bucket.count, 1);
      assert.equal(bucket.reset, now + 1000);
    }
  }
  limiter.take("replacement", 1, 1000, 8000);
  assert.deepEqual(snapshot(buckets(limiter)), [["replacement", 1, 9000]]);
  assert.equal(cleanupSize(limiter), 1);
});

test("clock rollback neither resets existing quotas nor revives expired buckets", () => {
  const limiter = new RateLimiter(3);
  limiter.take("old", 1, 1000, 1000);
  limiter.take("early", 1, 200, 500);
  assert.equal(outcome(limiter, "old", 1, 1000, 500).retryAfter, 2);
  limiter.take("new", 1, 1000, 700);
  assert.equal(buckets(limiter).has("early"), false);
  assert.equal(outcome(limiter, "old", 1, 1000, 100).retryAfter, 2);
  assert.equal(buckets(limiter).has("early"), false);
  limiter.take("early", 1, 100, 100);
  assert.deepEqual(snapshot(buckets(limiter)), [
    ["old", 1, 2000],
    ["new", 1, 1700],
    ["early", 1, 200],
  ]);
});

test("unexpired hot calls do not enumerate the bucket map", () => {
  const limiter = new RateLimiter(10000);
  for (let index = 0; index < 10000; index++) {
    limiter.take(`key-${index}`, 2000, 60000, 0);
  }
  const state = buckets(limiter);
  let expirationReads = 0;
  for (const bucket of state.values()) {
    const reset = bucket.reset;
    Object.defineProperty(bucket, "reset", {
      get() {
        expirationReads++;
        return reset;
      },
    });
  }
  const noScan = () => {
    assert.fail("unexpired calls must not scan the bucket map");
  };
  for (const property of [
    Symbol.iterator,
    "entries",
    "keys",
    "values",
    "forEach",
  ]) {
    Object.defineProperty(state, property, { value: noScan });
  }
  for (let now = 1; now <= 1000; now++) {
    limiter.take("key-5000", 2000, 60000, now);
  }
  assert.ok(
    expirationReads <= 2000,
    "1000 unexpired calls may examine only a bounded number of expiration values",
  );
  assert.equal(state.size, 10000);
  assert.equal(cleanupSize(limiter), 10000);
  assert.equal(state.get("key-5000")?.count, 1001);
  assert.equal(state.get("key-5000")?.reset, 60000);
});

test("deterministic mixed traffic matches the previous limiter outcome and state", () => {
  let seed = 0x5a17f00d;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const windows = [undefined, 0, 1, 50, 1000, 2501, 60000];
  for (const maximum of [0, 1, 3, 17, 100]) {
    const actual = new RateLimiter(maximum);
    const expected = new FullScanLimiter(maximum);
    let now = 10000;
    for (let step = 0; step < 2500; step++) {
      const shift = next() % 8;
      now += shift === 0 ? -1300 : shift === 1 ? 2000 : next() % 80;
      const key = `caller-${next() % 31}`;
      const limit = next() % 5;
      const window = windows[next() % windows.length];
      const label = `capacity=${maximum}, step=${step}`;
      assert.deepEqual(
        outcome(actual, key, limit, window, now),
        outcome(expected, key, limit, window, now),
        label,
      );
      assert.deepEqual(
        snapshot(buckets(actual)),
        snapshot(expected.buckets),
        label,
      );
      assert.equal(cleanupSize(actual), buckets(actual).size, label);
    }
  }
});
