import { Prisma, type GameReservation } from "@prisma/client";
import { z } from "zod";
import { db } from "./db";
import { AppError } from "./errors";
import { requireReservationAccess } from "./reservation-access";
import { requireUser, lockUser } from "./user-accounts";
import {
  digest,
  memberToken,
  validIdentity,
  viewerContext,
  type Viewer,
} from "./user-identity";
import { remainingBudget, writeTransaction } from "./request-budget";
import { measureTransaction } from "./request-metrics";
import {
  favoriteReservationIdSchema,
  type FavoriteStatus,
} from "../lib/reservation-favorites";
import { reservationListSchema } from "../lib/reservation-list";
import { getStatus } from "../lib/status";
import type { ReservationPage } from "../types/reservation";

// Internal detail reader. trustedAccessChecked may only be true after the caller
// has authorized this token without an administrator override in this same
// transaction. Administrator access never grants a user favorite access.
export async function readFavoriteStatus(
  tx: Prisma.TransactionClient,
  reservation: GameReservation,
  token?: string,
  trustedAccessChecked = false,
): Promise<FavoriteStatus | null> {
  if (!validIdentity(token) || !token.startsWith("user:")) return null;
  const user = await tx.user.findFirst({
    where: {
      identityKey: token.slice(5),
      isActive: true,
      mustChangePassword: false,
    },
    select: { id: true },
  });
  if (!user) return null;
  let allowed = true;
  if (!trustedAccessChecked) {
    try {
      await requireReservationAccess(tx, reservation, token);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "INVITATION_REQUIRED")
        throw error;
      allowed = false;
    }
  }
  const favorite = await tx.userReservationFavorite.findUnique({
    where: {
      userId_reservationId: { userId: user.id, reservationId: reservation.id },
    },
    select: { id: true },
  });
  return { saved: !!favorite, allowed };
}

export async function setFavorite(
  viewer: Viewer,
  inputId: unknown,
  saved: boolean,
): Promise<{ saved: boolean }> {
  requireUser(viewer);
  const id = favoriteReservationIdSchema.parse(inputId);
  const desired = z.boolean().parse(saved);
  return viewerContext.run(viewer, () =>
    writeTransaction(async (tx) => {
      // Acquire the SQLite write lock before checking live invitation access.
      // A bookmark does not modify the reservation or become an access grant.
      const user = await lockUser(tx, viewer);
      if (!desired) {
        await tx.userReservationFavorite.deleteMany({
          where: { userId: user.id, reservationId: id },
        });
        return { saved: false };
      }
      const reservation = await tx.gameReservation.findUnique({
        where: { id },
      });
      if (!reservation)
        throw new AppError("NOT_FOUND", "预约不存在或已被移除", 404);
      await requireReservationAccess(tx, reservation, memberToken(user));
      await tx.userReservationFavorite.upsert({
        where: { userId_reservationId: { userId: user.id, reservationId: id } },
        create: { userId: user.id, reservationId: id },
        update: {},
        select: { id: true },
      });
      return { saved: true };
    }),
  );
}

type FavoriteRow = {
  id: string;
  visibility: string;
  gameName: string;
  hostName: string;
  platform: string;
  gameServer: string;
  scheduledAt: number | bigint;
  registrationDeadline: number | bigint | null;
  recruitmentPaused: boolean | number | bigint;
  maxPlayers: number | bigint;
  status: string;
  participantCount: number | bigint;
};

