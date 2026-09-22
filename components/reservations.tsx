"use client";
import {
  ensureBrowserIdentity,
  submissionKey,
  clearSubmission,
} from "@/lib/browser-identity";
import { z } from "zod";
import { ClientRequestError, request } from "@/lib/client-request";
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  Clock3,
  Gamepad2,
  Loader2,
  Plus,
  Users,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createSchema, joinSchema } from "@/lib/validation";
import { getStatus, statusLabels } from "@/lib/status";
import { formatTime } from "@/lib/utils";
import { CancelReservation } from "@/components/cancel-reservation";
import { ReservationShare } from "@/components/reservation-share";
import {
  ReservationFilters,
  ReservationPagination,
} from "@/components/reservation-filters";
import { useReservationRefresh } from "@/components/use-reservation-refresh";
import type {
  Reservation,
  ReservationPage,
  ReservationSummary,
} from "@/types/reservation";

function Badge({
  reservation: r,
}: {
  reservation: Reservation | ReservationSummary;
}) {
  const state = getStatus(
    r,
    "participants" in r ? r.participants.length : r.participantCount,
  );
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${state === "OPEN" ? "bg-lime-300/10 text-lime-300" : "bg-white/5 text-zinc-400"}`}
    >
      <span
        className={`size-1.5 rounded-full ${state === "OPEN" ? "bg-lime-300" : "bg-zinc-500"}`}
      />
      {statusLabels[state]}
    </span>
  );
}
export function ReservationList({ listing }: { listing: ReservationPage }) {
  useReservationRefresh();
  const reservations = listing.items;
  const filtered = !!(
    listing.filters.q ||
    listing.filters.date ||
    listing.filters.view !== "all"
  );
  return (
    <>
      <div className="mb-10 flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="eyebrow mb-3">THE LOBBY</p>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            游戏预约<span className="text-lime-300">.</span>
          </h1>
          <p className="mt-3 text-sm text-zinc-400">
            找到你的队友，让下一局准时开始。
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <span className="size-2 rounded-full bg-lime-300" />
          {listing.total} 场预约
        </div>
      </div>
      <ReservationFilters listing={listing} />
      <div className="mb-6 flex items-center justify-between border-b border-white/10 pb-4">
        <span className="flex items-center gap-2 text-sm font-medium">
          <Gamepad2 size={18} className="text-lime-300" />
          {filtered ? "筛选结果" : "全部预约"}{" "}
          <span className="ml-1 text-zinc-500">
            {listing.total.toString().padStart(2, "0")}
          </span>
        </span>
        <span className="text-xs text-zinc-500">按开玩时间排序 · 北京时间</span>
      </div>
      {reservations.length ? (
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {reservations.map((r, i) => (
            <Link
              key={r.id}
              href={`/reservation/${r.id}`}
              className="panel group overflow-hidden transition hover:-translate-y-1 hover:border-lime-300/40 focus-visible:outline-lime-300"
            >
              <div
                className={`relative flex h-28 items-center justify-between overflow-hidden border-b border-white/5 px-6 ${["bg-[#252d25]", "bg-[#272736]", "bg-[#302729]"][i % 3]}`}
              >
                <Gamepad2 size={64} strokeWidth={1} className="text-white/15" />
                <span className="absolute right-4 top-0 text-8xl font-black italic text-white/[.035]">
                  PLAY
                </span>
                <Badge reservation={r} />
              </div>
              <div className="p-6">
                <h2 className="truncate text-xl font-bold">{r.gameName}</h2>
                <p className="mt-4 flex items-center gap-2 text-sm text-zinc-300">
                  <Clock3 size={15} className="text-zinc-500" />
                  {formatTime(r.scheduledAt)}
                </p>
                <p className="mt-2 truncate text-sm text-zinc-500">
                  发起人：{r.hostName}
                </p>
                <div className="mt-6 h-1 rounded-full bg-white/5">
                  <div
                    className="h-1 rounded-full bg-lime-300/70"
                    style={{
                      width: `${(r.participantCount / r.maxPlayers) * 100}%`,
                    }}
                  />
                </div>
                <div className="mt-4 flex items-center justify-between">
                  <span className="flex items-center gap-2 text-sm text-zinc-400">
                    <Users size={16} />
                    <strong className="text-white">
                      {r.participantCount}
                    </strong>{" "}
                    / {r.maxPlayers} 人
                  </span>
                  <ArrowUpRight
                    size={18}
                    className="text-zinc-500 group-hover:text-lime-300"
                  />
                </div>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="panel flex min-h-80 flex-col items-center justify-center px-6 text-center">
          <Gamepad2 size={48} strokeWidth={1} className="mb-5 text-lime-300" />
          <h2 className="text-xl font-semibold">
            {filtered ? "没有符合条件的预约" : "大厅已就绪，等你开第一局"}
          </h2>
          <p className="mb-6 mt-3 text-sm text-zinc-400">
            {filtered
              ? "试试其他游戏名称、日期或状态，或清除筛选条件。"
              : "选个游戏、定好时间，把链接发给队友。"}
          </p>
          <Button asChild>
            <Link href="/reservation/new">
              <Plus />
              创建预约
            </Link>
          </Button>
        </div>
      )}
      <ReservationPagination listing={listing} />
    </>
  );
}
export function CreateForm({
  reservation: initialReservation,
}: {
  reservation?: Reservation;
}) {
  // Keep the version tied to this form's original values across route refreshes.
  const [reservation] = useState(initialReservation);
  const [conflict, setConflict] = useState(false);
  const localTime = reservation
    ? new Date(Date.parse(reservation.scheduledAt) + 8 * 3600000).toISOString()
    : "";
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  return (
    <div className="mx-auto max-w-2xl">
      <Back />
      <p className="eyebrow mt-8">
        {reservation ? "EDIT YOUR PARTY" : "CREATE A PARTY"}
      </p>
      <h1 className="mb-3 mt-3 text-3xl font-bold">
        {reservation ? "编辑预约" : "下一局，你来发起"}
        <span className="text-lime-300">.</span>
      </h1>
      <p className="mb-8 text-sm text-zinc-400">
        {reservation
          ? "修改后分享链接保持不变，已报名的队友会保留。"
          : "填好开局信息，分享链接就能召集队友。"}
      </p>
      <form
        className="panel space-y-6 p-6 sm:p-8"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          setError("");
          const date = new Date(
            `${form.get("date")}T${form.get("time")}:00+08:00`,
          );
          const parsed = createSchema.safeParse({
            gameName: form.get("gameName"),
            hostName: form.get("hostName"),
            scheduledAt: isNaN(date.getTime()) ? "" : date.toISOString(),
            maxPlayers: Number(form.get("maxPlayers")),
            description: form.get("description"),
          });
          if (!parsed.success) {
            setError(parsed.error.issues[0].message);
            return;
          }
          startTransition(async () => {
            try {
              await ensureBrowserIdentity();
              const r = await request(
                reservation
                  ? `/api/reservations/${reservation.id}`
                  : "/api/reservations",
                reservation ? "PATCH" : "POST",
                reservation
                  ? { ...parsed.data, editVersion: reservation.editVersion }
                  : parsed.data,
                {
                  schema: z.object({ id: z.string().min(1) }),
                  ...(!reservation
                    ? { idempotencyKey: submissionKey(parsed.data) }
                    : {}),
                },
              );
              if (!reservation) clearSubmission();
              toast.success(
                reservation ? "预约已更新" : "预约已创建，你已加入接龙",
              );
              router.push(`/reservation/${r.id}`);
              router.refresh();
            } catch (e) {
              setError((e as Error).message);
              if (
                e instanceof ClientRequestError &&
                e.serverCode === "EDIT_CONFLICT"
              )
                setConflict(true);
            }
          });
        }}
      >
        <Field title="游戏名称">
          <Input
            name="gameName"
            defaultValue={reservation?.gameName}
            placeholder="例如：Valorant / 无畏契约"
            maxLength={80}
            required
          />
        </Field>
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Field title="预约日期">
            <Input
              type="date"
              name="date"
              defaultValue={localTime.slice(0, 10)}
              required
            />
          </Field>
          <Field title="开玩时间 · 北京时间">
            <Input
              type="time"
              name="time"
              defaultValue={localTime.slice(11, 16)}
              required
            />
          </Field>
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field title="发起人昵称">
            <Input
              name="hostName"
              defaultValue={reservation?.hostName}
              placeholder="队友怎么称呼你？"
              maxLength={24}
              required
            />
          </Field>
          <Field title="最大参与人数 · 含发起人">
            <Input
              name="maxPlayers"
              type="number"
              min={Math.max(2, reservation?.participants.length ?? 0)}
              max={100}
              defaultValue={reservation?.maxPlayers ?? 5}
              required
            />
          </Field>
        </div>
        <Field title="备注（选填）">
          <textarea
            name="description"
            defaultValue={reservation?.description}
            className="field min-h-28 resize-y"
            maxLength={1000}
            placeholder="游戏模式、语音方式，或想对队友说的话…"
          />
        </Field>
        <p className="text-xs text-zinc-500">
          {reservation
            ? "人数上限不能小于当前报名人数。"
            : "发起人将自动占用一个名额。"}
          昵称最多 24 字，备注最多 1000 字。
        </p>
        {error && (
          <p role="alert" className="text-sm text-red-400">
            {error}
          </p>
        )}
        {conflict && reservation && (
          <div className="space-y-3 rounded-xl border border-amber-300/30 bg-amber-300/5 p-4">
            <p className="text-sm text-zinc-300">
              输入尚未提交。可先在新窗口查看最新预约，再复制需要保留的内容；重新加载会清除当前未保存的输入。
            </p>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline">
                <a
                  href={`/reservation/${reservation.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  查看最新预约（新窗口）
                </a>
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  if (
                    window.confirm(
                      "重新加载会清除当前未保存的输入。请先复制需要保留的内容，确定继续？",
                    )
                  )
                    window.location.reload();
                }}
              >
                重新加载编辑表单
              </Button>
            </div>
          </div>
        )}
        <Button className="w-full" disabled={pending || conflict}>
          {pending ? <Loader2 className="animate-spin" /> : <Zap />}
          {pending
            ? "正在保存…"
            : reservation
              ? "保存修改"
              : "创建预约，召集队友"}
        </Button>
      </form>
    </div>
  );
}
function Field({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-2.5">
      <span className="text-sm font-medium text-zinc-300">{title}</span>
      {children}
    </label>
  );
}
function Back() {
  return (
    <Link
      href="/"
      className="inline-flex items-center gap-2 text-sm text-zinc-400 hover:text-white"
    >
      <ArrowLeft size={16} />
      返回预约大厅
    </Link>
  );
}
export function ReservationDetail({
  reservation: r,
  admin = false,
}: {
  reservation: Reservation;
  admin?: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  useReservationRefresh(true, pending);
  const me = r.participants.find((p) => p.isMe);
  const state = getStatus(r, r.participants.length);
  function mutate(method: "POST" | "DELETE") {
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
          `/api/reservations/${r.id}/participants`,
          method,
          method === "POST" ? { name } : undefined,
        );
        toast.success(method === "POST" ? "加入成功，开局见！" : "已退出接龙");
        setName("");
        router.refresh();
      } catch (e) {
        setError((e as Error).message);
        router.refresh();
      }
    });
  }
  return (
    <>
      <Back />
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
        <ReservationShare reservation={r} />
        {(r.isHost || admin) && !["STARTED", "CANCELLED"].includes(state) && (
          <CancelReservation id={r.id} />
        )}
        {(r.isHost || admin) && !["STARTED", "CANCELLED"].includes(state) && (
          <Button asChild variant="outline">
            <Link href={`/reservation/${r.id}/edit`}>编辑预约</Link>
          </Button>
        )}
      </div>
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
                </span>
                <Check size={16} className="shrink-0 text-zinc-500" />
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
                    pending || state === "STARTED" || state === "CANCELLED"
                  }
                  onClick={() => mutate("DELETE")}
                >
                  {pending ? "正在退出…" : "退出接龙"}
                </Button>
              </>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  mutate("POST");
                }}
              >
                <Field title="你的昵称">
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={24}
                    placeholder="输入昵称，加入这一局"
                    required
                    disabled={state !== "OPEN" || pending}
                  />
                </Field>
                <Button
                  className="mt-4 w-full"
                  disabled={state !== "OPEN" || pending}
                >
                  {pending ? <Loader2 className="animate-spin" /> : <Plus />}
                  {pending
                    ? "正在加入…"
                    : state === "OPEN"
                      ? "加入接龙"
                      : statusLabels[state]}
                </Button>
              </form>
            )}
            {error && (
              <p role="alert" className="mt-3 text-sm text-red-400">
                {error}
              </p>
            )}
            <p className="mt-4 text-xs leading-6 text-zinc-500">
              无需注册。本浏览器会记住你的报名身份；请用同一浏览器退出接龙。
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}
