import { z } from "zod";
export const attendanceOpensAt = (scheduledAt: string | Date) =>
  new Date(new Date(scheduledAt).getTime() - 30 * 60000);
const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const attendanceSchema = z
  .object({
    participantId: z.string().min(1).max(128),
    checkedIn: z.boolean(),
    attendanceVersion: version,
    editVersion: version,
  })
  .strict();
export const completionSchema = z.object({ editVersion: version }).strict();
