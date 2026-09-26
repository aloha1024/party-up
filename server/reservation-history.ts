import { requireReservationAccess } from "./reservation-access";
import type { GameReservation, Prisma } from "@prisma/client";
import {
  changeFields,
  historyItemSchema,
  type HistoryPage,
} from "../lib/reservation-history";
import { db } from "./db";
import { AppError } from "./errors";
import { remainingBudget } from "./request-budget";
import { measureTransaction } from "./request-metrics";

type Editable = Pick<
  GameReservation,
  "gameName" | "hostName" | "description" | "maxPlayers"
> & { scheduledAt: string };

export async function recordReservationEdit(
  tx: Prisma.TransactionClient,
  before: GameReservation,
  after: Editable,
  admin: boolean,
) {
  const fields = changeFields.filter((field) =>
    field === "scheduledAt"
      ? before.scheduledAt.getTime() !== new Date(after.scheduledAt).getTime()
      : before[field] !== after[field],
  );
  if (!fields.length) return;
  await tx.reservationChange.create({
    data: {
      reservationId: before.id,
      action: "EDIT",
      actorRole: admin ? "ADMIN" : "HOST",
      fields: JSON.stringify(fields),
      ...(fields.includes("scheduledAt")
        ? {
            scheduledAtBefore: before.scheduledAt,
            scheduledAtAfter: new Date(after.scheduledAt),
          }
        : {}),
      ...(fields.includes("maxPlayers")
        ? {
            maxPlayersBefore: before.maxPlayers,
            maxPlayersAfter: after.maxPlayers,
          }
        : {}),
    },
  });
}

export function historyCursor(params: URLSearchParams): number | undefined {
  const values = params.getAll("before");
  if (!values.length) return undefined;
  const value = Number(values[0]);
  if (
    values.length !== 1 ||
    !/^[1-9]\d*$/.test(values[0]) ||
    !Number.isSafeInteger(value) ||
    value > 2147483647
  )
    throw new AppError("VALIDATION", "记录游标必须是单个正整数", 400);
  return value;
}

export async function reservationHistory(
  id: string,
  before?: number,
  token?: string,
  admin = false,
): Promise<HistoryPage> {
  const budget = Math.floor(remainingBudget());
  if (budget < 2) throw new AppError("BUSY", "服务繁忙，请稍后重试", 503);
  return measureTransaction(() =>
    db.$transaction(
      async (tx) => {
        const reservation = await tx.gameReservation.findUnique({
          where: { id, deletedAt: null },
        });
        if (!reservation)
          throw new AppError("NOT_FOUND", "预约不存在或已被移除", 404);
        await requireReservationAccess(tx, reservation, token, admin);
        const rows = await tx.reservationChange.findMany({
          where: {
            reservationId: id,
            ...(before === undefined ? {} : { id: { lt: before } }),
          },
          orderBy: { id: "desc" },
          take: 11,
        });
        const items = rows.slice(0, 10).map((row) =>
          historyItemSchema.parse({
            id: row.id,
            action: row.action,
            actorRole: row.actorRole,
            fields: JSON.parse(row.fields),
            scheduledAtBefore: row.scheduledAtBefore?.toISOString() ?? null,
            scheduledAtAfter: row.scheduledAtAfter?.toISOString() ?? null,
            maxPlayersBefore: row.maxPlayersBefore,
            maxPlayersAfter: row.maxPlayersAfter,
            createdAt: row.createdAt.toISOString(),
          }),
        );
        return {
          items,
          nextBefore: rows.length > 10 ? items.at(-1)!.id : null,
        };
      },
      {
        maxWait: Math.max(1, Math.min(1000, Math.floor(budget / 4))),
        timeout: Math.max(1, Math.min(3000, Math.floor(budget * 0.7))),
      },
    ),
  );
}
