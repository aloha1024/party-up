import type { Prisma } from "@prisma/client";
import { getStatus } from "../lib/status";
import { hashToken } from "./hash-token";
import { decryptPrivate } from "./private-value";
import { meetingFields } from "../lib/reservation-meeting";

export const reservationInclude = {
  waitlist: { orderBy: { id: "asc" as const } },
  participants: {
    orderBy: [{ joinedAt: "asc" as const }, { id: "asc" as const }],
  },
};
export type ReservationRow = Prisma.GameReservationGetPayload<{
  include: typeof reservationInclude;
}>;
export function serializeReservation(
  r: ReservationRow,
  token?: string,
  admin = false,
) {
  const hash = token ? hashToken(token) : "";
  const canViewMeeting =
    admin ||
    (!!hash &&
      (r.hostTokenHash === hash ||
        r.participants.some((p) => p.tokenHash === hash)));
  return {
    platform: r.platform,
    gameServer: r.gameServer,
    meeting: canViewMeeting
      ? {
          ...(r.meetingCipher
            ? meetingFields.parse(
                JSON.parse(decryptPrivate(r.meetingCipher, "meeting")),
              )
            : { roomName: "", roomPassword: "", voice: "" }),
          version: r.meetingVersion,
        }
      : null,
    id: r.id,
    visibility: r.visibility as "PUBLIC" | "INVITE",
    editVersion: r.editVersion,
    endedAt: r.endedAt?.toISOString() ?? null,
    gameName: r.gameName,
    hostName: r.hostName,
    isHost: !!token && r.hostTokenHash === hashToken(token),
    scheduledAt: r.scheduledAt.toISOString(),
    registrationDeadline: r.registrationDeadline?.toISOString() ?? null,
    recruitmentPaused: r.recruitmentPaused,
    maxPlayers: r.maxPlayers,
    description: r.description,
    status: getStatus(r, r.participants.length),
    cancellationReason: r.cancellationReason,
    waitlist: r.waitlist.map((p) => ({
      isHost: p.tokenHash === r.hostTokenHash,
      id: p.id,
      name: p.name,
      joinedAt: p.joinedAt.toISOString(),
      isMe: !!token && p.tokenHash === hashToken(token),
    })),
    participants: r.participants.map((p) => ({
      checkedInAt: p.checkedInAt?.toISOString() ?? null,
      attendanceVersion: p.attendanceVersion,
      isHost: p.tokenHash === r.hostTokenHash,
      id: p.id,
      name: p.name,
      joinedAt: p.joinedAt.toISOString(),
      isMe: !!token && p.tokenHash === hashToken(token),
    })),
  };
}
