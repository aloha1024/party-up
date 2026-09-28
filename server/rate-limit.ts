import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { AppError } from "./errors";
type Bucket = { key: string; count: number; reset: number };
export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  // One heap entry per bucket; repeated requests never append cleanup records.
  // Windows differ between callers, so insertion order is not expiration order.
  private expirations: Bucket[] = [];
  constructor(private maximum = 10000) {}

  private schedule(bucket: Bucket) {
    let index = this.expirations.length;
    this.expirations.push(bucket);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.expirations[parent].reset <= bucket.reset) break;
      this.expirations[index] = this.expirations[parent];
      index = parent;
    }
    this.expirations[index] = bucket;
  }

  private expire(now: number) {
    while (this.expirations.length && this.expirations[0].reset <= now) {
      const expired = this.expirations[0];
      const last = this.expirations.pop()!;
      this.buckets.delete(expired.key);
      if (!this.expirations.length) continue;
      let index = 0;
      while (index * 2 + 1 < this.expirations.length) {
        let child = index * 2 + 1;
        const right = child + 1;
        if (
          right < this.expirations.length &&
          this.expirations[right].reset < this.expirations[child].reset
        )
          child = right;
        if (last.reset <= this.expirations[child].reset) break;
        this.expirations[index] = this.expirations[child];
        index = child;
      }
      this.expirations[index] = last;
    }
  }

  take(key: string, limit: number, windowMs = 60000, now = Date.now()) {
    this.expire(now);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maximum)
        throw new AppError("RATE_LIMIT", "请求较多，请稍后重试", 429, 60);
      bucket = { key, count: 0, reset: now + windowMs };
      this.buckets.set(key, bucket);
      this.schedule(bucket);
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
const state = globalThis as unknown as { partyLimiter?: RateLimiter };
export const limiter = (state.partyLimiter ??= new RateLimiter());
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function requestSource(headers: Headers): string | null {
  // Opt in ONLY behind a proxy that overwrites X-Real-IP and blocks direct access.
  if (process.env.TRUST_PROXY !== "1") return null;
  const value = headers.get("x-real-ip")?.trim();
  return value && isIP(value) ? value : null;
}
export function limitLogin(headers: Headers, username: string) {
  const source = requestSource(headers);
  limiter.take("login:global", 120);
  limiter.take("login:account:" + digest(username.trim().toLowerCase()), 20);
  if (source) limiter.take("login:source:" + digest(source), 30);
}
export function limitWrite(headers: Headers, path: string, token?: string) {
  const kind = path.endsWith("/invitation/accept")
    ? "invite"
    : path === "/api/identity"
      ? "identity"
      : path === "/api/reservations"
        ? "create"
        : path.includes("/attendance") ||
            path.includes("/participants") ||
            path.includes("/waitlist") ||
            path.includes("/roster-removals")
          ? "roster"
          : "manage";
  const limits = {
    invite: 10,
    identity: 30,
    create: 10,
    roster: 30,
    manage: 60,
  };
  limiter.take(kind + ":global", kind === "create" ? 120 : 600);
  const source = requestSource(headers);
  if (source)
    limiter.take(kind + ":source:" + digest(source), limits[kind] * 3);
  if (token) limiter.take(kind + ":identity:" + digest(token), limits[kind]);
}
