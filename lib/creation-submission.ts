import { z } from "zod";

const submissionSchema = z.object({
  payload: z.string().max(10000),
  key: z.string().regex(/^[a-f0-9]{64}$/),
});
export type CreationSubmission = z.infer<typeof submissionSchema>;
let inMemorySubmission: CreationSubmission | undefined;

export function readSubmission(): CreationSubmission | undefined {
  if (inMemorySubmission) return inMemorySubmission;
  try {
    const stored = submissionSchema.safeParse(
      JSON.parse(sessionStorage.getItem("party-creation") || "null"),
    );
    if (stored.success) return (inMemorySubmission = stored.data);
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
  inMemorySubmission = { payload, key };
  try {
    sessionStorage.setItem(
      "party-creation",
      JSON.stringify(inMemorySubmission),
    );
  } catch {}
  return key;
}
export function clearSubmission() {
  inMemorySubmission = undefined;
  try {
    sessionStorage.removeItem("party-creation");
  } catch {}
}
