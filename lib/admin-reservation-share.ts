import { z } from "zod";

export const adminReservationShareSchema = z.object({
  items: z.array(
    z.object({
      gameName: z.string(),
      participantCount: z.number().int().nonnegative(),
      maxPlayers: z.number().int().positive(),
      scheduledAt: z.iso.datetime(),
      visibility: z.enum(["PUBLIC", "INVITE"]),
      path: z
        .string()
        .regex(/^\/reservation\/[^/?#]+(?:#invite=[a-f0-9]{64})?$/),
    }),
  ),
});
export type AdminShareItem = z.infer<
  typeof adminReservationShareSchema
>["items"][number];

const time = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function adminReservationShareText(
  items: AdminShareItem[],
  origin: string,
) {
  return [
    "可报名接龙（北京时间）",
    ...items.map((item, index) =>
      [
        `${index + 1}. ${item.gameName.replace(/\s+/g, " ").trim()}${item.visibility === "INVITE" ? "（邀请制）" : ""}`,
        `${item.participantCount}/${item.maxPlayers} 人 · ${time.format(new Date(item.scheduledAt))}`,
        new URL(item.path, origin).href,
      ].join("\n"),
    ),
    "人数以接龙页面为准。",
  ].join("\n\n");
}
