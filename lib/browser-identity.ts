import { withIdentityLock } from "./identity-lock";
import { z } from "zod";
import { request } from "./client-request";
import {
  getClientIdentity,
  setClientIdentity,
  rejectStaleIdentity,
} from "./client-identity";
import { publicIdentitySchema, type PublicIdentity } from "./user-account";
let pending: Promise<void> | undefined;
function accept(next: PublicIdentity) {
  const previous = getClientIdentity();
  const bootstrapped = previous?.mode === "anonymous" && next.mode === "guest";
  if (previous && previous.scope !== next.scope && !bootstrapped) {
    rejectStaleIdentity();
    throw new Error("身份已变化，请刷新页面");
  }
  setClientIdentity(next);
}
export async function ensureBrowserIdentity() {
  if (pending) return pending;
  const establish = async () => {
    const options = { schema: publicIdentitySchema };
    const existing = await request("/api/identity", "GET", undefined, options);
    accept(existing);
    if (existing.ready) return;
    await request("/api/identity", "POST");
    const next = await request("/api/identity", "GET", undefined, options);
    if (!next.ready)
      throw new Error("浏览器未保存报名身份，请允许本站 Cookie 后重试");
    accept(next);
  };
  pending = (async () => {
    // Existing identities work even if browser storage later becomes restricted.
    const next = await request("/api/identity", "GET", undefined, {
      schema: publicIdentitySchema,
    });
    accept(next);
    if (next.ready) {
      return;
    }
    await withIdentityLock(establish);
  })();
  try {
    await pending;
  } finally {
    pending = undefined;
  }
}
export { submissionKey, clearSubmission } from "./creation-submission";
