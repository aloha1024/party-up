export type Status = "OPEN" | "FULL" | "STARTED" | "CANCELLED";
export function getStatus(
  r: { status: string; scheduledAt: Date | string; maxPlayers: number },
  count: number,
  now = new Date(),
): Status {
  if (r.status === "CANCELLED") return "CANCELLED";
  if (new Date(r.scheduledAt) <= now) return "STARTED";
  return count >= r.maxPlayers ? "FULL" : "OPEN";
}
export const statusLabels: Record<Status, string> = {
  OPEN: "报名中",
  FULL: "已满员",
  STARTED: "已开始",
  CANCELLED: "已取消",
};
