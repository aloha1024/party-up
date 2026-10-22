import { Prisma } from "@prisma/client";

// Shared by paginated lists and the administrator's complete sharing snapshot.
// The reservation table must use alias r; SQLite DateTime values are epoch ms.
export function availableReservationConditions(now: Date) {
  return [
    Prisma.sql`r."deletedAt" IS NULL`,
    Prisma.sql`r."status" NOT IN ('CANCELLED', 'ENDED')`,
    Prisma.sql`r."scheduledAt" > ${now.getTime()}`,
    Prisma.sql`r."recruitmentPaused" = false`,
    Prisma.sql`(r."registrationDeadline" IS NULL OR r."registrationDeadline" > ${now.getTime()})`,
    Prisma.sql`(SELECT COUNT(*) FROM "Participant" p WHERE p."reservationId" = r."id") < r."maxPlayers"`,
  ];
}
