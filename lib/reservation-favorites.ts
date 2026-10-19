import { z } from "zod";
import { reservationTemplateSourceSchema } from "./reservation-template";

export const favoriteReservationIdSchema = reservationTemplateSourceSchema;
export const favoriteResultSchema = z.object({ saved: z.boolean() }).strict();
export type FavoriteStatus = { saved: boolean; allowed: boolean };
