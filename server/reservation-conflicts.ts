import { db } from "./db";
import { identityHash } from "./reservation-access";
import {
  reservationConflictsInputSchema,
  type ReservationConflicts,
} from "../lib/reservation-conflicts";

// This is an advisory read of the caller's current formal memberships. An
// invitation's presence or an administrator session does not expand its scope.
export async function listReservationConflicts(
  token: string | undefined,
  input: unknown,
): Promise<ReservationConflicts> {
  const filters = reservationConflictsInputSchema.parse(input);
  const tokenHash = identityHash(token);
  if (!tokenHash) return { items: [], hasMore: false };
  const rows = await db.gameReservation.findMany({
    where: {
      deletedAt: null,
      status: { notIn: ["CANCELLED", "ENDED"] },
      scheduledAt: new Date(filters.scheduledAt),
      ...(filters.exclude ? { id: { not: filters.exclude } } : {}),
      participants: { some: { tokenHash } },
    },
    select: { id: true, gameName: true, scheduledAt: true },
    orderBy: { id: "asc" },
    take: 6,
  });
  return {
    items: rows.slice(0, 5).map((row) => ({
      ...row,
      scheduledAt: row.scheduledAt.toISOString(),
    })),
    hasMore: rows.length > 5,
  };
}
