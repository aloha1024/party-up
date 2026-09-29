import { Prisma } from "@prisma/client";
import { db } from "./db";
import { lockUser, requireUser } from "./user-accounts";
import { type Viewer } from "./user-identity";
import { writeTransaction } from "./request-budget";
import { measureTransaction } from "./request-metrics";
import { AppError } from "./errors";
import {
  sessionIdSchema,
  sessionPageSchema,
  type UserSessionPage,
} from "../lib/user-sessions";

export async function listUserSessions(
  viewer: Viewer,
  pageInput?: unknown,
  now = new Date(),
): Promise<UserSessionPage> {
  const user = requireUser(viewer);
  const requested = sessionPageSchema.parse(pageInput);
  return measureTransaction(() =>
    db.$transaction(
      async (tx) => {
        // Recheck in the same snapshot without turning a read into a write.
        const current = await tx.userSession.findFirst({
          where: {
            id: viewer.sessionHash,
            userId: user.id,
            version: viewer.version,
            expiresAt: { gt: now },
            user: {
              isActive: true,
              mustChangePassword: false,
              version: viewer.version,
            },
          },
          select: { id: true },
        });
        if (!current)
          throw new AppError(
            "USER_SESSION",
            "登录或账号状态已变化，请重新登录",
            401,
          );
        const where = {
          userId: user.id,
          version: viewer.version,
          expiresAt: { gt: now },
        };
        const total = await tx.userSession.count({ where });
        const pageCount = Math.max(1, Math.ceil(total / 20));
        const page = Math.min(requested, pageCount);
        const rows = await tx.userSession.findMany({
          where,
          orderBy: [
            { createdAt: { sort: "desc", nulls: "last" } },
            { publicId: "asc" },
          ],
          skip: (page - 1) * 20,
          take: 20,
          select: {
            id: true,
            publicId: true,
            browser: true,
            os: true,
            createdAt: true,
            expiresAt: true,
          },
        });
        return {
          items: rows.map((row) => ({
            id: row.publicId,
            browser: row.browser,
            os: row.os,
            createdAt: row.createdAt?.toISOString() ?? null,
            expiresAt: row.expiresAt.toISOString(),
            current: row.id === viewer.sessionHash,
          })),
          total,
          page,
          pageCount,
          pageSize: 20,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export async function revokeUserSession(viewer: Viewer, input: unknown) {
  const publicId = sessionIdSchema.parse(input);
  return writeTransaction(async (tx) => {
    const user = await lockUser(tx, viewer);
    const target = await tx.userSession.findFirst({
      where: { userId: user.id, publicId },
      select: { id: true },
    });
    if (target)
      await tx.userSession.deleteMany({ where: { userId: user.id, publicId } });
    return {
      revoked: true as const,
      current: !!target && target.id === viewer.sessionHash,
    };
  });
}
