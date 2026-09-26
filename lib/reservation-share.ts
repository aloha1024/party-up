import type { Reservation } from "@/types/reservation";
import { getStatus, statusLabels } from "./status";

export function reservationShareText(
  r: Reservation,
  url: string,
  now = new Date(),
) {
  const time = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(r.scheduledAt));
  return [
    "【游戏接龙】" + r.gameName,
    "发起人：" + r.hostName,
    "开玩时间：" + time + "（北京时间 UTC+8）",
    "已接龙人数：" + r.participants.length + " / " + r.maxPlayers + " 人",
    "当前状态：" + statusLabels[getStatus(r, r.participants.length, now)],
    ...(r.status === "CANCELLED" && r.cancellationReason
      ? ["取消原因：" + r.cancellationReason]
      : []),
    "备注：" + (r.description.trim() || "无"),
    "",
    "接龙名单（昵称 / 游戏 ID）：",
    ...(r.participants.length
      ? r.participants.map((p, i) => i + 1 + ". " + p.name)
      : ["暂无报名"]),
    ...(r.waitlist.length
      ? [
          "",
          `候补名单（${r.waitlist.length} 人，候补不是正式报名）：`,
          ...r.waitlist.map((p, i) => `${i + 1}. ${p.name}`),
        ]
      : []),
    "",
    "接龙链接：" + url,
    "人数与名单以链接页面的最新信息为准。",
  ].join("\n");
}
