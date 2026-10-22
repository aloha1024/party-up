import { Prisma } from "@prisma/client";
import { db } from "./db";
import { requireAdmin } from "./admin";
import { decryptInvitation } from "./invitation-credential";
import { availableReservationConditions } from "./reservation-availability";
import type { AdminShareItem } from "../lib/admin-reservation-share";

type Row = {
  id: string;
  gameName: string;
  scheduledAt: Date;
  maxPlayers: number;
  participantCount: bigint;
  visibility: "PUBLIC" | "INVITE";
  inviteCipher: string | null;
};

export async function adminReservationShare(now = new Date()) {
  await requireAdmin();
  // One statement keeps eligibility, counts and links in the same snapshot.
  // No page limit or user-supplied filters: copy all currently available games.
  const rows = await db.$queryRaw<Row[]>(Prisma.sql`
    SELECT r."id", r."gameName", r."scheduledAt", r."maxPlayers", r."visibility", r."inviteCipher",
      (SELECT COUNT(*) FROM "Participant" p WHERE p."reservationId" = r."id") AS "participantCount"
    FROM "GameReservation" r
    WHERE ${Prisma.join(availableReservationConditions(now), " AND ")}
    ORDER BY r."scheduledAt" ASC, r."id" ASC
  `);
  const items: AdminShareItem[] = rows.map((row) => ({
    gameName: row.gameName,
    participantCount: Number(row.participantCount),
    maxPlayers: row.maxPlayers,
    scheduledAt: new Date(row.scheduledAt).toISOString(),
    visibility: row.visibility,
    path: `/reservation/${encodeURIComponent(row.id)}${row.visibility === "INVITE" ? `#invite=${decryptInvitation(row.inviteCipher!)}` : ""}`,
  }));
  return { items };
}
