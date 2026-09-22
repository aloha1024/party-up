import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { AppError } from "./errors";
type Bucket = { count: number; reset: number };
export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(private maximum = 10000) {}
  take(key: string, limit: number, windowMs = 60000, now = Date.now()) {
    for (const [k, bucket] of this.buckets)
      if (bucket.reset <= now) this.buckets.delete(k);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maximum)
        throw new AppError("RATE_LIMIT", "请求较多，请稍后重试", 429, 60);
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
  const kind =
    path === "/api/identity"
      ? "identity"
      : path === "/api/reservations"
        ? "create"
        : path.includes("/participants")
          ? "roster"
          : "manage";
  const limits = { identity: 30, create: 10, roster: 30, manage: 60 };
  limiter.take(kind + ":global", kind === "create" ? 120 : 600);
  const source = requestSource(headers);
  if (source)
    limiter.take(kind + ":source:" + digest(source), limits[kind] * 3);
  if (token) limiter.take(kind + ":identity:" + digest(token), limits[kind]);
}
