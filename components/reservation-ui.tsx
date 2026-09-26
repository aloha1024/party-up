"use client";
import { getStatus, statusLabels } from "@/lib/status";
import type { Reservation, ReservationSummary } from "@/types/reservation";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";

export function Badge({
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
      {r.visibility === "INVITE" ? "邀请制 · " : ""}
      {statusLabels[state]}
    </span>
  );
}
export function Field({
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
export function Back() {
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
