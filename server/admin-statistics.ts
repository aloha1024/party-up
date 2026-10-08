import { Prisma } from "@prisma/client";
import { db } from "./db";
import {
  adminStatisticsSchema,
  statisticsBounds,
  type AdminStatistics,
} from "../lib/admin-statistics";

type Totals = {
  total: bigint;
  upcoming: bigint;
  started: bigint;
  ended: bigint;
  cancelled: bigint;
  participants: bigint;
  waitlist: bigint;
  checkedIn: bigint;
  accountTotal: bigint;
  accountActive: bigint;
};

// Internal reader: the page must validate currentAdmin before calling it.
// A single aggregate statement shares one database snapshot and returns one row;
// private reservations, identities and complete rosters never enter the result.
export async function adminStatistics(
  input: unknown = {},
  now = new Date(),
): Promise<AdminStatistics> {
  const { range } = adminStatisticsSchema.parse(input);
  const { start, end } = statisticsBounds(range, now);
  const [counts] = await db.$queryRaw<Totals[]>(Prisma.sql`
    WITH scoped AS (
      SELECT "id", "status", "scheduledAt" FROM "GameReservation"
      WHERE "deletedAt" IS NULL
        AND "scheduledAt" >= ${start.getTime()}
        AND "scheduledAt" < ${end.getTime()}
    )
    SELECT
      COUNT(*) AS "total",
      COALESCE(SUM(CASE WHEN "status" NOT IN ('CANCELLED', 'ENDED') AND "scheduledAt" > ${now.getTime()} THEN 1 ELSE 0 END), 0) AS "upcoming",
      COALESCE(SUM(CASE WHEN "status" NOT IN ('CANCELLED', 'ENDED') AND "scheduledAt" <= ${now.getTime()} THEN 1 ELSE 0 END), 0) AS "started",
      COALESCE(SUM(CASE WHEN "status" = 'ENDED' THEN 1 ELSE 0 END), 0) AS "ended",
      COALESCE(SUM(CASE WHEN "status" = 'CANCELLED' THEN 1 ELSE 0 END), 0) AS "cancelled",
      (SELECT COUNT(*) FROM "Participant" p INNER JOIN scoped r ON r."id" = p."reservationId") AS "participants",
      (SELECT COUNT(*) FROM "WaitlistEntry" w INNER JOIN scoped r ON r."id" = w."reservationId") AS "waitlist",
      (SELECT COUNT(*) FROM "Participant" p INNER JOIN scoped r ON r."id" = p."reservationId" WHERE p."checkedInAt" IS NOT NULL) AS "checkedIn",
      (SELECT COUNT(*) FROM "User") AS "accountTotal",
      (SELECT COUNT(*) FROM "User" WHERE "isActive" = true) AS "accountActive"
    FROM scoped
  `);
  return {
    range,
    start: start.toISOString(),
    end: end.toISOString(),
    asOf: now.toISOString(),
    reservations: {
      total: Number(counts.total),
      upcoming: Number(counts.upcoming),
      started: Number(counts.started),
      ended: Number(counts.ended),
      cancelled: Number(counts.cancelled),
    },
    roster: {
      participants: Number(counts.participants),
      waitlist: Number(counts.waitlist),
      checkedIn: Number(counts.checkedIn),
    },
    accounts: {
      total: Number(counts.accountTotal),
      active: Number(counts.accountActive),
    },
  };
}
