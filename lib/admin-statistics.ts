import { z } from "zod";

export const adminStatisticsSchema = z
  .object({
    range: z.enum(["today", "week", "month"]).default("month"),
  })
  .strict();
export type StatisticsRange = z.infer<typeof adminStatisticsSchema>["range"];
export const statisticsRangeLabels: Record<StatisticsRange, string> = {
  today: "今天",
  week: "近 7 天",
  month: "近 30 天",
};

export function statisticsBounds(range: StatisticsRange, now: Date) {
  const day = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  const today = new Date(day + "T00:00:00+08:00");
  const days = range === "today" ? 1 : range === "week" ? 7 : 30;
  return {
    start: new Date(today.getTime() - (days - 1) * 86400000),
    end: new Date(today.getTime() + 86400000),
  };
}

export function adminStatisticsUrl(range: StatisticsRange) {
  return "/admin/statistics" + (range === "month" ? "" : `?range=${range}`);
}

export type AdminStatistics = {
  range: StatisticsRange;
  start: string;
  end: string;
  asOf: string;
  reservations: {
    total: number;
    upcoming: number;
    started: number;
    ended: number;
    cancelled: number;
  };
  roster: { participants: number; waitlist: number; checkedIn: number };
  accounts: { total: number; active: number };
};
