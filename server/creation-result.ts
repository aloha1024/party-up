import { db } from "./db";
import { hashToken } from "./reservations";
import { AppError } from "./errors";
import { creationKeySchema } from "../lib/creation-result";

// The submission key is scoped to the browser's identity, never a public lookup token.
export async function lookupCreation(token: string, input: unknown) {
  if (!token)
    throw new AppError(
      "IDENTITY_REQUIRED",
      "报名身份已丢失，请使用原浏览器及其 Cookie 查看上次创建结果",
      428,
    );
  const key = creationKeySchema.parse(input);
  const ownerTokenHash = hashToken(token);
  const submission = await db.creationRequest.findUnique({
    where: { ownerTokenHash_key: { ownerTokenHash, key } },
  });
  if (!submission) return { state: "missing" as const };
  const reservation = await db.gameReservation.findFirst({
    where: {
      id: submission.reservationId,
      hostTokenHash: ownerTokenHash,
      deletedAt: null,
    },
    select: { id: true, gameName: true, scheduledAt: true },
  });
  if (!reservation) return { state: "removed" as const };
  return {
    state: "found" as const,
    reservation: {
      ...reservation,
      scheduledAt: reservation.scheduledAt.toISOString(),
    },
  };
}
