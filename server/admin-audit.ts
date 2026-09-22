import type { Prisma } from "@prisma/client";
import type { AuditAction } from "../lib/admin-audit";
export type AuditActor = { id: number; username: string };
// All values are explicitly selected. Never serialize an administrator record or request body.
export async function recordAdminAction(
  tx: Prisma.TransactionClient,
  actor: AuditActor,
  action: AuditAction,
  target: { id: string; label: string },
) {
  await tx.adminAuditLog.create({
    data: {
      actorId: actor.id,
      actorName: actor.username,
      action,
      targetType: action.startsWith("RESERVATION_") ? "reservation" : "admin",
      targetId: target.id,
      targetLabel: target.label,
    },
  });
}
