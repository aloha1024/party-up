import { createHash } from "node:crypto";
import { db } from "./db";
import { AppError } from "./errors";
import { reservationTemplateSourceSchema } from "../lib/reservation-template";
import type { ReservationTemplate } from "../types/reservation";

export async function reservationTemplate(
  source: string,
  token?: string,
): Promise<ReservationTemplate> {
  const id = reservationTemplateSourceSchema.parse(source);
  const row = await db.gameReservation.findUnique({
    where: { id, deletedAt: null },
    select: {
      visibility: true,
      gameName: true,
      hostName: true,
      maxPlayers: true,
      description: true,
      hostTokenHash: true,
    },
  });
  if (!row) throw new AppError("NOT_FOUND", "预约不存在或已被移除", 404);
  if (
    !token ||
    !/^[a-f0-9]{64}$/.test(token) ||
    row.hostTokenHash !== createHash("sha256").update(token).digest("hex")
  ) {
    throw new AppError(
      "FORBIDDEN",
      "只有原发起人可以再开一局，请使用创建时的浏览器。",
      403,
    );
  }
  return {
    visibility: row.visibility as "PUBLIC" | "INVITE",
    gameName: row.gameName,
    hostName: row.hostName,
    maxPlayers: row.maxPlayers,
    description: row.description,
  };
}
