"use client";
import { InvitationEntry, InvitationManager } from "./reservation-invitation";
import { ReservationAttendance } from "./reservation-attendance";
import { attendanceOpensAt } from "../lib/reservation-attendance";
import { CancelReservation } from "@/components/cancel-reservation";
import { ReservationShare } from "@/components/reservation-share";
import { ReservationCalendar } from "@/components/reservation-calendar";
import { ReservationHistory } from "@/components/reservation-history";
import { RosterRemovalHistory } from "./roster-removal-history";
import { RosterActionDialog, type RosterAction } from "./roster-action-dialog";
import type { RemovalPage } from "../lib/roster-management";
import type { HistoryPage } from "@/lib/reservation-history";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useReservationRefresh } from "@/components/use-reservation-refresh";
import { ensureBrowserIdentity } from "@/lib/browser-identity";
import { request } from "@/lib/client-request";
import { getStatus, statusLabels } from "@/lib/status";
import { formatTime } from "@/lib/utils";
import { joinSchema } from "@/lib/validation";
import type { Reservation } from "@/types/reservation";
import { Check, Clock3, Loader2, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import { Back, Badge, Field } from "./reservation-ui";
export function ReservationDetail({
  reservation: r,
  admin = false,
  refreshSample,
  history,
  removals,
}: {
  reservation: Reservation;
  admin?: boolean;
  refreshSample: string;
  history: HistoryPage;
  removals: RemovalPage & { scope: string };
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const [cancelling, setCancelling] = useState(false);
  const [attending, setAttending] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [managing, setManaging] = useState(false);
  const [action, setAction] = useState<RosterAction | null>(null);
  useEffect(() => {
    setAction(null);
  }, [r.id, removals.scope]);
  useReservationRefresh({
    sample: refreshSample,
    data: { reservation: r, admin },
    scope: r.id,
    scheduledAt: [
      attendanceOpensAt(r.scheduledAt).toISOString(),
      r.scheduledAt,
    ],
    paused: pending || cancelling || managing || inviting || attending,
    fixed: true,
  });
  const me = r.participants.find((p) => p.isMe);
  const waitingIndex = r.waitlist.findIndex((p) => p.isMe);
  const state = getStatus(r, r.participants.length);
  const canWait = state === "FULL" && r.waitlist.length < 100;
  function mutate(method: "POST" | "DELETE", queue = false) {
    setError("");
    if (method === "POST") {
      const parsed = joinSchema.safeParse({ name });
      if (!parsed.success) {
        setError(parsed.error.issues[0].message);
        return;
      }
    }
    startTransition(async () => {
      try {
        await ensureBrowserIdentity();
        await request(
          `/api/reservations/${r.id}/${queue ? "waitlist" : "participants"}`,
          method,
          method === "POST" ? { name } : undefined,
        );
        toast.success(
          queue
            ? method === "POST"
              ? "已加入候补，请留意页面中的最新名单"
              : "已退出候补"
            : method === "POST"
              ? "加入成功，开局见！"
              : "已退出接龙",
        );
        setName("");
        if (navigator.onLine) router.refresh();
      } catch (e) {
        setError((e as Error).message);
        // A failed offline refresh may fall back to a document navigation.
        // Keep the roster/error visible; the online event rechecks membership.
        if (navigator.onLine) router.refresh();
      }
    });
  }
  return (
    <>
      <Back />
      <InvitationEntry key={r.id} id={r.id} onPendingChange={setInviting} />
      <div className="mb-9 mt-8 flex flex-wrap items-start justify-between gap-5">
        <div>
          <div className="mb-4 flex items-center gap-3">
            <span className="eyebrow">PARTY DETAILS</span>

            <Badge reservation={r} />
          </div>
          <h1 className="break-words text-3xl font-bold sm:text-5xl">
            {r.gameName}
          </h1>
          <p className="mt-4 text-sm text-zinc-400">
            由 <span className="text-white">{r.hostName}</span> 发起
          </p>
        </div>
        {r.visibility === "INVITE" ? (
          (r.isHost || admin) && (
            <InvitationManager
              key={r.id}
              id={r.id}
              onPendingChange={setInviting}
            />
          )
        ) : (
          <ReservationShare reservation={r} />
        )}
        {r.isHost && (
          <Button asChild variant="outline">
            <Link
              href={`/reservation/new?from=${encodeURIComponent(r.id)}`}
              prefetch={false}
            >
              再开一局
            </Link>
          </Button>
        )}
        {(r.isHost || admin) &&
          !["STARTED", "CANCELLED", "ENDED"].includes(state) && (
            <CancelReservation id={r.id} onPendingChange={setCancelling} />
          )}
        {(r.isHost || admin) &&
          !["STARTED", "CANCELLED", "ENDED"].includes(state) && (
            <Button asChild variant="outline">
              <Link href={`/reservation/${r.id}/edit`}>编辑预约</Link>
            </Button>
          )}
      </div>
      <ReservationAttendance
        key={r.id}
        reservation={r}
        admin={admin}
        onPendingChange={setAttending}
      />
      {state === "CANCELLED" && (
        <div role="status" className="panel mb-6 p-5">
          <h2 className="font-semibold">预约已取消</h2>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm text-zinc-400">
            {r.cancellationReason || "发起人或管理员已取消本次预约。"}
          </p>
        </div>
      )}
      <div className="grid items-start gap-6 lg:grid-cols-[1fr_340px]">
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
                  {p.isMe && (
                    <span className="ml-2 text-xs text-lime-300">你</span>
                  )}
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
                      disabled={pending || cancelling || managing}
                      onClick={() =>
                        setAction({
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
            {state === "OPEN" && (
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
            {!r.participants.length && state !== "OPEN" && (
              <li className="p-4 text-zinc-500">暂无参与者</li>
            )}
          </ol>
          {r.waitlist.length > 0 && (
            <section
              aria-label="候补名单"
              className="border-t border-white/10 p-6"
            >
              <h2 className="font-semibold">
                候补名单 · {r.waitlist.length} 人
              </h2>
              <p className="mt-2 text-xs text-zinc-400">
                候补不是正式报名。有空位时将按顺序自动转为正式报名。
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
                          : "候补中"}
                    </span>
                    {!["STARTED", "CANCELLED", "ENDED"].includes(state) &&
                      (p.isMe || ((r.isHost || admin) && !p.isHost)) && (
                        <Button
                          type="button"
                          variant="outline"
                          className="shrink-0 px-2 text-xs"
                          disabled={pending || cancelling || managing}
                          onClick={() =>
                            setAction({
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
        <aside className="panel order-first p-6 lg:order-last">
          <div className="mb-6">
            <p className="mb-3 flex items-center gap-2 text-sm text-zinc-400">
              <Clock3 size={16} />
              开玩时间
            </p>
            <p className="text-xl font-semibold">{formatTime(r.scheduledAt)}</p>
            <p className="mt-2 text-xs text-zinc-500">北京时间 UTC+8</p>
          </div>
          <div className="border-y border-white/10 py-6">
            <div className="flex items-end justify-between">
              <span className="text-sm text-zinc-400">参与人数</span>
              <span>
                <strong className="text-3xl text-lime-300">
                  {r.participants.length}
                </strong>
                <span className="text-zinc-500"> / {r.maxPlayers} 人</span>
              </span>
            </div>
            <div className="mt-4 h-1.5 rounded-full bg-white/5">
              <div
                className="h-full rounded-full bg-lime-300"
                style={{
                  width: `${(r.participants.length / r.maxPlayers) * 100}%`,
                }}
              />
            </div>
          </div>
          <div className="pt-6">
            {me ? (
              <>
                <p className="mb-4 flex items-center gap-2 text-sm text-lime-300">
                  <Check size={16} />
                  你已在接龙名单中
                </p>
                <Button
                  variant="outline"
                  className="w-full"
                  disabled={
                    pending || ["STARTED", "CANCELLED", "ENDED"].includes(state)
                  }
                  onClick={() => mutate("DELETE")}
                >
                  {pending ? "正在退出…" : "退出接龙"}
                </Button>
              </>
            ) : waitingIndex >= 0 ? (
              <>
                <p role="status" className="mb-4 text-sm text-lime-300">
                  {state === "CANCELLED"
                    ? "预约已取消"
                    : ["STARTED", "ENDED"].includes(state)
                      ? "未递补"
                      : `你在候补第 ${waitingIndex + 1} 位`}
                </p>
                <Button
                  variant="outline"
                  className="w-full"
                  disabled={pending}
                  onClick={() => mutate("DELETE", true)}
                >
                  {pending ? "正在退出…" : "退出候补"}
                </Button>
              </>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  mutate("POST", state === "FULL");
                }}
              >
                <Field title="你的昵称">
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={24}
                    placeholder="输入昵称，加入这一局"
                    required
                    disabled={(state !== "OPEN" && !canWait) || pending}
                  />
                </Field>
                <Button
                  className="mt-4 w-full"
                  disabled={(state !== "OPEN" && !canWait) || pending}
                >
                  {pending ? <Loader2 className="animate-spin" /> : <Plus />}
                  {pending
                    ? "正在加入…"
                    : state === "OPEN"
                      ? "加入接龙"
                      : state === "FULL"
                        ? canWait
                          ? "加入候补"
                          : "候补已满（最多 100 人）"
                        : statusLabels[state]}
                </Button>
                {state === "FULL" && (
                  <p className="mt-3 text-xs leading-6 text-zinc-400">
                    有空位时将按顺序自动转为正式报名。候补不是正式报名，不发送外部通知。
                  </p>
                )}
              </form>
            )}
            {error && (
              <p role="alert" className="mt-3 text-sm text-red-400">
                {error}
              </p>
            )}
            {me && !["STARTED", "CANCELLED", "ENDED"].includes(state) && (
              <ReservationCalendar
                key={`${r.id}:${r.editVersion}`}
                id={r.id}
                disabled={pending || cancelling}
              />
            )}
            <p className="mt-4 text-xs leading-6 text-zinc-500">
              无需注册。本浏览器会记住你的报名身份；请用同一浏览器退出接龙。
            </p>
          </div>
        </aside>
      </div>
      <ReservationHistory
        key={r.id}
        id={r.id}
        latest={history}
        paused={pending || cancelling || managing || inviting || attending}
      />
      <RosterRemovalHistory
        key={`${r.id}:${removals.scope}`}
        id={r.id}
        scope={removals.scope}
        latest={removals}
        paused={pending || cancelling || managing || inviting || attending}
      />
      {action && (
        <RosterActionDialog
          key={`${r.id}:${removals.scope}:${action.kind}:${action.entryId}:${action.mode}`}
          id={r.id}
          action={action}
          disabled={["STARTED", "CANCELLED", "ENDED"].includes(state)}
          onClose={() => setAction(null)}
          onPendingChange={setManaging}
        />
      )}
    </>
  );
}
