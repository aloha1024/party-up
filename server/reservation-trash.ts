import { Prisma } from "@prisma/client";
import { db } from "./db";
import { reservationTrashSchema } from "../lib/reservation-trash";
import type { TrashPage } from "../types/reservation-trash";

// Internal query: page and API callers must authenticate the administrator first.
export async function listDeletedReservations(
  input: unknown = {},
): Promise<TrashPage> {
  const filters = reservationTrashSchema.parse(input);
  const where: Prisma.GameReservationWhereInput = {
    deletedAt: { not: null },
  };
  if (filters.q)
    where.OR = [
      { gameName: { contains: filters.q } },
      { hostName: { contains: filters.q } },
      { id: { contains: filters.q } },
    ];
  if (filters.date) {
    const start = new Date(filters.date + "T00:00:00+08:00");
    where.deletedAt = { gte: start, lt: new Date(start.getTime() + 86400000) };
  }
  return db.$transaction(
    async (tx) => {
      const total = await tx.gameReservation.count({ where });
      const pageCount = Math.max(1, Math.ceil(total / filters.pageSize));
      const page = Math.min(filters.page, pageCount);
      const rows = await tx.gameReservation.findMany({
        where,
        select: {
          id: true,
          gameName: true,
          hostName: true,
          deletedAt: true,
          _count: { select: { participants: true } },
        },
        orderBy: [{ deletedAt: "desc" }, { id: "asc" }],
        skip: (page - 1) * filters.pageSize,
        take: filters.pageSize,
      });
      return {
        items: rows.map((row) => ({
          id: row.id,
          gameName: row.gameName,
          hostName: row.hostName,
          deletedAt: row.deletedAt!.toISOString(),
          participantCount: row._count.participants,
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
