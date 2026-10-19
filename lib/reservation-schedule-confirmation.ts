import { z } from "zod";

export const scheduleConfirmationSchema = z
  .object({
    participantId: z.string().min(1).max(128),
    scheduleVersion: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
