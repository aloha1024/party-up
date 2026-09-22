import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "./db";
import { recordAdminAction, type AuditActor } from "./admin-audit";
import {
  createSchema,
  creationInputSchema,
  editSchema,
  joinSchema,
} from "../lib/validation";
import { getStatus } from "../lib/status";
import { AppError } from "./errors";
export { AppError } from "./errors";
import { writeTransaction } from "./request-budget";
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
    editVersion: r.editVersion,
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
export async function createReservation(
  input: unknown,
  token: string,
  key: string = randomUUID(),
) {
  const data = creationInputSchema.parse(input);
  const ownerTokenHash = hashToken(token);
  const inputHash = hashToken(JSON.stringify(data));
  const proposedId = randomUUID();
  const r = await writeTransaction(async (tx) => {
    // First acquire a write lock; this also serializes retries of the same submission.
    const submission = await tx.creationRequest.upsert({
      where: { ownerTokenHash_key: { ownerTokenHash, key } },
      create: { ownerTokenHash, key, inputHash, reservationId: proposedId },
      update: { key },
    });
    if (submission.inputHash !== inputHash)
      throw new AppError(
        "SUBMISSION_CHANGED",
        "该提交编号已用于其他内容，请核对上次预约后重新创建",
        409,
      );
    const previous = await tx.gameReservation.findUnique({
      where: { id: submission.reservationId },
      include,
    });
    if (previous) {
      if (previous.deletedAt)
        throw new AppError(
          "REMOVED",
          "上次创建的预约已被移除，请核对后重新创建",
          409,
        );
      return previous;
    }
    if (submission.reservationId !== proposedId)
      throw new AppError(
        "REMOVED",
        "上次创建的预约已被永久删除，请核对后重新创建",
        409,
      );
    createSchema.parse(data);
    return tx.gameReservation.create({
      data: {
        ...data,
        id: proposedId,
        hostTokenHash: ownerTokenHash,
        scheduledAt: new Date(data.scheduledAt),
        participants: {
          create: {
            name: data.hostName,
            nameKey: data.hostName.toLowerCase(),
            tokenHash: ownerTokenHash,
          },
        },
      },
      include,
    });
  }, true);
  return serialize(r, token);
}
// The first operation is a write: SQLite acquires its writer lock; PostgreSQL locks
// this reservation row. Every roster mutation uses this same lock, before reads.
async function mutate(
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
export async function deleteReservation(id: string, actor: AuditActor) {
  await mutate(id, async (tx, r) => {
    await tx.gameReservation.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    await recordAdminAction(tx, actor, "RESERVATION_TRASH", {
      id,
      label: r.gameName,
    });
  });
}
export async function editReservation(
  id: string,
  input: unknown,
  token: string,
  // Set only by the server after verifying the administrator session.
  administrator: AuditActor | null = null,
) {
  const { editVersion, ...data } = editSchema.parse(input);
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
    // Compare the version while holding the same lock used by roster mutations.
    // Failed edits roll back the lock revision, nickname change and audit write.
    if (r.editVersion !== editVersion)
      throw new AppError(
        "EDIT_CONFLICT",
        "预约已被其他人修改。当前输入已保留，请查看最新信息后重新编辑。",
        409,
      );
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
      data: {
        ...data,
        scheduledAt: new Date(data.scheduledAt),
        editVersion: { increment: 1 },
      },
    });
    if (administrator)
      await recordAdminAction(tx, administrator, "RESERVATION_EDIT", {
        id,
        label: data.gameName,
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
  administrator: AuditActor | null = null,
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
    if (administrator)
      await recordAdminAction(tx, administrator, "RESERVATION_CANCEL", {
        id,
        label: r.gameName,
      });
  });
  return detail(id, token);
}
// Administrative mutations must be called only after requireAdmin().
export async function restoreReservation(id: string, actor: AuditActor) {
  await mutate(
    id,
    async (tx, r) => {
      if (!r.deletedAt)
        throw new AppError("NOT_DELETED", "预约不在回收站中", 409);
      await tx.gameReservation.update({
        where: { id },
        data: { deletedAt: null },
      });
      await recordAdminAction(tx, actor, "RESERVATION_RESTORE", {
        id,
        label: r.gameName,
      });
    },
    true,
  );
}
export async function purgeReservation(id: string, actor: AuditActor) {
  await mutate(
    id,
    async (tx, r) => {
      if (!r.deletedAt)
        throw new AppError("NOT_DELETED", "请先将预约移入回收站", 409);
      await tx.gameReservation.delete({ where: { id } });
      await recordAdminAction(tx, actor, "RESERVATION_PURGE", {
        id,
        label: r.gameName,
      });
    },
    true,
  );
}
