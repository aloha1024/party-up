import { z } from "zod";

export const calendarSettingsSchema = z.object({
  active: z.boolean(),
  version: z.number().int().nonnegative(),
  includeInvites: z.boolean(),
});
export type CalendarSettings = z.infer<typeof calendarSettingsSchema>;
export const calendarRotationSchema = z
  .object({
    version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    includeInvites: z.boolean(),
  })
  .strict();
export const calendarRevocationSchema = calendarRotationSchema.omit({
  includeInvites: true,
});
export const calendarRotationResultSchema = calendarSettingsSchema.extend({
  token: z.string().regex(/^[a-f0-9]{64}$/),
});
