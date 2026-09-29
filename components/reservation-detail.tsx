"use client";
import { RegisteredFeature, useIdentity } from "./identity-provider";
import { InvitationEntry, InvitationManager } from "./reservation-invitation";
import { ReservationAttendance } from "./reservation-attendance";
import { ReservationRecruitment } from "./reservation-recruitment";
import { recruitmentClosure } from "../lib/recruitment";
import { attendanceOpensAt } from "../lib/reservation-attendance";
import { CancelReservation } from "@/components/cancel-reservation";
import { ReservationShare } from "@/components/reservation-share";
import { ReservationHistory } from "@/components/reservation-history";
import { RosterRemovalHistory } from "./roster-removal-history";
import { RosterActionDialog, type RosterAction } from "./roster-action-dialog";
import type { RemovalPage } from "../lib/roster-management";
import type { HistoryPage } from "@/lib/reservation-history";
import { Button } from "@/components/ui/button";
import { useReservationRefresh } from "@/components/use-reservation-refresh";
import { ensureBrowserIdentity } from "@/lib/browser-identity";
import { request } from "@/lib/client-request";
import { getStatus } from "@/lib/status";
import { formatTime } from "@/lib/utils";
import { joinSchema } from "@/lib/validation";
import type { Reservation } from "@/types/reservation";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import { Back, Badge } from "./reservation-ui";
import { ReservationRoster } from "./reservation-roster";
import { ReservationParticipation } from "./reservation-participation";

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
  const viewer = useIdentity();
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const [name, setName] = useState(viewer?.user?.nickname ?? "");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const [cancelling, setCancelling] = useState(false);
  const [attending, setAttending] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [managing, setManaging] = useState(false);
  const [recruiting, setRecruiting] = useState(false);
  const [action, setAction] = useState<RosterAction | null>(null);
  useEffect(() => {
    setAction(null);
  }, [r.id, removals.scope]);
  const refreshPaused =
    pending || cancelling || managing || inviting || attending || recruiting;
  useReservationRefresh({
    sample: refreshSample,
    data: { reservation: r, admin },
    scope: r.id,
    scheduledAt: [
      attendanceOpensAt(r.scheduledAt).toISOString(),
      r.scheduledAt,
      ...(r.registrationDeadline ? [r.registrationDeadline] : []),
    ],
    paused: refreshPaused,
    fixed: true,
  });
  const me = r.participants.find((p) => p.isMe);
  const waitingIndex = r.waitlist.findIndex((p) => p.isMe);
  const state = getStatus(r, r.participants.length);
  const closed = recruitmentClosure(r);
  const canWait = !closed && state === "FULL" && r.waitlist.length < 100;
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
          <RegisteredFeature label="再开一局">
            <Button asChild variant="outline">
              <Link
                href={`/reservation/new?from=${encodeURIComponent(r.id)}`}
                prefetch={false}
              >
                再开一局
              </Link>
            </Button>
          </RegisteredFeature>
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
      {(r.isHost || admin) &&
        !["STARTED", "CANCELLED", "ENDED"].includes(state) && (
          <div className="mb-6">
            <ReservationRecruitment
              reservation={r}
              disabled={
                pending || cancelling || managing || inviting || attending
              }
              onPendingChange={setRecruiting}
            />
          </div>
        )}
      {(closed || r.registrationDeadline || r.recruitmentPaused) && (
        <div role="status" className="panel mb-6 space-y-2 p-5">
          {closed && (
            <h2 className="font-semibold">
              {closed}
              {r.recruitmentPaused && closed === "报名已截止"
                ? " · 暂停招募"
                : ""}
            </h2>
          )}
          <p className="text-sm text-zinc-400">
            报名截止：
            {r.registrationDeadline
              ? `${formatTime(r.registrationDeadline)}（北京时间）`
              : "开局前均可报名"}
          </p>
          {closed && (
            <p className="text-sm text-zinc-400">
              新报名、新候补和自动递补已停止，已有名单与候补顺序保留。重新开放后按顺序递补。
            </p>
          )}
        </div>
      )}
      {state === "CANCELLED" && (
        <div role="status" className="panel mb-6 p-5">
          <h2 className="font-semibold">预约已取消</h2>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm text-zinc-400">
            {r.cancellationReason || "发起人或管理员已取消本次预约。"}
          </p>
        </div>
      )}
      <div className="grid items-start gap-6 lg:grid-cols-[1fr_340px]">
        <ReservationRoster
          reservation={r}
          admin={admin}
          state={state}
          closed={closed}
          disabled={pending || cancelling || managing}
          onAction={setAction}
        />
        <ReservationParticipation
          reservation={r}
          me={me}
          waitingIndex={waitingIndex}
          state={state}
          closed={closed}
          canWait={canWait}
          name={name}
          error={error}
          hydrated={hydrated}
          pending={pending}
          cancelling={cancelling}
          recruiting={recruiting}
          onNameChange={setName}
          onMutate={mutate}
        />
      </div>
      <ReservationHistory
        key={r.id}
        id={r.id}
        latest={history}
        paused={refreshPaused}
      />
      <RosterRemovalHistory
        key={`${r.id}:${removals.scope}`}
        id={r.id}
        scope={removals.scope}
        latest={removals}
        paused={refreshPaused}
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
