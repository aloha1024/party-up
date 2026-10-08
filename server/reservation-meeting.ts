import { meetingSchema, meetingFields } from "../lib/reservation-meeting";
import { mutate } from "./reservation-transaction";
import { detail } from "./reservation-detail";
import { identityHash, requireReservationAccess } from "./reservation-access";
import { encryptPrivate, decryptPrivate } from "./private-value";
import { recordAdminAction, type AuditActor } from "./admin-audit";
import { AppError } from "./errors";
import { recordNotifications, reservationRecipients } from "./notifications";

export async function setMeeting(
  id: string,
  input: unknown,
  token: string,
  admin: AuditActor | null = null,
) {
  const { version, ...fields } = meetingSchema.parse(input);
  await mutate(id, async (tx, r) => {
    await requireReservationAccess(tx, r, token, !!admin);
    if (
      !admin &&
      (!identityHash(token) || identityHash(token) !== r.hostTokenHash)
    )
      throw new AppError(
        "FORBIDDEN",
        "只有发起人或管理员可以修改集合信息",
        403,
      );
    if (["CANCELLED", "ENDED"].includes(r.status))
      throw new AppError(
        "MEETING_CLOSED",
        "预约已取消或结束，不能修改集合信息",
        409,
      );
    if (version !== r.meetingVersion)
      throw new AppError(
        "MEETING_CONFLICT",
        "集合信息已变化，请刷新后重新确认",
        409,
      );
    const previous = r.meetingCipher
      ? meetingFields.parse(
          JSON.parse(decryptPrivate(r.meetingCipher, "meeting")),
        )
      : { roomName: "", roomPassword: "", voice: "" };
    if (JSON.stringify(previous) === JSON.stringify(fields)) return;
    await tx.gameReservation.update({
      where: { id },
      data: {
        meetingCipher: Object.values(fields).some(Boolean)
          ? encryptPrivate(JSON.stringify(fields), "meeting")
          : null,
        meetingVersion: { increment: 1 },
      },
    });
    await recordNotifications(
      tx,
      id,
      "MEETING_UPDATED",
      `meeting:${id}:${r.meetingVersion + 1}`,
      reservationRecipients(r, identityHash(token), false),
    );
    if (admin)
      await recordAdminAction(tx, admin, "RESERVATION_MEETING", {
        id,
        label: r.gameName,
      });
  });
  return detail(id, token, !!admin);
}
