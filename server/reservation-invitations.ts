import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { db } from "./db";
import { mutate } from "./reservations";
import { identityHash } from "./reservation-access";
import { newInvitation, decryptInvitation } from "./invitation-credential";
import { AppError } from "./errors";
import { recordAdminAction, type AuditActor } from "./admin-audit";
import type { GameReservation } from "@prisma/client";

function manager(
  r: GameReservation | null,
  token?: string,
  admin?: AuditActor | null,
) {
  if (!r || r.deletedAt || r.visibility !== "INVITE")
    throw new AppError("NOT_FOUND", "邀请预约不存在", 404);
  if (
    !admin &&
    (!identityHash(token) || identityHash(token) !== r.hostTokenHash)
  )
    throw new AppError("FORBIDDEN", "只有发起人或管理员可以管理邀请", 403);
  return r;
}
export async function currentInvitation(
  id: string,
  token?: string,
  admin?: AuditActor | null,
) {
  const r = manager(
    await db.gameReservation.findUnique({ where: { id } }),
    token,
    admin,
  );
  return {
    path: `/reservation/${id}#invite=${decryptInvitation(r.inviteCipher!)}`,
    version: r.inviteVersion,
  };
}
export async function rotateInvitation(
  id: string,
  input: unknown,
  token: string,
  admin: AuditActor | null = null,
) {
  const { expectedVersion } = z
    .object({ expectedVersion: z.number().int().positive().max(2147483646) })
    .strict()
    .parse(input);
  await mutate(id, async (tx, r) => {
    manager(r, token, admin);
    if (expectedVersion !== r.inviteVersion)
      throw new AppError(
        "INVITATION_CHANGED",
        "邀请已更换，请重新获取当前链接",
        409,
      );
    await tx.gameReservation.update({
      where: { id },
      data: { ...newInvitation(), inviteVersion: { increment: 1 } },
    });
    if (admin)
      await recordAdminAction(tx, admin, "RESERVATION_INVITE_ROTATE", {
        id,
        label: r.gameName,
      });
  });
  return { updated: true };
}
export async function acceptInvitation(
  id: string,
  input: unknown,
  token: string,
) {
  const data = z
    .object({ token: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict()
    .parse(input);
  const tokenHash = identityHash(token);
  if (!tokenHash)
    throw new AppError("IDENTITY_REQUIRED", "请先建立浏览器身份", 428);
  await mutate(id, async (tx, r) => {
    const hash = createHash("sha256").update(data.token).digest();
    if (
      r.visibility !== "INVITE" ||
      !r.inviteHash ||
      !timingSafeEqual(hash, Buffer.from(r.inviteHash, "hex"))
    )
      throw new AppError(
        "INVITATION_INVALID",
        "邀请无效或已更换，请获取当前邀请",
        404,
      );
    await tx.reservationAccess.upsert({
      where: { reservationId_tokenHash: { reservationId: id, tokenHash } },
      create: { reservationId: id, tokenHash, inviteVersion: r.inviteVersion },
      update: { inviteVersion: r.inviteVersion },
    });
  });
  return { accepted: true };
}
