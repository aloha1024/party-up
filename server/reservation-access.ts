import { createHash } from "node:crypto";
import type { GameReservation, Prisma } from "@prisma/client";
import { AppError } from "./errors";

export const identityHash = (token?: string) =>
  token && /^[a-f0-9]{64}$/.test(token)
    ? createHash("sha256").update(token).digest("hex")
    : "";
// Called inside the caller's read snapshot or reservation write lock. Admin is
// supplied only by a server caller that has validated the current session.
export async function requireReservationAccess(
  tx: Prisma.TransactionClient,
  r: GameReservation,
  token?: string,
  admin = false,
  joining = false,
) {
  if (r.deletedAt) throw new AppError("NOT_FOUND", "预约不存在或已被移除", 404);
  if (r.visibility === "PUBLIC") return;
  const hash = identityHash(token);
  if ((hash && hash === r.hostTokenHash) || (admin && !joining)) return;
  const grant = hash
    ? await tx.reservationAccess.findUnique({
        where: {
          reservationId_tokenHash: { reservationId: r.id, tokenHash: hash },
        },
      })
    : null;
  if (
    grant &&
    (grant.inviteVersion === r.inviteVersion || (!joining && grant.hasJoined))
  )
    return;
  if (
    !joining &&
    hash &&
    ((await tx.participant.count({
      where: { reservationId: r.id, tokenHash: hash },
    })) ||
      (await tx.waitlistEntry.count({
        where: { reservationId: r.id, tokenHash: hash },
      })))
  )
    return;
  throw new AppError(
    "INVITATION_REQUIRED",
    joining ? "请先接受当前有效邀请后再报名" : "请获取当前有效邀请后查看",
    404,
  );
}
export async function rememberMember(
  tx: Prisma.TransactionClient,
  r: GameReservation,
  token: string,
) {
  if (r.visibility !== "INVITE") return;
  const tokenHash = identityHash(token);
  await tx.reservationAccess.upsert({
    where: { reservationId_tokenHash: { reservationId: r.id, tokenHash } },
    create: {
      reservationId: r.id,
      tokenHash,
      inviteVersion: r.inviteVersion,
      hasJoined: true,
    },
    update: { hasJoined: true },
  });
}
