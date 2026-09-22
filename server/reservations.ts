import { createHash } from "node:crypto";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "./db";
import { createSchema, joinSchema } from "../lib/validation";
import { getStatus } from "../lib/status";
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const include = {
  participants: {
    orderBy: [{ joinedAt: "asc" as const }, { id: "asc" as const }],
  },
};
type Row = Prisma.GameReservationGetPayload<{ include: typeof include }>;
function serialize(r: Row, token?: string) {
  return {
    id: r.id,
    gameName: r.gameName,
    hostName: r.hostName,
    isHost: !!token && r.hostTokenHash === hashToken(token),
    scheduledAt: r.scheduledAt.toISOString(),
    maxPlayers: r.maxPlayers,
    description: r.description,
    status: getStatus(r, r.participants.length),
    cancellationReason: r.cancellationReason,
    participants: r.participants.map((p) => ({
      id: p.id,
      name: p.name,
      joinedAt: p.joinedAt.toISOString(),
      isMe: !!token && p.tokenHash === hashToken(token),
    })),
  };
}
export async function detail(id: string, token?: string) {
  const r = await db.gameReservation.findUnique({ where: { id }, include });
  if (!r || r.deletedAt)
    throw new AppError("NOT_FOUND", "预约不存在或已被移除", 404);
  return serialize(r, token);
}
export async function createReservation(input: unknown, token: string) {
  const data = createSchema.parse(input);
  const r = await db.gameReservation.create({
    data: {
      ...data,
      hostTokenHash: hashToken(token),
      scheduledAt: new Date(data.scheduledAt),
      participants: {
        create: {
          name: data.hostName,
          nameKey: data.hostName.toLowerCase(),
          tokenHash: hashToken(token),
        },
      },
    },
    include,
  });
  return serialize(r, token);
}
// The first operation is a write: SQLite acquires its writer lock; PostgreSQL locks
// this reservation row. Every roster mutation uses this same lock, before reads.
async function mutate(
  id: string,
  operation: (tx: Prisma.TransactionClient, r: Row) => Promise<void>,
  includeDeleted = false,
) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await db.$transaction(
        async (tx) => {
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
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10000,
          timeout: 15000,
        },
      );
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        ["P2034", "P1008", "P2028"].includes(e.code) &&
        attempt < 3
      ) {
        await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
        continue;
      }
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002"
      )
        throw new AppError("DUPLICATE", "该昵称已被使用，或你已经报名", 409);
      throw e;
    }
  }
}
function checkActive(r: Row) {
  const state = getStatus(r, r.participants.length);
  if (state === "CANCELLED") throw new AppError("CANCELLED", "预约已取消", 409);
  if (state === "STARTED")
    throw new AppError("STARTED", "游戏已开始，不能修改报名", 409);
}
export async function joinReservation(
  id: string,
  input: unknown,
  token: string,
) {
  const { name } = joinSchema.parse(input);
  await mutate(id, async (tx, r) => {
    checkActive(r);
    if (r.participants.length >= r.maxPlayers)
      throw new AppError("FULL", "人数已满，下次早点来！", 409);
    if (
      r.participants.some(
        (p) =>
          p.nameKey === name.toLowerCase() || p.tokenHash === hashToken(token),
      )
    )
      throw new AppError("DUPLICATE", "该昵称已被使用，或你已经报名", 409);
    await tx.participant.create({
      data: {
        reservationId: id,
        name,
        nameKey: name.toLowerCase(),
        tokenHash: hashToken(token),
      },
    });
  });
  return detail(id, token);
}
export async function leaveReservation(id: string, token: string) {
  await mutate(id, async (tx, r) => {
    checkActive(r);
    const deleted = await tx.participant.deleteMany({
      where: { reservationId: id, tokenHash: hashToken(token) },
    });
    if (!deleted.count)
      throw new AppError("FORBIDDEN", "只能退出本浏览器自己的报名", 403);
  });
  return detail(id, token);
}
// Caller must enforce administrator authorization. The roster shares this lock.
export async function deleteReservation(id: string) {
  await mutate(id, async (tx) => {
    await tx.gameReservation.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  });
}
export async function editReservation(
  id: string,
  input: unknown,
  token: string,
  // Set only by the server after verifying the administrator session.
  administrator = false,
) {
  const data = createSchema.parse(input);
  await mutate(id, async (tx, r) => {
    if (
      !administrator &&
      (!r.hostTokenHash || r.hostTokenHash !== hashToken(token))
    )
      throw new AppError(
        "FORBIDDEN",
        "只有发起人或已登录的管理员可以修改预约",
        403,
      );
    checkActive(r);
    // Revalidate time after acquiring the lock, in case this request waited.
    createSchema.parse(data);
    if (data.maxPlayers < r.participants.length)
      throw new AppError("CAPACITY", "人数上限不能小于当前报名人数", 409);
    const host = r.participants.find((p) => p.tokenHash === r.hostTokenHash);
    if (host && data.hostName !== host.name) {
      await tx.participant.update({
        where: { id: host.id },
        data: { name: data.hostName, nameKey: data.hostName.toLowerCase() },
      });
    }
    await tx.gameReservation.update({
      where: { id },
      data: { ...data, scheduledAt: new Date(data.scheduledAt) },
    });
  });
  return detail(id, token);
}

const cancellationSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(1, "请填写取消原因")
      .max(300, "取消原因最多 300 字"),
  })
  .strict();
export async function cancelReservation(
  id: string,
  input: unknown,
  token: string,
  administrator = false,
) {
  const { reason } = cancellationSchema.parse(input);
  await mutate(id, async (tx, r) => {
    if (
      !administrator &&
      (!r.hostTokenHash || r.hostTokenHash !== hashToken(token))
    )
      throw new AppError("FORBIDDEN", "只有发起人或管理员可以取消预约", 403);
    checkActive(r);
    await tx.gameReservation.update({
      where: { id },
      data: { status: "CANCELLED", cancellationReason: reason },
    });
  });
  return detail(id, token);
}
// These three administrative operations must be called only after requireAdmin().
export async function listDeletedReservations() {
  const rows = await db.gameReservation.findMany({
    where: { deletedAt: { not: null } },
    select: {
      id: true,
      gameName: true,
      hostName: true,
      deletedAt: true,
      _count: { select: { participants: true } },
    },
    orderBy: [{ deletedAt: "desc" }, { id: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    gameName: r.gameName,
    hostName: r.hostName,
    deletedAt: r.deletedAt!.toISOString(),
    participantCount: r._count.participants,
  }));
}
export async function restoreReservation(id: string) {
  await mutate(
    id,
    async (tx, r) => {
      if (!r.deletedAt)
        throw new AppError("NOT_DELETED", "预约不在回收站中", 409);
      await tx.gameReservation.update({
        where: { id },
        data: { deletedAt: null },
      });
    },
    true,
  );
}
export async function purgeReservation(id: string) {
  await mutate(
    id,
    async (tx, r) => {
      if (!r.deletedAt)
        throw new AppError("NOT_DELETED", "请先将预约移入回收站", 409);
      await tx.gameReservation.delete({ where: { id } });
    },
    true,
  );
}
