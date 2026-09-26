import {
  attendanceOpensAt,
  attendanceSchema,
  completionSchema,
} from "../lib/reservation-attendance";
import { requireReservationAccess, identityHash } from "./reservation-access";
import { mutate, detail } from "./reservations";
import { AppError } from "./errors";
import { recordAdminAction, type AuditActor } from "./admin-audit";

export async function setAttendance(id: string, input: unknown, token: string) {
  const data = attendanceSchema.parse(input);
  await mutate(id, async (tx, r) => {
    await requireReservationAccess(tx, r, token);
    if (r.status === "CANCELLED" || r.status === "ENDED")
      throw new AppError(
        "ATTENDANCE_CLOSED",
        "预约已取消或已结束，不能修改到场确认",
        409,
      );
    const participant = r.participants.find(
      (p) => p.id === data.participantId && p.tokenHash === identityHash(token),
    );
    if (!participant)
      throw new AppError(
        "ROSTER_CHANGED",
        "只能操作本人当前正式报名，请刷新名单",
        409,
      );
    if (
      r.editVersion !== data.editVersion ||
      participant.attendanceVersion !== data.attendanceVersion
    )
      throw new AppError(
        "ATTENDANCE_CONFLICT",
        "预约或到场状态已变化，请刷新后确认",
        409,
      );
    const now = new Date();
    if (now < attendanceOpensAt(r.scheduledAt))
      throw new AppError("ATTENDANCE_EARLY", "开局前 30 分钟才可确认到场", 409);
    if (!!participant.checkedInAt === data.checkedIn) return;
    await tx.participant.update({
      where: { id: participant.id },
      data: {
        checkedInAt: data.checkedIn ? now : null,
        attendanceVersion: { increment: 1 },
      },
    });
  });
  return detail(id, token);
}

export async function setCompletion(
  id: string,
  input: unknown,
  token: string,
  ended: boolean,
  admin: AuditActor | null = null,
) {
  const { editVersion } = completionSchema.parse(input);
  await mutate(id, async (tx, r) => {
    await requireReservationAccess(tx, r, token, !!admin);
    if (
      !admin &&
      (!identityHash(token) || identityHash(token) !== r.hostTokenHash)
    )
      throw new AppError(
        "FORBIDDEN",
        "只有发起人或管理员可以结束或撤销结束",
        403,
      );
    if (r.editVersion !== editVersion)
      throw new AppError(
        "EDIT_CONFLICT",
        "预约状态已变化，请刷新后重新确认",
        409,
      );
    const now = new Date();
    if (
      r.status === "CANCELLED" ||
      (ended
        ? r.status === "ENDED" || r.scheduledAt > now
        : r.status !== "ENDED")
    )
      throw new AppError(
        "COMPLETION_STATE",
        ended ? "只能结束已开始且尚未结束的预约" : "只能撤销已结束的预约",
        409,
      );
    await tx.gameReservation.update({
      where: { id },
      data: {
        status: ended ? "ENDED" : "OPEN",
        endedAt: ended ? now : null,
        editVersion: { increment: 1 },
      },
    });
    await tx.reservationChange.create({
      data: {
        reservationId: id,
        action: ended ? "END" : "REOPEN",
        actorRole: admin ? "ADMIN" : "HOST",
        fields: "[]",
      },
    });
    if (admin)
      await recordAdminAction(
        tx,
        admin,
        ended ? "RESERVATION_END" : "RESERVATION_REOPEN",
        { id, label: r.gameName },
      );
  });
  return detail(id, token, !!admin);
}
