import { requireReservationAccess } from "./reservation-access";
import { db } from "./db";
import { AppError } from "./errors";
import { hashToken } from "./reservations";
import type { CalendarReservation } from "../lib/reservation-calendar";

export async function calendarReservation(
  id: string,
  token?: string,
): Promise<CalendarReservation> {
  const access = await db.gameReservation.findUnique({ where: { id } });
  if (!access) throw new AppError("NOT_FOUND", "预约不存在", 404);
  await requireReservationAccess(db, access, token);
  if (!token || !/^[a-f0-9]{64}$/.test(token))
    throw new AppError(
      "IDENTITY_REQUIRED",
      "请使用正式报名时的浏览器添加日历",
      428,
    );
  // One fresh read checks membership and selects only calendar fields. A host
  // who left or an administrator receives no special export permission.
  const r = await db.gameReservation.findUnique({
    where: { id, deletedAt: null },
    select: {
      id: true,
      gameName: true,
      hostName: true,
      description: true,
      scheduledAt: true,
      updatedAt: true,
      editVersion: true,
      status: true,
      participants: {
        where: { tokenHash: hashToken(token) },
        select: { id: true },
        take: 1,
      },
    },
  });
  if (!r) throw new AppError("NOT_FOUND", "预约不存在或已被移除", 404);
  if (!r.participants.length)
    throw new AppError(
      "FORBIDDEN",
      "仅正式参与者可添加日历，候补递补成功后可使用",
      403,
    );
  if (r.status === "ENDED")
    throw new AppError("ENDED", "预约已结束，不能添加日历", 409);
  if (r.status === "CANCELLED")
    throw new AppError("CANCELLED", "预约已取消，不能添加日历", 409);
  if (r.scheduledAt <= new Date())
    throw new AppError("STARTED", "预约已开始，不能添加日历", 409);
  return {
    id: r.id,
    gameName: r.gameName,
    hostName: r.hostName,
    description: r.description,
    scheduledAt: r.scheduledAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    editVersion: r.editVersion,
  };
}
