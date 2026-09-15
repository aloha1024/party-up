import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
const derive = promisify(scrypt);
export const ADMIN_COOKIE = "party_admin";
export const SESSION_SECONDS = 8 * 60 * 60;
export function adminConfigured() {
  return (
    !!process.env.ADMIN_USERNAME &&
    /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(
      process.env.ADMIN_PASSWORD_HASH || "",
    ) &&
    (process.env.ADMIN_SESSION_SECRET?.length ?? 0) >= 32
  );
}
export async function verifyCredentials(username: string, password: string) {
  if (!adminConfigured()) return false;
  const [, salt, expected] = process.env.ADMIN_PASSWORD_HASH!.split(":");
  const actual = (await derive(password, salt, 64)) as Buffer;
  return (
    timingSafeEqual(actual, Buffer.from(expected, "hex")) &&
    username === process.env.ADMIN_USERNAME
  );
}
function signature(payload: string) {
  return createHmac("sha256", process.env.ADMIN_SESSION_SECRET!)
    .update(
      `${process.env.ADMIN_USERNAME}:${process.env.ADMIN_PASSWORD_HASH}:${payload}`,
    )
    .digest("hex");
}
export function createAdminSession(now = Date.now()) {
  if (!adminConfigured()) throw new Error("Administrator is not configured");
  const payload = `${now + SESSION_SECONDS * 1000}.${randomBytes(24).toString("hex")}`;
  return `${payload}.${signature(payload)}`;
}
export function verifyAdminSession(token?: string, now = Date.now()) {
  if (!adminConfigured() || !token || token.length > 160) return false;
  const match = /^(\d{13})\.([a-f0-9]{48})\.([a-f0-9]{64})$/.exec(token);
  if (
    !match ||
    Number(match[1]) <= now ||
    Number(match[1]) > now + SESSION_SECONDS * 1000
  )
    return false;
  return timingSafeEqual(
    Buffer.from(match[3], "hex"),
    Buffer.from(signature(`${match[1]}.${match[2]}`), "hex"),
  );
}
// A single administrator and single SQLite instance: bound login work globally.
const state = globalThis as unknown as {
  adminAttempts?: { reset: number; count: number };
};
export function allowLoginAttempt(now = Date.now()) {
  if (!state.adminAttempts || state.adminAttempts.reset <= now)
    state.adminAttempts = { reset: now + 60000, count: 0 };
  return ++state.adminAttempts.count <= 10;
}
