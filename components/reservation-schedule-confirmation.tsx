"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { Button } from "./ui/button";
import { request } from "../lib/client-request";
import { getClientIdentityRevision } from "../lib/client-identity";
import { formatTime } from "../lib/utils";
import type { Reservation } from "../types/reservation";

export function ReservationScheduleConfirmation({
  reservation: r,
  disabled,
  onPendingChange,
}: {
  reservation: Reservation;
  disabled: boolean;
  onPendingChange: (value: boolean) => void;
}) {
  const router = useRouter();
  const [hydrated, setHydrated] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  const [acknowledged, setAcknowledged] = useState("");
  const lifetime = useRef(0);
  const inFlight = useRef(false);
  const me = r.participants.find((p) => p.isMe);
  const version = r.scheduleVersion ?? 0;
  const currentKey = `${r.id}:${version}:${me?.id ?? ""}`;
  const activeKey = useRef(currentKey);
  activeKey.current = currentKey;
  useEffect(() => {
    setHydrated(true);
    return () => {
      lifetime.current++;
    };
  }, []);
  useEffect(() => {
    onPendingChange(pending);
    return () => onPendingChange(false);
  }, [pending, onPendingChange]);
  const locked =
    ["STARTED", "CANCELLED", "ENDED"].includes(r.status) ||
    (hydrated && Date.now() >= Date.parse(r.scheduledAt));
  const confirmed = !!me?.scheduleConfirmed || acknowledged === currentKey;

  function confirm() {
    if (
      !hydrated ||
      disabled ||
      pending ||
      inFlight.current ||
      !me ||
      !version ||
      locked ||
      confirmed
    )
      return;
    const revision = lifetime.current;
    const identityRevision = getClientIdentityRevision();
    const key = currentKey;
    const isCurrent = () =>
      lifetime.current === revision &&
      activeKey.current === key &&
      getClientIdentityRevision() === identityRevision;
    inFlight.current = true;
    start(async () => {
      setError("");
      try {
        if (!navigator.onLine)
          throw new Error("当前离线，请联网后核对最新开玩时间再确认");
        const result = await request(
          `/api/reservations/${r.id}/schedule-confirmation`,
          "PATCH",
          { participantId: me.id, scheduleVersion: version },
          {
            schema: z.object({
              id: z.literal(r.id),
              scheduleVersion: z.number().int().nonnegative().safe(),
              participants: z.array(
                z.object({
                  id: z.string(),
                  isMe: z.boolean(),
                  scheduleConfirmed: z.boolean(),
                }),
              ),
            }),
            isCurrent,
          },
        );
        if (!isCurrent()) return;
        if (
          result.scheduleVersion === version &&
          result.participants.some(
            (p) => p.id === me.id && p.isMe && p.scheduleConfirmed,
          )
        ) {
          setAcknowledged(key);
        } else {
          setAcknowledged("");
          setError(
            "开玩时间或名单已变化，请刷新后重新确认。本操作不会自动重发。",
          );
        }
        if (navigator.onLine) router.refresh();
      } catch (e) {
        if (isCurrent())
          setError((e as Error).message + " 本操作不会自动重发。");
      } finally {
        inFlight.current = false;
      }
    });
  }

  if (!version) return null;
  return (
    <section aria-label="改期确认" className="panel mb-6 space-y-4 p-6">
      <h2 className="font-semibold">改期后确认参加</h2>
      <p className="text-sm text-zinc-300">
        新开玩时间：{formatTime(r.scheduledAt)}（北京时间）
      </p>
      <p className="text-sm text-zinc-400">
        已认可新时间 {r.participants.filter((p) => p.scheduleConfirmed).length}
        ／正式报名 {r.participants.length}{" "}
        人。未确认仍保留名额，不代表缺席，也不影响到场确认。
      </p>
      <p className="text-sm text-zinc-400">
        仅正式参与者可在新开局前确认，发起人也需本人操作。候补无需确认；改期前加入的候补在递补后需确认新时间。
      </p>
      {me && (
        <p
          className={`text-sm ${confirmed ? "text-lime-300" : "text-amber-300"}`}
        >
          {confirmed
            ? me.scheduleConfirmedAt
              ? `你已确认新时间 · ${formatTime(me.scheduleConfirmedAt)}（北京时间）`
              : acknowledged === currentKey
                ? "你已确认新时间"
                : "你在报名时已认可新时间"
            : "你尚未确认改期。若无法参加，请在开局前使用现有退出接龙入口。"}
        </p>
      )}
      {locked && (
        <p className="text-sm text-zinc-400">
          {r.status === "CANCELLED"
            ? "预约已取消，改期确认已锁定。"
            : r.status === "ENDED"
              ? "预约已结束，改期确认已锁定。"
              : "预约已开始，改期确认已锁定，未确认记录保留。"}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        {me && !confirmed && !locked && (
          <Button
            type="button"
            disabled={!hydrated || disabled || pending}
            onClick={confirm}
          >
            {pending ? "正在确认…" : "确认新时间，继续参加"}
          </Button>
        )}
        {error && (
          <Button
            type="button"
            variant="outline"
            disabled={!hydrated || disabled || pending}
            onClick={() => {
              if (!navigator.onLine) {
                setError("当前离线，请联网后核对最新开玩时间再确认");
                return;
              }
              setError("");
              start(() => router.refresh());
            }}
          >
            刷新核对改期状态
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="break-words text-sm text-red-400">
          {error}
        </p>
      )}
    </section>
  );
}
