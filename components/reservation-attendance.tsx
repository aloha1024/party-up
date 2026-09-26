"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "./ui/button";
import { request } from "../lib/client-request";
import { ensureBrowserIdentity } from "../lib/browser-identity";
import { attendanceOpensAt } from "../lib/reservation-attendance";
import { formatTime } from "../lib/utils";
import type { Reservation } from "../types/reservation";

export function ReservationAttendance({
  reservation: r,
  admin,
  onPendingChange,
}: {
  reservation: Reservation;
  admin: boolean;
  onPendingChange: (value: boolean) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  useEffect(() => {
    onPendingChange(pending);
    return () => onPendingChange(false);
  }, [pending, onPendingChange]);
  const me = r.participants.find((p) => p.isMe);
  // A newer server version confirms what happened after an ambiguous response.
  useEffect(() => {
    setError("");
  }, [r.id, r.editVersion, me?.id, me?.attendanceVersion]);
  const opens = attendanceOpensAt(r.scheduledAt);
  const closed = r.status === "CANCELLED" || r.status === "ENDED";
  const ready = Date.now() >= opens.getTime();
  function perform(completion = false) {
    if (
      completion &&
      !window.confirm(
        r.status === "ENDED"
          ? "确定撤销结束？已有到场记录保留，参与者可继续确认到场。"
          : "确定结束预约？结束后将锁定到场确认，可由发起人或管理员撤销。",
      )
    )
      return;
    start(async () => {
      setError("");
      try {
        if (!navigator.onLine)
          throw new Error("当前离线，请联网后核对最新状态再操作");
        await ensureBrowserIdentity();
        await request(
          `/api/reservations/${r.id}/${completion ? "completion" : "attendance"}`,
          completion ? (r.status === "ENDED" ? "DELETE" : "POST") : "PATCH",
          completion
            ? { editVersion: r.editVersion }
            : {
                participantId: me!.id,
                checkedIn: !me!.checkedInAt,
                attendanceVersion: me!.attendanceVersion ?? 0,
                editVersion: r.editVersion,
              },
        );
        if (navigator.onLine) router.refresh();
      } catch (e) {
        setError((e as Error).message + " 本操作不会自动重发。");
      }
    });
  }
  return (
    <section
      className="panel mb-6 space-y-4 p-6"
      aria-label="到场确认与结束状态"
    >
      <h2 className="font-semibold">到场确认</h2>
      <p className="text-sm text-zinc-300">
        已到场 {r.participants.filter((p) => p.checkedInAt).length}／正式报名{" "}
        {r.participants.length} 人
      </p>
      {!closed && !ready && (
        <p className="text-sm text-zinc-400">
          {formatTime(opens.toISOString())}
          （北京时间）开放确认，开局后仍可补确认。
        </p>
      )}
      {closed && (
        <p className="text-sm text-zinc-400">
          预约已{r.status === "ENDED" ? "结束" : "取消"}，到场确认已锁定。
        </p>
      )}
      {r.endedAt && (
        <p className="text-sm text-zinc-400">
          结束时间：{formatTime(r.endedAt)}（北京时间）
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        {me && !closed && ready && (
          <Button disabled={pending} onClick={() => perform()}>
            {me.checkedInAt ? "撤销到场确认" : "确认到场"}
          </Button>
        )}
        {(r.isHost || admin) && ["STARTED", "ENDED"].includes(r.status) && (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => perform(true)}
          >
            {r.status === "ENDED" ? "撤销结束" : "结束预约"}
          </Button>
        )}
        {error && (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => {
              if (navigator.onLine) router.refresh();
            }}
          >
            刷新核对状态
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
    </section>
  );
}
