import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma } from "@prisma/client";
import { db } from "./db";
import { AppError } from "./errors";
import { measureTransaction, recordBusy, recordRetry } from "./request-metrics";
function busyError() {
  recordBusy();
  return new AppError("BUSY", "服务繁忙，请稍后确认操作结果", 503, 2);
}
const deadlines = new AsyncLocalStorage<number>();
export const withRequestBudget = <T>(run: () => Promise<T>) =>
  deadlines.run(performance.now() + 10000, run);
export function remainingBudget() {
  return Math.max(
    0,
    (deadlines.getStore() ?? performance.now() + 8000) - performance.now(),
  );
}
export async function writeTransaction<T>(
  run: (tx: Prisma.TransactionClient) => Promise<T>,
  retryUnique = false,
): Promise<T> {
  const deadline = Math.min(
    performance.now() + 8000,
    performance.now() + remainingBudget(),
  );
  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - performance.now();
    if (remaining < 200) throw busyError();
    try {
      return await measureTransaction(() =>
        db.$transaction(run, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: Math.max(1, Math.floor(Math.min(1000, remaining / 4))),
          timeout: Math.max(1, Math.floor(Math.min(3000, remaining * 0.7))),
        }),
      );
    } catch (error) {
      const retryable =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (["P2034", "P1008", "P2028"].includes(error.code) ||
          (retryUnique && error.code === "P2002"));
      if (!retryable) throw error;
      if (attempt >= 2 || deadline - performance.now() < 300) throw busyError();
      recordRetry();
      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
}
