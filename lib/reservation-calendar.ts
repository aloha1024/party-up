import { z } from "zod";

export const calendarReservationSchema = z.object({
  id: z.string().min(1),
  gameName: z.string(),
  hostName: z.string(),
  description: z.string(),
  scheduledAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  editVersion: z.number().int().nonnegative(),
});
export type CalendarReservation = z.infer<typeof calendarReservationSchema>;

// RFC 5545 TEXT escaping prevents submitted content from adding properties.
function text(value: string) {
  return value
    .replace(/\r\n|\r/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replaceAll("\n", "\\n");
}
// Fold at 75 UTF-8 octets, preserving whole code points and counting the
// continuation space. CRLF belongs to the file format, not the host platform.
function fold(line: string) {
  const encoder = new TextEncoder();
  let result = "",
    bytes = 0;
  for (const point of line) {
    const size = encoder.encode(point).length;
    if (bytes + size > 75) {
      result += "\r\n ";
      bytes = 1;
    }
    result += point;
    bytes += size;
  }
  return result;
}
const utc = (value: string) =>
  new Date(value)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");

export function reservationCalendar(
  input: CalendarReservation,
  origin: string,
) {
  const r = calendarReservationSchema.parse(input);
  const base = new URL(origin);
  if (!["http:", "https:"].includes(base.protocol))
    throw new Error("无效的网站地址");
  const url = new URL(`/reservation/${encodeURIComponent(r.id)}`, base.origin)
    .href;
  const summary = text("一起开黑 · " + r.gameName);
  const description = text(
    [
      "发起人：" + r.hostName,
      "备注：" + (r.description || "无"),
      "仅记录开玩时间，未指定结束时间。",
      "这是导出时的副本，不会自动同步；预约修改、取消或退出后，请手动调整日历。",
      "实际开玩时间及名单以预约页面为准：" + url,
    ].join("\n"),
  );
  return (
    [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Party Up//Reservation Calendar//ZH-CN",
      "CALSCALE:GREGORIAN",
      "BEGIN:VEVENT",
      `UID:${encodeURIComponent(r.id)}@party-up`,
      `DTSTAMP:${utc(r.updatedAt)}`,
      `LAST-MODIFIED:${utc(r.updatedAt)}`,
      `SEQUENCE:${r.editVersion}`,
      `DTSTART:${utc(r.scheduledAt)}`,
      `SUMMARY:${summary}`,
      `DESCRIPTION:${description}`,
      `URL:${url}`,
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "TRIGGER:-PT15M",
      `DESCRIPTION:${summary}`,
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
    ]
      .map(fold)
      .join("\r\n") + "\r\n"
  );
}
