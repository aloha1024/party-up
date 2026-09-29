import { Prisma } from "@prisma/client";
import { AppError } from "./errors";
import { writeTransaction } from "./request-budget";
import {
  reservationInclude as include,
  type ReservationRow as Row,
} from "./reservation-record";

// The first operation is a write: SQLite acquires its writer lock; PostgreSQL locks
// this reservation row. Every roster mutation uses this same lock, before reads.
export async function mutate(
  id: string,
  operation: (tx: Prisma.TransactionClient, r: Row) => Promise<void>,
  includeDeleted = false,
) {
  try {
    return await writeTransaction(async (tx) => {
      const locked = await tx.gameReservation.updateMany({
        where: { id, ...(includeDeleted ? {} : { deletedAt: null }) },
        data: { revision: { increment: 1 } },
      });
      if (!locked.count) throw new AppError("NOT_FOUND", "预约不存在", 404);
      const r = (await tx.gameReservation.findUnique({
        where: { id },
        include,
      }))!;
      await operation(tx, r);
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
      throw new AppError("DUPLICATE", "该昵称已被使用，或你已经报名", 409);
    throw e;
  }
}
