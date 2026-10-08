import { z } from "zod";

export const meetingFields = z.object({
  roomName: z.string().trim().max(100, "房间号最多 100 字"),
  roomPassword: z.string().trim().max(100, "房间密码最多 100 字"),
  voice: z.string().trim().max(1000, "语音入口最多 1000 字"),
});
export const meetingSchema = meetingFields
  .extend({
    version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type Meeting = z.infer<typeof meetingSchema>;
