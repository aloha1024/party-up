"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { Button } from "./ui/button";
import { request } from "../lib/client-request";
import { ensureBrowserIdentity } from "../lib/browser-identity";
import type { Reservation } from "../types/reservation";

export function ReservationRecruitment({
  reservation: r,
  disabled,
  onPendingChange,
}: {
  reservation: Reservation;
  disabled: boolean;
  onPendingChange: (value: boolean) => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function toggle() {
    if (pending || disabled) return;
    if (!navigator.onLine) {
      setError("当前离线，请联网后重新确认操作");
      return;
    }
    const paused = !r.recruitmentPaused;
    if (
      !window.confirm(
        paused
          ? "暂停招募？新报名、新候补和自动递补都将暂停，已有名单与队列保留。"
          : "恢复招募？将先按候补顺序补齐空位，再接收新报名。",
      )
    )
      return;
    setPending(true);
    onPendingChange(true);
    setError("");
    try {
      await ensureBrowserIdentity();
      await request(
        `/api/reservations/${r.id}/recruitment`,
        "PATCH",
        { paused, editVersion: r.editVersion },
        { schema: z.object({ id: z.string() }) },
      );
      if (navigator.onLine) router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
      onPendingChange(false);
    }
  }
  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        disabled={disabled || pending}
        onClick={() => void toggle()}
      >
        {pending ? "正在处理…" : r.recruitmentPaused ? "恢复招募" : "暂停招募"}
      </Button>
      {error && (
        <p role="alert" className="max-w-sm text-sm text-red-300">
          {error} 操作不会自动重发，请先刷新核对结果。
        </p>
      )}
    </div>
  );
}
