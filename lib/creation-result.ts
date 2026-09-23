import { z } from "zod";

export const creationKeySchema = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{16,100}$/, "缺少有效的提交编号，请刷新页面");
export const creationResultSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("found"),
    reservation: z.object({
      id: z.string().min(1),
      gameName: z.string(),
      scheduledAt: z.string().datetime(),
    }),
  }),
  z.object({ state: z.literal("missing") }),
  z.object({ state: z.literal("removed") }),
]);
