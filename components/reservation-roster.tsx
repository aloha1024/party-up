import { Button } from "./ui/button";
import type { RosterAction } from "./roster-action-dialog";
import type { Reservation } from "@/types/reservation";
import type { Status } from "@/lib/status";
import type { recruitmentClosure } from "@/lib/recruitment";
import { formatTime } from "@/lib/utils";
import { Check, Plus } from "lucide-react";

export function ReservationRoster({
  reservation: r,
  admin,
  state,
  closed,
  disabled,
  onAction,
}: {
  reservation: Reservation;
  admin: boolean;
  state: Status;
  closed: ReturnType<typeof recruitmentClosure>;
  disabled: boolean;
  onAction: (action: RosterAction) => void;
}) {
  return (
    <section className="panel order-last overflow-hidden lg:order-first">
      <div className="flex items-center justify-between border-b border-white/10 p-6">
        <h2 className="font-semibold">接龙名单</h2>
        <span className="text-sm text-zinc-500">按加入时间排序</span>
      </div>
      <ol className="space-y-2 p-4 sm:p-6">
        {r.participants.map((p, i) => (
          <li
            key={p.id}
            className="flex items-center gap-4 rounded-xl bg-white/[.025] p-4"
          >
            <span className="w-5 text-sm tabular-nums text-zinc-500">
              {String(i + 1).padStart(2, "0")}
            </span>
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-lime-300/10 font-semibold text-lime-200">
              {p.name.slice(0, 1)}
            </span>
            <span className="min-w-0 flex-1 break-words font-medium">
              {p.name}
              {p.isMe && <span className="ml-2 text-xs text-lime-300">你</span>}
              <span className="mt-1 block text-xs font-normal text-zinc-400">
                {p.checkedInAt
                  ? `已到场 · ${formatTime(p.checkedInAt)}（北京时间）`
                  : "未确认"}
              </span>
            </span>
            <Check size={16} className="shrink-0 text-zinc-500" />
            {!["STARTED", "CANCELLED", "ENDED"].includes(state) &&
              (p.isMe || ((r.isHost || admin) && !p.isHost)) && (
                <Button
                  type="button"
                  variant="outline"
                  className="shrink-0 px-2 text-xs"
                  disabled={disabled}
                  onClick={() =>
                    onAction({
                      kind: "participants",
                      entryId: p.id,
                      expectedName: p.name,
                      mode: p.isMe ? "rename" : "remove",
                    })
                  }
                >
                  {p.isMe ? "修改昵称" : "移除"}
                </Button>
              )}
          </li>
        ))}
        {state === "OPEN" && !closed && (
          <li className="flex items-center gap-4 rounded-xl border border-dashed border-white/10 p-4 text-sm text-zinc-500">
            <span className="w-5">
              {String(r.participants.length + 1).padStart(2, "0")}
            </span>
            <span className="flex size-10 items-center justify-center">
              <Plus size={20} />
            </span>
            等一位一起开黑的队友
          </li>
        )}
        {!r.participants.length && (state !== "OPEN" || closed) && (
          <li className="p-4 text-zinc-500">暂无参与者</li>
        )}
      </ol>
      {r.waitlist.length > 0 && (
        <section aria-label="候补名单" className="border-t border-white/10 p-6">
          <h2 className="font-semibold">候补名单 · {r.waitlist.length} 人</h2>
          <p className="mt-2 text-xs text-zinc-400">
            候补不是正式报名。招募开放且有空位时将按顺序自动转为正式报名。
            不发送外部通知，请留意最新名单。
          </p>
          <ol className="mt-4 space-y-3">
            {r.waitlist.map((p, i) => (
              <li key={p.id} className="flex gap-3 text-sm">
                <span className="text-zinc-500">{i + 1}.</span>
                <span className="min-w-0 flex-1 break-words">
                  {p.name}
                  {p.isMe && <span className="ml-2 text-lime-300">你</span>}
                </span>
                <span className="shrink-0 text-zinc-500">
                  {state === "CANCELLED"
                    ? "预约已取消"
                    : ["STARTED", "ENDED"].includes(state)
                      ? "未递补"
                      : closed
                        ? "递补已暂停"
                        : "候补中"}
                </span>
                {!["STARTED", "CANCELLED", "ENDED"].includes(state) &&
                  (p.isMe || ((r.isHost || admin) && !p.isHost)) && (
                    <Button
                      type="button"
                      variant="outline"
                      className="shrink-0 px-2 text-xs"
                      disabled={disabled}
                      onClick={() =>
                        onAction({
                          kind: "waitlist",
                          entryId: String(p.id),
                          expectedName: p.name,
                          mode: p.isMe ? "rename" : "remove",
                        })
                      }
                    >
                      {p.isMe ? "修改昵称" : "移除"}
                    </Button>
                  )}
              </li>
            ))}
          </ol>
        </section>
      )}
      <div className="border-t border-white/10 p-6">
        <h3 className="mb-3 text-sm font-medium text-zinc-400">组局备注</h3>
        <p className="whitespace-pre-wrap break-words text-sm leading-7 text-zinc-300">
          {r.description || "发起人没有留下备注，准时来就好。"}
        </p>
      </div>
    </section>
  );
}
