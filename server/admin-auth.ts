import {
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(scrypt);
export const ADMIN_COOKIE = "party_admin";
export const SESSION_SECONDS = 8 * 60 * 60;

export function adminBootstrapConfigured() {
  return (
    !!process.env.ADMIN_USERNAME &&
    /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(
      process.env.ADMIN_PASSWORD_HASH || "",
    ) &&
    (process.env.ADMIN_SESSION_SECRET?.length ?? 0) >= 32
  );
}

export function bootstrapFingerprint() {
  if (!adminBootstrapConfigured())
    throw new Error("Administrator bootstrap is not configured");
  return createHash("sha256")
    .update(`${process.env.ADMIN_USERNAME}:${process.env.ADMIN_PASSWORD_HASH}`)
    .digest("hex");
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = (await derive(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${hash.toString("hex")}`;
}

export async function verifyPasswordHash(password: string, encoded: string) {
  if (!/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(encoded)) return false;
  const [, salt, expected] = encoded.split(":");
  const actual = (await derive(password, salt, 64)) as Buffer;
  return timingSafeEqual(actual, Buffer.from(expected, "hex"));
}

function signature(payload: string) {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret || secret.length < 32)
    throw new Error("Administrator session secret is not configured");
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function createAdminSession(sessionVersion: number, now = Date.now()) {
  const payload = `${now + SESSION_SECONDS * 1000}.${sessionVersion}.${randomBytes(24).toString("hex")}`;
  return `${payload}.${signature(payload)}`;
}

export function readAdminSession(token?: string, now = Date.now()) {
  if (!adminBootstrapConfigured() || !token || token.length > 180) return null;
  const match = /^(\d{13})\.(\d+)\.([a-f0-9]{48})\.([a-f0-9]{64})$/.exec(token);
  if (
    !match ||
    Number(match[1]) <= now ||
    Number(match[1]) > now + SESSION_SECONDS * 1000
  )
    return null;
  const payload = `${match[1]}.${match[2]}.${match[3]}`;
  if (
    !timingSafeEqual(
      Buffer.from(match[4], "hex"),
      Buffer.from(signature(payload), "hex"),
    )
  )
    return null;
  return { sessionVersion: Number(match[2]) };
}

const state = globalThis as unknown as {
  adminAttempts?: { reset: number; count: number };
};
export function allowLoginAttempt(now = Date.now()) {
  if (!state.adminAttempts || state.adminAttempts.reset <= now)
    state.adminAttempts = { reset: now + 60000, count: 0 };
  return ++state.adminAttempts.count <= 10;
}
