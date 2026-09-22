"use client";
import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { startAutoRefresh } from "@/lib/auto-refresh";
export function useReservationRefresh(enabled = true, paused = false) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const busy = useRef(false);
  useEffect(() => {
    busy.current = pending || paused;
  }, [pending, paused]);
  useEffect(() => {
    if (!enabled) return;
    return startAutoRefresh(
      () => {
        start(() => router.refresh());
      },
      () => busy.current,
      { window, document, navigator },
    );
  }, [enabled, router]);
}
