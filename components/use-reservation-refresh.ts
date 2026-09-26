"use client";
import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { startAutoRefresh, type RefreshSnapshot } from "@/lib/auto-refresh";

export function useReservationRefresh({
  sample,
  data,
  scope,
  scheduledAt = [],
  enabled = true,
  paused = false,
  fixed = false,
}: {
  sample: string;
  data: unknown;
  scope: string;
  scheduledAt?: string[];
  enabled?: boolean;
  paused?: boolean;
  fixed?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const driver = useRef<ReturnType<typeof startAutoRefresh> | null>(null);
  const latest = useRef<RefreshSnapshot>(null!);
  useEffect(() => {
    latest.current = {
      sample,
      signature: JSON.stringify(data),
      scope,
      scheduledAt: scheduledAt.map(Date.parse),
      paused,
      pending,
    };
    driver.current?.update(latest.current);
  });
  useEffect(() => {
    if (!enabled) return;
    const active = startAutoRefresh(
      () => start(() => router.refresh()),
      latest.current,
      { window, document, navigator },
      fixed,
    );
    driver.current = active;
    return () => {
      active.stop();
      driver.current = null;
    };
  }, [enabled, fixed, router]);
}
