import { Prisma } from "@prisma/client";
import { db } from "./db";
import { AppError } from "./errors";
import { requireReservationAccess } from "./reservation-access";
import { readReservationHistory } from "./reservation-history";
import { readRosterRemovals, type ViewerAdmin } from "./roster-removals";
import { remainingBudget } from "./request-budget";
import { measureTransaction } from "./request-metrics";
import {
  reservationInclude as include,
  serializeReservation as serialize,
} from "./reservation-record";

export async function detail(id: string, token?: string, admin = false) {
  return db.$transaction(async (tx) => {
    const r = await tx.gameReservation.findUnique({ where: { id }, include });
    if (!r || r.deletedAt)
      throw new AppError("NOT_FOUND", "预约不存在或已被移除", 404);
    await requireReservationAccess(tx, r, token, admin);
    return serialize(r, token, admin);
  });
}

// The page's detail and first history pages share one authorized read snapshot.
// Independent APIs and write transactions continue to authorize every request.
export async function reservationPageData(
  id: string,
  token?: string,
  admin: ViewerAdmin = null,
) {
  const budget = Math.floor(remainingBudget());
  if (budget < 2) throw new AppError("BUSY", "服务繁忙，请稍后重试", 503);
  return measureTransaction(() =>
    db.$transaction(
      async (tx) => {
        const r = await tx.gameReservation.findUnique({
          where: { id },
          include,
        });
        if (!r || r.deletedAt)
          throw new AppError("NOT_FOUND", "预约不存在或已被移除", 404);
        await requireReservationAccess(tx, r, token, !!admin);
        const reservation = serialize(r, token, !!admin);
        const history = await readReservationHistory(tx, id);
        const removals = await readRosterRemovals(tx, r, token, admin);
        return { reservation, history, removals };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: Math.max(1, Math.min(1000, Math.floor(budget / 4))),
        timeout: Math.max(1, Math.min(3000, Math.floor(budget * 0.7))),
      },
    ),
  );
}
