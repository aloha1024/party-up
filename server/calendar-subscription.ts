import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "./db";
import { AppError } from "./errors";
import { lockUser, requireUser } from "./user-accounts";
import {
  digest,
  memberToken,
  viewerContext,
  type Viewer,
} from "./user-identity";
import { remainingBudget, writeTransaction } from "./request-budget";
import { measureTransaction } from "./request-metrics";
import {
  calendarRotationSchema,
  calendarRevocationSchema,
} from "../lib/calendar-subscription";

export async function calendarSettings(viewer: Viewer) {
  const user = requireUser(viewer);
  return measureTransaction(() =>
    db.$transaction(
      async (tx) => {
        const session = await tx.userSession.findFirst({
          where: {
            id: viewer.sessionHash,
            userId: user.id,
            version: viewer.version,
            expiresAt: { gt: new Date() },
            user: {
              isActive: true,
              mustChangePassword: false,
              version: viewer.version,
            },
          },
          select: { id: true },
        });
        if (!session)
          throw new AppError(
            "USER_SESSION",
            "登录或账号状态已变化，请重新登录",
            401,
          );
        const row = await tx.calendarSubscription.findUnique({
          where: { userId: user.id },
        });
        return {
          active: !!row?.tokenHash && row.userVersion === user.version,
          version: row?.version ?? 0,
          includeInvites: row?.includeInvites ?? false,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export async function rotateCalendar(viewer: Viewer, input: unknown) {
  const data = calendarRotationSchema.parse(input);
  const token = randomBytes(32).toString("hex");
  return viewerContext.run(viewer, () =>
    writeTransaction(async (tx) => {
      const user = await lockUser(tx, viewer);
      const current = await tx.calendarSubscription.findUnique({
        where: { userId: user.id },
      });
      if ((current?.version ?? 0) !== data.version)
        throw new AppError(
          "CALENDAR_CONFLICT",
          "订阅配置已变化，请重新读取；不要重复更换链接",
          409,
        );
      const row = await tx.calendarSubscription.upsert({
        where: { userId: user.id },
        create: {
          userId: user.id,
          userVersion: user.version,
          tokenHash: digest(token),
          includeInvites: data.includeInvites,
          version: 1,
        },
        update: {
          userVersion: user.version,
          tokenHash: digest(token),
          includeInvites: data.includeInvites,
          version: { increment: 1 },
        },
      });
      return {
        active: true,
        version: row.version,
        includeInvites: row.includeInvites,
        token,
      };
    }),
  );
}

export async function revokeCalendar(viewer: Viewer, input: unknown) {
  const { version } = calendarRevocationSchema.parse(input);
  return viewerContext.run(viewer, () =>
    writeTransaction(async (tx) => {
      const user = await lockUser(tx, viewer);
      const current = await tx.calendarSubscription.findUnique({
        where: { userId: user.id },
      });
      if ((current?.version ?? 0) !== version)
        throw new AppError(
          "CALENDAR_CONFLICT",
          "订阅配置已变化，请重新读取",
          409,
        );
      if (current?.tokenHash)
        await tx.calendarSubscription.update({
          where: { userId: user.id },
          data: { tokenHash: null, version: { increment: 1 } },
        });
      return {
        active: false,
        version: version + (current?.tokenHash ? 1 : 0),
        includeInvites: current?.includeInvites ?? false,
      };
    }),
  );
}

// A subscription is a bearer credential. It never reads browser or administrator cookies.
export async function calendarFeed(token: string, now = new Date()) {
  if (!/^[a-f0-9]{64}$/.test(token))
    throw new AppError("NOT_FOUND", "订阅链接无效或已失效", 404);
  return measureTransaction(() =>
    db.$transaction(
      async (tx) => {
        const row = await tx.calendarSubscription.findUnique({
          where: { tokenHash: digest(token) },
          include: { user: true },
        });
        if (
          !row ||
          !row.user.isActive ||
          row.user.mustChangePassword ||
          row.userVersion !== row.user.version
        )
          throw new AppError("NOT_FOUND", "订阅链接无效或已失效", 404);
        const records = await tx.gameReservation.findMany({
          where: {
            deletedAt: null,
            ...(!row.includeInvites ? { visibility: "PUBLIC" } : {}),
            scheduledAt: {
              gte: new Date(now.getTime() - 30 * 86400000),
              lt: new Date(now.getTime() + 365 * 86400000),
            },
            participants: {
              some: { tokenHash: digest(memberToken(row.user)) },
            },
          },
          orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
          take: 1001,
          select: {
            id: true,
            gameName: true,
            scheduledAt: true,
            updatedAt: true,
            revision: true,
            status: true,
          },
        });
        if (records.length > 1000)
          throw new AppError(
            "CALENDAR_LIMIT",
            "订阅范围内预约超过 1000 场，请使用站内日程",
            409,
          );
        return records.map((record) => ({
          ...record,
          scheduledAt: record.scheduledAt.toISOString(),
          updatedAt: record.updatedAt.toISOString(),
        }));
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: Math.max(1, Math.min(3000, remainingBudget())),
        maxWait: 1000,
      },
    ),
  );
}
