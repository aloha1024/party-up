import { Prisma } from "@prisma/client";
import { db } from "./db";
import { measureTransaction } from "./request-metrics";
import {
  reservationListSchema,
  myReservationListSchema,
  type ReservationFilters,
  type MyReservationTab,
} from "../lib/reservation-list";
import { createHash } from "node:crypto";
import { getStatus } from "../lib/status";
import type { ReservationPage } from "../types/reservation";

const select = {
  id: true,
  visibility: true,
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
  return queryReservations(input, now, undefined, true);
}

export async function listAdminReservations(
  input: unknown = {},
  now = new Date(),
) {
  return queryReservations(input, now);
}

export async function listMyReservations(
  input: unknown,
  token?: string,
  now = new Date(),
): Promise<ReservationPage> {
  const { tab, ...filters } = myReservationListSchema.parse(input);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    return {
      items: [],
      total: 0,
      page: 1,
      pageSize: filters.pageSize,
      pageCount: 1,
      filters: { ...filters, page: 1 },
    };
  }
  const hash = createHash("sha256").update(token).digest("hex");
  return queryReservations(filters, now, { tab, hash });
}

async function queryReservations(
  input: unknown,
  now: Date,
  identityScope?: { tab: MyReservationTab; hash: string },
  publicOnly = false,
): Promise<ReservationPage> {
  const filters = reservationListSchema.parse(input);
  if (filters.view === "available")
    return availableReservations(filters, now, identityScope, publicOnly);
  const conditions: Prisma.GameReservationWhereInput[] = [{ deletedAt: null }];
  if (publicOnly) conditions.push({ visibility: "PUBLIC" });
  if (identityScope)
    conditions.push(
      identityScope.tab === "hosted"
        ? { hostTokenHash: identityScope.hash }
        : identityScope.tab === "waiting"
          ? { waitlist: { some: { tokenHash: identityScope.hash } } }
          : { participants: { some: { tokenHash: identityScope.hash } } },
    );
  if (filters.q)
    conditions.push({
      OR: [
        { gameName: { contains: filters.q } },
        { hostName: { contains: filters.q } },
      ],
    });
  if (filters.view === "upcoming")
    conditions.push({
      scheduledAt: { gt: now },
      status: { notIn: ["CANCELLED", "ENDED"] },
    });
  if (filters.view === "started")
    conditions.push({
      scheduledAt: { lte: now },
      status: { notIn: ["CANCELLED", "ENDED"] },
    });
  if (filters.view === "ended") conditions.push({ status: "ENDED" });
  if (filters.view === "cancelled") conditions.push({ status: "CANCELLED" });
  if (filters.date) {
    const start = new Date(filters.date + "T00:00:00+08:00");
    conditions.push({
      scheduledAt: { gte: start, lt: new Date(start.getTime() + 86400000) },
    });
  }
  return measureTransaction(() =>
    db.$transaction(
      async (tx) => {
        const where = { AND: conditions };
        const upcomingWhere = {
          AND: [...conditions, { scheduledAt: { gt: now } }],
        };
        const total = await tx.gameReservation.count({ where });
        const upcoming =
          total === 0 || filters.view === "started"
            ? 0
            : filters.view === "upcoming"
              ? total
              : await tx.gameReservation.count({ where: upcomingWhere });
        const pageCount = Math.max(1, Math.ceil(total / filters.pageSize));
        const page = Math.min(filters.page, pageCount);
        const offset = (page - 1) * filters.pageSize;
        const upcomingTake = Math.min(
          filters.pageSize,
          Math.max(0, upcoming - offset),
        );
        const orderBy = [
          { scheduledAt: "asc" as const },
          { id: "asc" as const },
        ];
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
            visibility: row.visibility as "PUBLIC" | "INVITE",
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
    ),
  );
}

async function availableReservations(
  filters: ReservationFilters,
  now: Date,
  scope?: { tab: MyReservationTab; hash: string },
  publicOnly = false,
): Promise<ReservationPage> {
  // Prisma SQLite stores DateTime as epoch milliseconds. All input values stay bound parameters.
  const conditions = [
    Prisma.sql`r."deletedAt" IS NULL`,
    Prisma.sql`r."status" NOT IN ('CANCELLED', 'ENDED')`,
    Prisma.sql`r."scheduledAt" > ${now.getTime()}`,
    Prisma.sql`(SELECT COUNT(*) FROM "Participant" p WHERE p."reservationId" = r."id") < r."maxPlayers"`,
  ];
  if (publicOnly) conditions.push(Prisma.sql`r."visibility" = 'PUBLIC'`);
  if (filters.q) {
    // Match Prisma SQLite contains semantics, including LIKE wildcards and ASCII case folding.
    const pattern = `%${filters.q}%`;
    conditions.push(
      Prisma.sql`(r."gameName" LIKE ${pattern} OR r."hostName" LIKE ${pattern})`,
    );
  }
  if (filters.date) {
    const start = new Date(filters.date + "T00:00:00+08:00").getTime();
    conditions.push(
      Prisma.sql`r."scheduledAt" >= ${start} AND r."scheduledAt" < ${start + 86400000}`,
    );
  }
  if (scope)
    conditions.push(
      scope.tab === "hosted"
        ? Prisma.sql`r."hostTokenHash" = ${scope.hash}`
        : scope.tab === "waiting"
          ? Prisma.sql`EXISTS (SELECT 1 FROM "WaitlistEntry" me WHERE me."reservationId" = r."id" AND me."tokenHash" = ${scope.hash})`
          : Prisma.sql`EXISTS (SELECT 1 FROM "Participant" me WHERE me."reservationId" = r."id" AND me."tokenHash" = ${scope.hash})`,
    );
  const where = Prisma.join(conditions, " AND ");
  return measureTransaction(() =>
    db.$transaction(
      async (tx) => {
        const counts = await tx.$queryRaw<{ total: bigint }[]>(
          Prisma.sql`SELECT COUNT(*) AS total FROM "GameReservation" r WHERE ${where}`,
        );
        const total = Number(counts[0].total);
        const pageCount = Math.max(1, Math.ceil(total / filters.pageSize));
        const page = Math.min(filters.page, pageCount);
        const ids = total
          ? await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT r."id" FROM "GameReservation" r WHERE ${where}
      ORDER BY r."scheduledAt" ASC, r."id" ASC LIMIT ${filters.pageSize} OFFSET ${(page - 1) * filters.pageSize}`)
          : [];
        const rows = ids.length
          ? await tx.gameReservation.findMany({
              where: { id: { in: ids.map((r) => r.id) } },
              select,
            })
          : [];
        const byId = new Map(rows.map((r) => [r.id, r]));
        return {
          items: ids.map(({ id }) => {
            const row = byId.get(id)!;
            return {
              id,
              visibility: row.visibility as "PUBLIC" | "INVITE",
              gameName: row.gameName,
              hostName: row.hostName,
              scheduledAt: row.scheduledAt.toISOString(),
              maxPlayers: row.maxPlayers,
              participantCount: row._count.participants,
              status: getStatus(row, row._count.participants, now),
            };
          }),
          total,
          page,
          pageSize: filters.pageSize,
          pageCount,
          filters: { ...filters, page },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
