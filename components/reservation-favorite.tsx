"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Bookmark } from "lucide-react";
import { RegisteredFeature } from "./identity-provider";
import { Button } from "./ui/button";
import { request } from "../lib/client-request";
import {
  favoriteResultSchema,
  type FavoriteStatus,
} from "../lib/reservation-favorites";

export function ReservationFavorite({
  id,
  favorite,
  refreshSample,
  onPendingChange,
}: {
  id: string;
  favorite: FavoriteStatus | null;
  refreshSample: string;
  onPendingChange: (value: boolean) => void;
}) {
  const router = useRouter();
  const [hydrated, setHydrated] = useState(false);
  const [saved, setSaved] = useState(favorite?.saved ?? false);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const lifetime = useRef(0);
  const inFlight = useRef(false);
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
  useEffect(() => {
    setSaved(favorite?.saved ?? false);
    // An automatic refresh can have read its snapshot before an uncertain
    // write. Keep the warning until the user explicitly checks or acts again.
  }, [id, refreshSample, favorite?.saved]);

  function toggle() {
    if (
      !hydrated ||
      pending ||
      inFlight.current ||
      !favorite ||
      (!saved && !favorite.allowed)
    )
      return;
    const revision = lifetime.current;
    const isCurrent = () => lifetime.current === revision;
    inFlight.current = true;
    start(async () => {
      setError("");
      try {
        if (!navigator.onLine)
          throw new Error("当前离线，请联网后核对最新收藏状态再操作");
        const result = await request(
          `/api/reservations/${id}/favorite`,
          saved ? "DELETE" : "POST",
          undefined,
          { schema: favoriteResultSchema, isCurrent },
        );
        if (!isCurrent()) return;
        setSaved(result.saved);
        if (navigator.onLine) router.refresh();
      } catch (e) {
        if (isCurrent())
          setError((e as Error).message + " 本操作不会自动重发。");
      } finally {
        inFlight.current = false;
      }
    });
  }

  return (
    <RegisteredFeature label="收藏预约">
      <section aria-label="预约收藏" className="min-w-0 max-w-xs space-y-2">
        <Button
          type="button"
          variant="outline"
          aria-pressed={saved}
          disabled={
            !hydrated || pending || !favorite || (!saved && !favorite.allowed)
          }
          onClick={toggle}
        >
          <Bookmark
            className={saved ? "fill-lime-300 text-lime-300" : undefined}
          />
          {pending ? "正在保存…" : saved ? "取消收藏" : "收藏预约"}
        </Button>
        {!favorite ? (
          <p className="text-xs text-zinc-400">
            收藏状态暂不可用，请刷新后核对。
          </p>
        ) : !favorite.allowed && !saved ? (
          <p className="text-xs text-zinc-400">须有有效邀请才能收藏</p>
        ) : null}
        {error && (
          <p role="alert" className="break-words text-sm text-red-400">
            {error}
          </p>
        )}
        {(error || !favorite) && (
          <Button
            type="button"
            variant="outline"
            disabled={!hydrated || pending}
            onClick={() => {
              if (!navigator.onLine) {
                setError("当前离线，请联网后核对最新收藏状态再操作");
                return;
              }
              setError("");
              start(() => router.refresh());
            }}
          >
            刷新核对收藏状态
          </Button>
        )}
      </section>
    </RegisteredFeature>
  );
}
