import { z } from "zod";
import { request } from "./client-request";
let pending: Promise<void> | undefined;
let inMemorySubmission: { payload: string; key: string } | undefined;
export async function ensureBrowserIdentity() {
  if (pending) return pending;
  const establish = async () => {
    const options = { schema: z.object({ ready: z.boolean() }) };
    if ((await request("/api/identity", "GET", undefined, options)).ready)
      return;
    await request("/api/identity", "POST");
    if (!(await request("/api/identity", "GET", undefined, options)).ready)
      throw new Error("浏览器未保存报名身份，请允许本站 Cookie 后重试");
  };
  pending = (async () => {
    if (typeof navigator !== "undefined" && navigator.locks)
      await navigator.locks.request("party-identity", establish);
    else await establish();
  })();
  try {
    await pending;
  } finally {
    pending = undefined;
  }
}
export function submissionKey(input: unknown): string {
  const payload = JSON.stringify(input);
  if (inMemorySubmission?.payload === payload) return inMemorySubmission.key;
  try {
    const previous = JSON.parse(
      sessionStorage.getItem("party-creation") || "null",
    );
    if (previous?.payload === payload && /^[a-f0-9]{64}$/.test(previous.key))
      return previous.key;
  } catch {}
  const key = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  inMemorySubmission = { payload, key };
  try {
    sessionStorage.setItem("party-creation", JSON.stringify({ payload, key }));
  } catch {}
  return key;
}
export function clearSubmission() {
  inMemorySubmission = undefined;
  try {
    sessionStorage.removeItem("party-creation");
  } catch {}
}
