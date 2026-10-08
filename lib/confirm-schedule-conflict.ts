import { request } from "./client-request";
import { reservationConflictsSchema } from "./reservation-conflicts";
import { formatTime } from "./utils";

// Advisory only: membership and capacity are always checked by the later write.
// Never create a submission key or resend a mutation as part of this lookup.
export async function confirmScheduleConflict(
  scheduledAt: string,
  exclude?: string,
) {
  const query = new URLSearchParams({ scheduledAt });
  if (exclude) query.set("exclude", exclude);
  const result = await request(
    `/api/reservations/conflicts?${query}`,
    "GET",
    undefined,
    {
      schema: reservationConflictsSchema,
    },
  );
  if (!result.items.length) return true;
  return window.confirm(
    [
      "同期开局，请核对安排。你已正式参加以下同一开局时间的预约：",
      ...result.items.map(
        (item) => `${item.gameName} · ${formatTime(item.scheduledAt)}`,
      ),
      ...(result.hasMore ? ["还有其他同期开局预约，可在我的日程中查看。"] : []),
      "仅比较开局时间，不推断游戏时长。仍要继续本次操作吗？",
    ].join("\n"),
  );
}
