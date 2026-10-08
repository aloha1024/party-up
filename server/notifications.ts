import { Prisma, type Notification } from "@prisma/client";
import { z } from "zod";
import { db } from "./db";
import { AppError } from "./errors";
import { identityHash } from "./reservation-access";
import { writeTransaction } from "./request-budget";
import { measureTransaction } from "./request-metrics";

export type NotificationKind =
  "PROMOTED" | "RESCHEDULED" | "CANCELLED" | "REMOVED" | "MEETING_UPDATED";

const pageSchema = z
  .object({
    page: z.coerce.number().int().min(1).max(1000000).default(1),
    unread: z.enum(["all", "unread"]).default("all"),
  })
  .strict();

export function notificationSearchParams(params: URLSearchParams) {
  const input: Record<string, string> = {};
  for (const key of params.keys()) {
    if (!["page", "unread"].includes(key) || params.getAll(key).length !== 1)
      throw new AppError("VALIDATION", "通知筛选参数无效", 400);
    input[key] = params.get(key)!;
  }
  if (input.page !== undefined && !/^[1-9]\d*$/.test(input.page))
    throw new AppError("VALIDATION", "页码必须是正整数", 400);
  return pageSchema.parse(input);
}

// Call only in the transaction that commits the source event. The event key is
// derived from its persistent version/entry ID, never from a request or clock.
export async function recordNotifications(
  tx: Prisma.TransactionClient,
  reservationId: string,
  kind: NotificationKind,
  eventKey: string,
  recipients: Iterable<string>,
) {
  await Promise.all(
    [...new Set(recipients)].filter(Boolean).map((recipientHash) =>
      tx.notification.upsert({
        where: { recipientHash_eventKey: { recipientHash, eventKey } },
        create: { reservationId, recipientHash, eventKey, kind },
        update: {},
      }),
    ),
  );
}

export function reservationRecipients(
  reservation: {
    hostTokenHash: string | null;
    participants: { tokenHash: string }[];
    waitlist: { tokenHash: string }[];
  },
  actorHash: string,
  includeWaitlist = true,
) {
  return [
    ...new Set([
      reservation.hostTokenHash,
      ...reservation.participants.map((p) => p.tokenHash),
      ...(includeWaitlist ? reservation.waitlist.map((p) => p.tokenHash) : []),
    ]),
  ].filter((hash): hash is string => !!hash && hash !== actorHash);
}

export async function unreadNotificationCount(token?: string) {
  const recipientHash = identityHash(token);
  return recipientHash
    ? db.notification.count({ where: { recipientHash, readAt: null } })
    : 0;
}

export async function listNotifications(token?: string, input: unknown = {}) {
  const filters = pageSchema.parse(input);
  const recipientHash = identityHash(token);
  const empty = { items: [], total: 0, page: 1, pageCount: 1, unreadCount: 0 };
  if (!recipientHash) return empty;
  return measureTransaction(() =>
    db.$transaction(
      async (tx) => {
        const where = {
          recipientHash,
          ...(filters.unread === "unread" ? { readAt: null } : {}),
        };
        const total = await tx.notification.count({ where });
        const unreadCount =
          filters.unread === "unread"
            ? total
            : await tx.notification.count({
                where: { recipientHash, readAt: null },
              });
        const pageCount = Math.max(1, Math.ceil(total / 20));
        const page = Math.min(filters.page, pageCount);
        const rows = await tx.notification.findMany({
          where,
          orderBy: { id: "desc" },
          skip: (page - 1) * 20,
          take: 20,
          select: {
            id: true,
            kind: true,
            createdAt: true,
            readAt: true,
            reservation: {
              select: {
                id: true,
                gameName: true,
                deletedAt: true,
                visibility: true,
                hostTokenHash: true,
                inviteVersion: true,
                access: {
                  where: { tokenHash: recipientHash },
                  select: { inviteVersion: true, hasJoined: true },
                },
                participants: {
                  where: { tokenHash: recipientHash },
                  select: { id: true },
                  take: 1,
                },
                waitlist: {
                  where: { tokenHash: recipientHash },
                  select: { id: true },
                  take: 1,
                },
              },
            },
          },
        });
        return {
          items: rows.map((row) => {
            const r = row.reservation;
            const readable =
              !r.deletedAt &&
              (r.visibility === "PUBLIC" ||
                r.hostTokenHash === recipientHash ||
                r.participants.length > 0 ||
                r.waitlist.length > 0 ||
                r.access.some(
                  (a) => a.hasJoined || a.inviteVersion === r.inviteVersion,
                ));
            return {
              id: row.id,
              reservationId: readable ? r.id : null,
              gameName: readable ? r.gameName : "预约已移除或访问权限已失效",
              kind: row.kind,
              createdAt: row.createdAt.toISOString(),
              readAt: row.readAt?.toISOString() ?? null,
            };
          }),
          total,
          page,
          pageCount,
          unreadCount,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

const readSchema = z.union([
  z.object({ id: z.number().int().positive().max(2147483647) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);

export async function markNotificationsRead(token: string, input: unknown) {
  const data = readSchema.parse(input);
  const recipientHash = identityHash(token);
  if (!recipientHash)
    throw new AppError("IDENTITY_REQUIRED", "请使用收到通知的身份操作", 428);
  return writeTransaction(async (tx) => {
    if ("id" in data) {
      const row = await tx.notification.findFirst({
        where: { id: data.id, recipientHash },
        select: { id: true },
      });
      if (!row) throw new AppError("NOT_FOUND", "通知不存在", 404);
    }
    await tx.notification.updateMany({
      where: {
        recipientHash,
        readAt: null,
        ...("id" in data ? { id: data.id } : {}),
      },
      data: { readAt: new Date() },
    });
    return { updated: true };
  });
}

export async function migrateNotifications(
  tx: Prisma.TransactionClient,
  reservationIds: string[],
  guestHash: string,
  userHash: string,
  snapshot?: Notification[],
) {
  const receipts =
    snapshot ??
    (await tx.notification.findMany({
      where: {
        reservationId: { in: reservationIds },
        recipientHash: { in: [guestHash, userHash] },
      },
      orderBy: { id: "asc" },
    }));
  const selected = new Set(reservationIds);
  const sources = receipts.filter(
    (row) => row.recipientHash === guestHash && selected.has(row.reservationId),
  );
  const targets = new Map(
    receipts
      .filter((row) => row.recipientHash === userHash)
      .map((row) => [row.eventKey, row]),
  );
  for (const source of sources) {
    const target = targets.get(source.eventKey);
    if (target) {
      // A duplicate receipt remains unread if either identity had not read it.
      const readAt =
        source.readAt && target.readAt
          ? new Date(Math.min(source.readAt.getTime(), target.readAt.getTime()))
          : null;
      await tx.notification.update({
        where: { id: target.id },
        data: { readAt },
      });
      await tx.notification.delete({ where: { id: source.id } });
    } else {
      await tx.notification.update({
        where: { id: source.id },
        data: { recipientHash: userHash },
      });
    }
  }
}
