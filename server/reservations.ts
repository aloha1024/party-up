import { requireReservationAccess, rememberMember } from "./reservation-access";
import { newInvitation } from "./invitation-credential";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "./db";
import { recordReservationEdit } from "./reservation-history";
import {
  renameSchema,
  removalSchema,
  type RosterKind,
} from "../lib/roster-management";
import { recordAdminAction, type AuditActor } from "./admin-audit";
import {
  creationFingerprint,
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
  waitlist: { orderBy: { id: "asc" as const } },
  participants: {
    orderBy: [{ joinedAt: "asc" as const }, { id: "asc" as const }],
  },
};
type Row = Prisma.GameReservationGetPayload<{ include: typeof include }>;
function serialize(r: Row, token?: string) {
  return {
    id: r.id,
    visibility: r.visibility as "PUBLIC" | "INVITE",
    editVersion: r.editVersion,
    endedAt: r.endedAt?.toISOString() ?? null,
    gameName: r.gameName,
    hostName: r.hostName,
    isHost: !!token && r.hostTokenHash === hashToken(token),
    scheduledAt: r.scheduledAt.toISOString(),
    maxPlayers: r.maxPlayers,
    description: r.description,
    status: getStatus(r, r.participants.length),
    cancellationReason: r.cancellationReason,
    waitlist: r.waitlist.map((p) => ({
      isHost: p.tokenHash === r.hostTokenHash,
      id: p.id,
      name: p.name,
      joinedAt: p.joinedAt.toISOString(),
      isMe: !!token && p.tokenHash === hashToken(token),
    })),
    participants: r.participants.map((p) => ({
      checkedInAt: p.checkedInAt?.toISOString() ?? null,
      attendanceVersion: p.attendanceVersion,
      isHost: p.tokenHash === r.hostTokenHash,
      id: p.id,
      name: p.name,
      joinedAt: p.joinedAt.toISOString(),
      isMe: !!token && p.tokenHash === hashToken(token),
    })),
  };
}
export async function detail(id: string, token?: string, admin = false) {
  return db.$transaction(async (tx) => {
    const r = await tx.gameReservation.findUnique({ where: { id }, include });
    if (!r || r.deletedAt)
      throw new AppError("NOT_FOUND", "预约不存在或已被移除", 404);
    await requireReservationAccess(tx, r, token, admin);
    return serialize(r, token);
  });
}
export async function createReservation(
  input: unknown,
  token: string,
  key: string = randomUUID(),
) {
  const data = creationInputSchema.parse(input);
  const ownerTokenHash = hashToken(token);
  const inputHash = hashToken(creationFingerprint(data));
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
        ...(data.visibility === "INVITE" ? newInvitation() : {}),
        id: proposedId,
        hostTokenHash: ownerTokenHash,
        ...(data.visibility === "INVITE"
          ? {
              access: {
                create: {
                  tokenHash: ownerTokenHash,
                  inviteVersion: 1,
                  hasJoined: true,
                },
              },
            }
          : {}),
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

function checkActive(r: Row) {
  const state = getStatus(r, r.participants.length);
  if (state === "CANCELLED") throw new AppError("CANCELLED", "预约已取消", 409);
  if (state === "ENDED")
    throw new AppError("ENDED", "预约已结束，不能修改报名", 409);
  if (state === "STARTED")
    throw new AppError("STARTED", "游戏已开始，不能修改报名", 409);
}
// Called only after mutate acquires the reservation write lock. Re-read the
// roster after edits/removals; any later failure rolls these promotions back.
async function promoteWaitlist(tx: Prisma.TransactionClient, id: string) {
  const r = await tx.gameReservation.findUniqueOrThrow({
    where: { id },
    include: { _count: { select: { participants: true } } },
  });
  if (
    r.deletedAt ||
    ["CANCELLED", "ENDED"].includes(r.status) ||
    r.scheduledAt <= new Date()
  )
    return;
  const vacancies = r.maxPlayers - r._count.participants;
  if (vacancies <= 0) return;
  const entries = await tx.waitlistEntry.findMany({
    where: { reservationId: id },
    orderBy: { id: "asc" },
    take: vacancies,
  });
  for (const entry of entries) {
    await tx.participant.create({
      data: {
        reservationId: id,
        name: entry.name,
        nameKey: entry.nameKey,
        tokenHash: entry.tokenHash,
        joinedAt: new Date(),
      },
    });
    await tx.waitlistEntry.delete({ where: { id: entry.id } });
  }
}
function checkDuplicate(r: Row, name: string, token: string) {
  if (
    [...r.participants, ...r.waitlist].some(
      (p) =>
        p.nameKey === name.toLowerCase() || p.tokenHash === hashToken(token),
    )
  )
    throw new AppError(
      "DUPLICATE",
      "该昵称已被使用，或你已报名或加入候补",
      409,
    );
}
export async function joinWaitlist(id: string, input: unknown, token: string) {
  const { name } = joinSchema.strict().parse(input);
  await mutate(id, async (tx, r) => {
    await requireReservationAccess(tx, r, token, false, true);
    checkActive(r);
    await rememberMember(tx, r, token);
    checkDuplicate(r, name, token);
    if (r.participants.length < r.maxPlayers)
      throw new AppError("AVAILABLE", "已有空位，请刷新后直接报名", 409);
    if (r.waitlist.length >= 100)
      throw new AppError("WAITLIST_FULL", "候补已满（最多 100 人）", 409);
    await tx.waitlistEntry.create({
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
export async function leaveWaitlist(id: string, token: string) {
  await mutate(id, async (tx, r) => {
    await requireReservationAccess(tx, r, token, false, false);
    if (r.participants.some((p) => p.tokenHash === hashToken(token)))
      throw new AppError("PROMOTED", "已转为正式报名，请刷新后退出接龙", 409);
    const deleted = await tx.waitlistEntry.deleteMany({
      where: { reservationId: id, tokenHash: hashToken(token) },
    });
    if (!deleted.count)
      throw new AppError("FORBIDDEN", "只能退出本浏览器自己的候补", 403);
  });
  return detail(id, token);
}
export async function joinReservation(
  id: string,
  input: unknown,
  token: string,
) {
  const { name } = joinSchema.parse(input);
  await mutate(id, async (tx, r) => {
    await requireReservationAccess(tx, r, token, false, true);
    checkActive(r);
    await rememberMember(tx, r, token);
    await promoteWaitlist(tx, id);
    if (
      (await tx.participant.count({ where: { reservationId: id } })) >=
      r.maxPlayers
    )
      throw new AppError("FULL", "人数已满，下次早点来！", 409);
    checkDuplicate(r, name, token);
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
    await requireReservationAccess(tx, r, token, false, false);
    checkActive(r);
    const deleted = await tx.participant.deleteMany({
      where: { reservationId: id, tokenHash: hashToken(token) },
    });
    if (!deleted.count)
      throw new AppError("FORBIDDEN", "只能退出本浏览器自己的报名", 403);
    await promoteWaitlist(tx, id);
  });
  return detail(id, token);
}
const rosterConflict = () =>
  new AppError("ROSTER_CHANGED", "名单已变化，请刷新后重新确认", 409);

export async function renameRosterEntry(
  id: string,
  kind: RosterKind,
  input: unknown,
  token: string,
) {
  const data = renameSchema.parse(input);
  await mutate(id, async (tx, r) => {
    await requireReservationAccess(tx, r, token, false, false);
    checkActive(r);
    const hash = hashToken(token);
    const row = r[kind].find(
      (p) => String(p.id) === data.entryId && p.tokenHash === hash,
    );
    if (!row) throw rosterConflict();
    if (row.name === data.name) return;
    if (row.name !== data.expectedName) throw rosterConflict();
    if (
      [...r.participants, ...r.waitlist].some(
        (p) => p.tokenHash !== hash && p.nameKey === data.name.toLowerCase(),
      )
    )
      throw new AppError("DUPLICATE", "该昵称已被正式参与者或候补使用", 409);
    const update = { name: data.name, nameKey: data.name.toLowerCase() };
    if (kind === "participants")
      await tx.participant.update({
        where: { id: data.entryId },
        data: update,
      });
    else
      await tx.waitlistEntry.update({
        where: { id: Number(data.entryId) },
        data: update,
      });
    if (hash === r.hostTokenHash && r.hostName !== data.name) {
      await tx.gameReservation.update({
        where: { id },
        data: { hostName: data.name, editVersion: { increment: 1 } },
      });
      await recordReservationEdit(
        tx,
        r,
        { ...r, scheduledAt: r.scheduledAt.toISOString(), hostName: data.name },
        false,
      );
    }
  });
  return detail(id, token);
}

// Administrative authorization must be verified by currentAdmin at the route.
export async function removeRosterEntry(
  id: string,
  input: unknown,
  token: string,
  administrator: AuditActor | null = null,
) {
  const data = removalSchema.parse(input);
  await mutate(id, async (tx, r) => {
    const hash = hashToken(token);
    if (!administrator && (!r.hostTokenHash || r.hostTokenHash !== hash))
      throw new AppError("FORBIDDEN", "只有发起人或管理员可以移除报名", 403);
    checkActive(r);
    const prior = await tx.rosterRemoval.findUnique({
      where: {
        reservationId_kind_entryId: {
          reservationId: id,
          kind: data.kind,
          entryId: data.entryId,
        },
      },
    });
    if (prior) return;
    const row = r[data.kind].find((p) => String(p.id) === data.entryId);
    if (!row || row.name !== data.expectedName) throw rosterConflict();
    if (row.tokenHash === r.hostTokenHash || row.tokenHash === hash)
      throw new AppError(
        "FORBIDDEN",
        "不能移除发起人或自己，本人请使用退出入口",
        403,
      );
    if (data.kind === "participants")
      await tx.participant.delete({ where: { id: data.entryId } });
    else await tx.waitlistEntry.delete({ where: { id: Number(data.entryId) } });
    if (data.kind === "participants") await promoteWaitlist(tx, id);
    await tx.rosterRemoval.create({
      data: {
        reservationId: id,
        kind: data.kind,
        entryId: data.entryId,
        targetTokenHash: row.tokenHash,
        targetName: row.name,
        reason: data.reason,
        actorRole: administrator ? "ADMIN" : "HOST",
      },
    });
    if (administrator)
      await recordAdminAction(tx, administrator, "RESERVATION_ROSTER_REMOVE", {
        id,
        label: r.gameName,
      });
  });
  return detail(id, token, !!administrator);
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
  const {
    editVersion,
    visibility: _visibility,
    ...data
  } = editSchema.parse(input);
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
    const waitingHost = r.waitlist.find((p) => p.tokenHash === r.hostTokenHash);
    if (
      (host || waitingHost || data.hostName !== r.hostName) &&
      [...r.participants, ...r.waitlist].some(
        (p) =>
          p.tokenHash !== r.hostTokenHash &&
          p.nameKey === data.hostName.toLowerCase(),
      )
    )
      throw new AppError(
        "DUPLICATE",
        "该昵称已被使用，或你已报名或加入候补",
        409,
      );
    if (host && data.hostName !== host.name) {
      await tx.participant.update({
        where: { id: host.id },
        data: { name: data.hostName, nameKey: data.hostName.toLowerCase() },
      });
    }
    if (waitingHost && data.hostName !== waitingHost.name) {
      await tx.waitlistEntry.update({
        where: { id: waitingHost.id },
        data: { name: data.hostName, nameKey: data.hostName.toLowerCase() },
      });
    }
    if (r.scheduledAt.getTime() !== new Date(data.scheduledAt).getTime()) {
      await tx.participant.updateMany({
        where: { reservationId: id, checkedInAt: { not: null } },
        data: { checkedInAt: null, attendanceVersion: { increment: 1 } },
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
    await promoteWaitlist(tx, id);
    if (administrator)
      await recordAdminAction(tx, administrator, "RESERVATION_EDIT", {
        id,
        label: data.gameName,
      });
    await recordReservationEdit(tx, r, data, administrator !== null);
  });
  return detail(id, token, !!administrator);
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
    await tx.reservationChange.create({
      data: {
        reservationId: id,
        action: "CANCEL",
        actorRole: administrator ? "ADMIN" : "HOST",
        fields: "[]",
      },
    });
  });
  return detail(id, token, !!administrator);
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
      await promoteWaitlist(tx, id);
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
