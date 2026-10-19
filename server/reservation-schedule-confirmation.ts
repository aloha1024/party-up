import { scheduleConfirmationSchema } from "../lib/reservation-schedule-confirmation";
import { identityHash, requireReservationAccess } from "./reservation-access";
import { detail } from "./reservation-detail";
import { mutate } from "./reservation-transaction";
import { AppError } from "./errors";

export async function setScheduleConfirmation(
  id: string,
  input: unknown,
  token: string,
) {
  const data = scheduleConfirmationSchema.parse(input);
  await mutate(id, async (tx, r) => {
    await requireReservationAccess(tx, r, token);
    const participant = r.participants.find(
      (p) => p.id === data.participantId && p.tokenHash === identityHash(token),
    );
    if (!participant)
      throw new AppError(
        "ROSTER_CHANGED",
        "只能确认本人当前正式报名，请刷新名单",
        409,
      );
    if (r.scheduleVersion !== data.scheduleVersion)
      throw new AppError(
        "SCHEDULE_CONFLICT",
        "开玩时间已变化，请刷新后重新确认",
        409,
      );
    const now = new Date();
    if (
      r.status === "CANCELLED" ||
      r.status === "ENDED" ||
      r.scheduledAt <= now
    )
      throw new AppError(
        "SCHEDULE_CLOSED",
        "预约已开始、取消或结束，不能确认参加时间",
        409,
      );
    if (participant.acceptedScheduleVersion === r.scheduleVersion) return;
    await tx.participant.update({
      where: { id: participant.id },
      data: {
        acceptedScheduleVersion: r.scheduleVersion,
        scheduleConfirmedAt: now,
      },
    });
  });
  return detail(id, token);
}
