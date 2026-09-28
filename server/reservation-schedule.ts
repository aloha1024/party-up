import { Prisma } from "@prisma/client";
import { db } from "./db";
import { digest, validIdentity } from "./user-identity";
import { measureTransaction } from "./request-metrics";
import { getStatus } from "../lib/status";
import {
  scheduleBounds,
  scheduleSchema,
  type ScheduleItem,
  type SchedulePage,
} from "../lib/reservation-schedule";

const summarySelect = {
  id: true,
  gameName: true,
  hostName: true,
  scheduledAt: true,
  maxPlayers: true,
  status: true,
  visibility: true,
  _count: { select: { participants: true } },
} satisfies Prisma.GameReservationSelect;
type SummaryRow = Prisma.GameReservationGetPayload<{
  select: typeof summarySelect;
}>;
function summary(row: SummaryRow, now: Date) {
  return {
    id: row.id,
    gameName: row.gameName,
    hostName: row.hostName,
    scheduledAt: row.scheduledAt.toISOString(),
    maxPlayers: row.maxPlayers,
    status: getStatus(row, row._count.participants, now),
    visibility: row.visibility as "PUBLIC" | "INVITE",
    participantCount: row._count.participants,
  };
}

export async function listMySchedule(
  input: unknown,
  token?: string,
  now = new Date(),
): Promise<SchedulePage> {
  const filters = scheduleSchema.parse(input);
  const bounds = scheduleBounds(filters.range, now);
  const empty: SchedulePage = {
    items: [],
    nearest: null,
    total: 0,
    page: 1,
    pageCount: 1,
    range: filters.range,
    day: bounds.day,
    midnight: bounds.midnight,
  };
  if (!validIdentity(token)) return empty;
  const hash = digest(token);
  const membership = { some: { tokenHash: hash } };
  const base = {
    deletedAt: null,
    scheduledAt: { gte: bounds.start, lt: bounds.end },
  };
  const where = {
    ...base,
    OR: [
      { hostTokenHash: hash },
      { participants: membership },
      { waitlist: membership },
    ],
  };
  return measureTransaction(() =>
    db.$transaction(
      async (tx) => {
        const total = await tx.gameReservation.count({ where });
        if (!total) return empty;
        const pageCount = Math.ceil(total / 12),
          page = Math.min(filters.schedulePage, pageCount);
        const rows = await tx.gameReservation.findMany({
          where,
          orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
          skip: (page - 1) * 12,
          take: 12,
          select: {
            ...summarySelect,
            hostTokenHash: true,
            participants: {
              where: { tokenHash: hash },
              select: { checkedInAt: true },
              take: 1,
            },
            waitlist: {
              where: { tokenHash: hash },
              select: { id: true },
              take: 1,
            },
          },
        });
        const active = {
          ...base,
          status: { notIn: ["CANCELLED", "ENDED"] },
          participants: membership,
        };
        const nearest = await tx.gameReservation.findFirst({
          where: {
            ...active,
            scheduledAt: { gt: now, gte: bounds.start, lt: bounds.end },
          },
          orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
          select: summarySelect,
        });
        // At most 12 timestamp groups, but each count includes matches on every page.
        const times = rows
          .filter(
            (r) =>
              r.participants.length &&
              !["CANCELLED", "ENDED"].includes(r.status),
          )
          .map((r) => r.scheduledAt);
        const groups = times.length
          ? await tx.gameReservation.groupBy({
              by: ["scheduledAt"],
              where: {
                ...active,
                scheduledAt: { in: times, gte: bounds.start, lt: bounds.end },
              },
              _count: { _all: true },
            })
          : [];
        const collisions = new Set(
          groups
            .filter((g) => g._count._all > 1)
            .map((g) => g.scheduledAt.getTime()),
        );
        const items: ScheduleItem[] = rows.map((row) => {
          const me = row.participants[0];
          const closed = ["CANCELLED", "ENDED"].includes(row.status);
          return {
            ...summary(row, now),
            isHost: row.hostTokenHash === hash,
            isParticipant: !!me,
            isWaiting: !!row.waitlist.length,
            checkedInAt: me?.checkedInAt?.toISOString() ?? null,
            attendance: !me
              ? null
              : closed
                ? "closed"
                : me.checkedInAt
                  ? "confirmed"
                  : now.getTime() >= row.scheduledAt.getTime() - 30 * 60000
                    ? "ready"
                    : "waiting",
            simultaneous:
              !!me && !closed && collisions.has(row.scheduledAt.getTime()),
          };
        });
        return {
          ...empty,
          items,
          nearest: nearest ? summary(nearest, now) : null,
          total,
          page,
          pageCount,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
