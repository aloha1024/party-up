import { Prisma } from "@prisma/client";
import { db } from "./db";
import { reservationListSchema } from "../lib/reservation-list";
import { getStatus } from "../lib/status";
import type { ReservationPage } from "../types/reservation";

const select = {
  id: true,
  gameName: true,
  hostName: true,
  scheduledAt: true,
  maxPlayers: true,
  status: true,
  _count: { select: { participants: true } },
} satisfies Prisma.GameReservationSelect;

// Counts and page reads share a snapshot. No participant identities or full rosters are loaded.
export async function listReservations(
  input: unknown = {},
  now = new Date(),
): Promise<ReservationPage> {
  const filters = reservationListSchema.parse(input);
  const conditions: Prisma.GameReservationWhereInput[] = [{ deletedAt: null }];
  if (filters.q)
    conditions.push({
      OR: [
        { gameName: { contains: filters.q } },
        { hostName: { contains: filters.q } },
      ],
    });
  if (filters.view === "upcoming")
    conditions.push({ scheduledAt: { gt: now }, status: { not: "CANCELLED" } });
  if (filters.view === "started")
    conditions.push({
      scheduledAt: { lte: now },
      status: { not: "CANCELLED" },
    });
  if (filters.view === "cancelled") conditions.push({ status: "CANCELLED" });
  if (filters.date) {
    const start = new Date(filters.date + "T00:00:00+08:00");
    conditions.push({
      scheduledAt: { gte: start, lt: new Date(start.getTime() + 86400000) },
    });
  }
  return db.$transaction(
    async (tx) => {
      const where = { AND: conditions };
      const upcomingWhere = {
        AND: [...conditions, { scheduledAt: { gt: now } }],
      };
      const total = await tx.gameReservation.count({ where });
      const upcoming = await tx.gameReservation.count({ where: upcomingWhere });
      const pageCount = Math.max(1, Math.ceil(total / filters.pageSize));
      const page = Math.min(filters.page, pageCount);
      const offset = (page - 1) * filters.pageSize;
      const upcomingTake = Math.min(
        filters.pageSize,
        Math.max(0, upcoming - offset),
      );
      const orderBy = [{ scheduledAt: "asc" as const }, { id: "asc" as const }];
      const rows = upcomingTake
        ? await tx.gameReservation.findMany({
            where: upcomingWhere,
            select,
            orderBy,
            skip: offset,
            take: upcomingTake,
          })
        : [];
      const remaining = filters.pageSize - rows.length;
      if (remaining && offset + rows.length < total) {
        rows.push(
          ...(await tx.gameReservation.findMany({
            where: { AND: [...conditions, { scheduledAt: { lte: now } }] },
            select,
            orderBy,
            skip: Math.max(0, offset - upcoming),
            take: remaining,
          })),
        );
      }
      return {
        items: rows.map((row) => ({
          id: row.id,
          gameName: row.gameName,
          hostName: row.hostName,
          scheduledAt: row.scheduledAt.toISOString(),
          maxPlayers: row.maxPlayers,
          participantCount: row._count.participants,
          status: getStatus(row, row._count.participants, now),
        })),
        total,
        page,
        pageSize: filters.pageSize,
        pageCount,
        filters: { ...filters, page },
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