export async function listFavorites(
  viewer: Viewer,
  input: unknown = {},
  now = new Date(),
): Promise<ReservationPage> {
  const user = requireUser(viewer);
  const filters = reservationListSchema.parse(input);
  const hash = digest(memberToken(user));
  const conditions = [
    Prisma.sql`f."userId" = ${user.id}`,
    Prisma.sql`r."deletedAt" IS NULL`,
    // Match requireReservationAccess without its administrator override.
    Prisma.sql`(r."visibility" = 'PUBLIC' OR r."hostTokenHash" = ${hash}
      OR EXISTS (SELECT 1 FROM "ReservationAccess" a
        WHERE a."reservationId" = r."id" AND a."tokenHash" = ${hash}
          AND (a."inviteVersion" = r."inviteVersion" OR a."hasJoined" = true))
      OR EXISTS (SELECT 1 FROM "Participant" p
        WHERE p."reservationId" = r."id" AND p."tokenHash" = ${hash})
      OR EXISTS (SELECT 1 FROM "WaitlistEntry" w
        WHERE w."reservationId" = r."id" AND w."tokenHash" = ${hash}))`,
  ];
  if (filters.q) {
    const pattern = `%${filters.q}%`;
    conditions.push(
      Prisma.sql`(r."gameName" LIKE ${pattern} OR r."hostName" LIKE ${pattern})`,
    );
  }
  if (filters.platform)
    conditions.push(Prisma.sql`r."platform" LIKE ${`%${filters.platform}%`}`);
  if (filters.gameServer)
    conditions.push(
      Prisma.sql`r."gameServer" LIKE ${`%${filters.gameServer}%`}`,
    );
  if (filters.date) {
    const start = new Date(`${filters.date}T00:00:00+08:00`).getTime();
    conditions.push(
      Prisma.sql`r."scheduledAt" >= ${start} AND r."scheduledAt" < ${start + 86400000}`,
    );
  }
  if (filters.view === "upcoming" || filters.view === "available")
    conditions.push(
      Prisma.sql`r."scheduledAt" > ${now.getTime()} AND r."status" NOT IN ('CANCELLED', 'ENDED')`,
    );
  if (filters.view === "started")
    conditions.push(
      Prisma.sql`r."scheduledAt" <= ${now.getTime()} AND r."status" NOT IN ('CANCELLED', 'ENDED')`,
    );
  if (filters.view === "cancelled")
    conditions.push(Prisma.sql`r."status" = 'CANCELLED'`);
  if (filters.view === "ended")
    conditions.push(Prisma.sql`r."status" = 'ENDED'`);
  if (filters.view === "available")
    conditions.push(
      Prisma.sql`r."recruitmentPaused" = false`,
      Prisma.sql`(r."registrationDeadline" IS NULL OR r."registrationDeadline" > ${now.getTime()})`,
      Prisma.sql`(SELECT COUNT(*) FROM "Participant" p WHERE p."reservationId" = r."id") < r."maxPlayers"`,
    );
  const where = Prisma.join(conditions, " AND ");
  const source = Prisma.sql`"UserReservationFavorite" f
    INNER JOIN "GameReservation" r ON r."id" = f."reservationId"`;
  const budget = Math.floor(remainingBudget());
  if (budget < 2) throw new AppError("BUSY", "服务繁忙，请稍后重试", 503);
  return measureTransaction(() =>
    db.$transaction(
      async (tx) => {
        const session = await tx.userSession.findFirst({
          where: {
            id: viewer.sessionHash,
            userId: user.id,
            version: viewer.version,
            expiresAt: { gt: new Date() },
            user: {
              isActive: true,
              mustChangePassword: false,
              version: viewer.version,
            },
          },
          select: { id: true },
        });
        if (!session)
          throw new AppError(
            "USER_SESSION",
            "登录或账号状态已变化，请重新登录",
            401,
          );
        const counts = await tx.$queryRaw<{ total: bigint }[]>(
          Prisma.sql`SELECT COUNT(*) AS total FROM ${source} WHERE ${where}`,
        );
        const total = Number(counts[0].total);
        const pageCount = Math.max(1, Math.ceil(total / filters.pageSize));
        const page = Math.min(filters.page, pageCount);
        const rows = total
          ? await tx.$queryRaw<FavoriteRow[]>(Prisma.sql`
              SELECT r."id", r."visibility", r."gameName", r."hostName",
                r."platform", r."gameServer", r."maxPlayers", r."status",
                CAST(r."scheduledAt" AS BIGINT) AS "scheduledAt",
                CAST(r."registrationDeadline" AS BIGINT) AS "registrationDeadline",
                r."recruitmentPaused",
                (SELECT COUNT(*) FROM "Participant" p WHERE p."reservationId" = r."id") AS "participantCount"
              FROM ${source} WHERE ${where}
              ORDER BY CASE WHEN r."scheduledAt" > ${now.getTime()} THEN 0 ELSE 1 END,
                r."scheduledAt" ASC, r."id" ASC
              LIMIT ${filters.pageSize} OFFSET ${(page - 1) * filters.pageSize}`)
          : [];
        return {
          items: rows.map((row) => {
            const scheduledAt = new Date(Number(row.scheduledAt));
            const participantCount = Number(row.participantCount);
            const maxPlayers = Number(row.maxPlayers);
            return {
              id: row.id,
              visibility: row.visibility as "PUBLIC" | "INVITE",
              gameName: row.gameName,
              hostName: row.hostName,
              platform: row.platform,
              gameServer: row.gameServer,
              scheduledAt: scheduledAt.toISOString(),
              registrationDeadline:
                row.registrationDeadline === null
                  ? null
                  : new Date(Number(row.registrationDeadline)).toISOString(),
              recruitmentPaused: !!row.recruitmentPaused,
              maxPlayers,
              participantCount,
              status: getStatus(
                { status: row.status, scheduledAt, maxPlayers },
                participantCount,
                now,
              ),
            };
          }),
          total,
          page,
          pageSize: filters.pageSize,
          pageCount,
          filters: { ...filters, page },
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: Math.max(1, Math.min(1000, Math.floor(budget / 4))),
        timeout: Math.max(1, Math.min(3000, Math.floor(budget * 0.7))),
      },
    ),
  );
}
