import { z } from "zod";
import { creationInputSchema, creationFingerprint } from "./validation";

const fieldsSchema = z.object({
  visibility: z.enum(["PUBLIC", "INVITE"]).optional(),
  gameName: z.string().max(80),
  date: z.string().max(32),
  time: z.string().max(32),
  hostName: z.string().max(24),
  maxPlayers: z.string().max(32),
  description: z.string().max(1000),
});
const draftSchema = z.object({
  version: z.literal(1),
  fields: fieldsSchema,
  editVersion: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
});
export type ReservationFields = z.infer<typeof fieldsSchema>;
export type ReservationDraft = z.infer<typeof draftSchema>;
const key = (id?: string) =>
  `party-reservation-draft:${id ? "edit:" + id : "new"}`;

export function readDraft(id?: string): ReservationDraft | undefined {
  try {
    const value = draftSchema.safeParse(
      JSON.parse(sessionStorage.getItem(key(id)) || "null"),
    );
    if (value.success) return value.data;
  } catch {}
}
export function saveDraft(
  fields: ReservationFields,
  id?: string,
  editVersion?: number,
) {
  try {
    sessionStorage.setItem(
      key(id),
      JSON.stringify({
        version: 1,
        fields,
        ...(editVersion === undefined ? {} : { editVersion }),
      }),
    );
    return true;
  } catch {
    return false;
  }
}
export function clearDraft(id?: string) {
  try {
    sessionStorage.removeItem(key(id));
  } catch {}
}
export function draftMatchesVersion(
  draft: ReservationDraft,
  editVersion?: number,
) {
  return draft.editVersion === editVersion;
}

export function creationInputFromFields(fields: ReservationFields) {
  const date = new Date(`${fields.date}T${fields.time}:00+08:00`);
  return {
    visibility: fields.visibility ?? "PUBLIC",
    gameName: fields.gameName,
    hostName: fields.hostName,
    scheduledAt: isNaN(date.getTime()) ? "" : date.toISOString(),
    maxPlayers: Number(fields.maxPlayers),
    description: fields.description,
  };
}
export function draftMatchesSubmission(
  fields: ReservationFields,
  payload: string,
) {
  // A lookup can confirm an old submission after its start time; no future-time validation here.
  const parsed = creationInputSchema.safeParse(creationInputFromFields(fields));
  try {
    const stored = creationInputSchema.safeParse(JSON.parse(payload));
    return (
      parsed.success &&
      stored.success &&
      creationFingerprint(parsed.data) === creationFingerprint(stored.data)
    );
  } catch {
    return false;
  }
}
