import { z } from "zod";
import {
  myReservationListSchema,
  reservationListUrl,
} from "./reservation-list";
import type { ReservationSummary } from "../types/reservation";

export const scheduleSchema = z.object({
  layout: z.enum(["list", "schedule"]).default("list"),
  range: z.enum(["today", "week"]).default("week"),
  schedulePage: z
    .union([z.number(), z.string().regex(/^[1-9]\d*$/)])
    .transform(Number)
    .pipe(z.number().int().min(1).max(100000))
    .default(1),
});
export const personalPageSchema = myReservationListSchema.extend(
  scheduleSchema.shape,
);
export type PersonalPageFilters = z.infer<typeof personalPageSchema>;
export type ScheduleFilters = z.infer<typeof scheduleSchema>;
export const beijingDate = (date: Date | string) =>
  new Date(new Date(date).getTime() + 8 * 3600000).toISOString().slice(0, 10);
export function scheduleBounds(range: ScheduleFilters["range"], now: Date) {
  const day = beijingDate(now);
  const start = new Date(day + "T00:00:00+08:00");
  return {
    day,
    start,
    end: new Date(start.getTime() + (range === "today" ? 1 : 7) * 86400000),
    midnight: new Date(start.getTime() + 86400000).toISOString(),
  };
}
export type ScheduleItem = ReservationSummary & {
  isHost: boolean;
  isParticipant: boolean;
  isWaiting: boolean;
  checkedInAt: string | null;
  attendance: "closed" | "waiting" | "ready" | "confirmed" | null;
  simultaneous: boolean;
};
export type SchedulePage = {
  items: ScheduleItem[];
  nearest: ReservationSummary | null;
  total: number;
  page: number;
  pageCount: number;
  range: ScheduleFilters["range"];
  day: string;
  midnight: string;
};
export function personalPageUrl(
  filters: PersonalPageFilters,
  changes: Partial<PersonalPageFilters> = {},
) {
  const next = { ...filters, ...changes };
  const base = reservationListUrl(
    "/my-reservations",
    next,
    next.page,
    next.tab,
  );
  const [path, search] = base.split("?");
  const query = new URLSearchParams(search);
  if (next.layout === "schedule") query.set("layout", "schedule");
  // Keep schedule state when returning to the list as well.
  query.set("range", next.range);
  if (next.schedulePage !== 1)
    query.set("schedulePage", String(next.schedulePage));
  return path + "?" + query;
}
export function scheduleWakeups(page: SchedulePage) {
  return [
    page.midnight,
    ...(page.nearest ? [page.nearest.scheduledAt] : []),
    ...page.items.flatMap((r) => [
      r.scheduledAt,
      ...(r.isParticipant && r.attendance !== "closed"
        ? [new Date(Date.parse(r.scheduledAt) - 30 * 60000).toISOString()]
        : []),
    ]),
  ];
}
