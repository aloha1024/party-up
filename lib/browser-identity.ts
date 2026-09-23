import { withIdentityLock } from "./identity-lock";
import { z } from "zod";
import { request } from "./client-request";
let pending: Promise<void> | undefined;
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
    // Existing identities work even if browser storage later becomes restricted.
    if (
      (
        await request("/api/identity", "GET", undefined, {
          schema: z.object({ ready: z.boolean() }),
        })
      ).ready
    )
      return;
    await withIdentityLock(establish);
  })();
  try {
    await pending;
  } finally {
    pending = undefined;
  }
}
export { submissionKey, clearSubmission } from "./creation-submission";
