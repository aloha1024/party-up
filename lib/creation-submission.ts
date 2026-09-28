import { z } from "zod";
import { scopedStorageKey, legacyStorageAllowed } from "./client-identity";

const submissionSchema = z.object({
  payload: z.string().max(10000),
  key: z.string().regex(/^[a-f0-9]{64}$/),
});
export type CreationSubmission = z.infer<typeof submissionSchema>;
const memory = new Map<string, CreationSubmission>();

export function readSubmission(): CreationSubmission | undefined {
  const key = scopedStorageKey("party-creation");
  if (memory.has(key)) return memory.get(key);
  try {
    if (
      legacyStorageAllowed() &&
      key !== "party-creation" &&
      !sessionStorage.getItem(key) &&
      sessionStorage.getItem("party-creation")
    ) {
      sessionStorage.setItem(key, sessionStorage.getItem("party-creation")!);
      sessionStorage.removeItem("party-creation");
    }
    const stored = submissionSchema.safeParse(
      JSON.parse(sessionStorage.getItem(key) || "null"),
    );
    if (stored.success) {
      memory.set(key, stored.data);
      return stored.data;
    }
  } catch {}
}
export function submissionKey(input: unknown): string {
  const payload = JSON.stringify(input);
  const previous = readSubmission();
  if (previous) {
    if (previous.payload !== payload)
      throw new Error(
        "上次创建结果尚未确认，请先查看上次创建结果；更改内容前请明确放弃上次提交。",
      );
    return previous.key;
  }
  const key = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const submission = { payload, key };
  memory.set(scopedStorageKey("party-creation"), submission);
  try {
    sessionStorage.setItem(
      scopedStorageKey("party-creation"),
      JSON.stringify(submission),
    );
  } catch {}
  return key;
}
export function clearSubmission() {
  memory.delete(scopedStorageKey("party-creation"));
  try {
    sessionStorage.removeItem(scopedStorageKey("party-creation"));
  } catch {}
}
