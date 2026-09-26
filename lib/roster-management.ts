import { z } from "zod";
import { nickname } from "./validation";

export const rosterKind = z.enum(["participants", "waitlist"]);
export type RosterKind = z.infer<typeof rosterKind>;
const entry = z.string().min(1).max(128);
export const renameSchema = z
  .object({ entryId: entry, expectedName: nickname, name: nickname })
  .strict();
export const removalSchema = z
  .object({
    kind: rosterKind,
    entryId: entry,
    expectedName: nickname,
    reason: z
      .string()
      .trim()
      .min(1, "请填写移除原因")
      .max(300, "移除原因最多 300 字"),
  })
  .strict();
export const removalItemSchema = z.object({
  id: z.number().int().positive(),
  kind: rosterKind,
  targetName: z.string(),
  reason: z.string(),
  actorRole: z.enum(["HOST", "ADMIN"]),
  createdAt: z.string().datetime(),
});
export const removalPageSchema = z.object({
  items: z.array(removalItemSchema).max(10),
  nextBefore: z.number().int().positive().nullable(),
});
export type RemovalItem = z.infer<typeof removalItemSchema>;
export type RemovalPage = z.infer<typeof removalPageSchema>;
