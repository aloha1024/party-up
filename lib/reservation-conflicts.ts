import { z } from "zod";
import { reservationTemplateSourceSchema } from "./reservation-template";

export const reservationConflictsInputSchema = z
  .object({
    scheduledAt: z
      .string()
      .datetime({ offset: true, message: "请选择有效时间" }),
    exclude: reservationTemplateSourceSchema.optional(),
  })
  .strict();

export const reservationConflictsSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: reservationTemplateSourceSchema,
            gameName: z.string(),
            scheduledAt: z.iso.datetime(),
          })
          .strict(),
      )
      .max(5),
    hasMore: z.boolean(),
  })
  .strict();

export type ReservationConflicts = z.infer<typeof reservationConflictsSchema>;

export function reservationConflictsSearchParams(params: URLSearchParams) {
  return reservationConflictsInputSchema.parse(
    Object.fromEntries(
      [...new Set(params.keys())].map((key) => {
        const values = params.getAll(key);
        return [key, values.length === 1 ? values[0] : values];
      }),
    ),
  );
}
