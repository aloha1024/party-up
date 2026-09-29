import { useCallback, useEffect, useRef, useState } from "react";
import { catchUpHistory, mergeHistory } from "../lib/reservation-history";

type Page<T> = { items: T[]; nextBefore: number | null };

export function useHistoryPagination<T extends { id: number }>({
  latest,
  paused,
  loadPage,
  fallbackError,
  isPermissionError,
  onRevoked,
}: {
  latest: Page<T>;
  paused: boolean;
  loadPage: (before: number, isCurrent: () => boolean) => Promise<Page<T>>;
  fallbackError: string;
  isPermissionError?: (error: unknown) => boolean;
  onRevoked?: () => void;
}) {
  const [page, setPage] = useState(latest);
  const current = useRef(page);
  const accepted = useRef(latest.items[0]?.id);
  const [more, setMore] = useState(0);
  const consumedMore = useRef(0);
  const failedMore = useRef(false);
  const [retryCount, setRetryCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const revoked = useRef(false);

  useEffect(() => {
    const run = ++generation.current;
    let alive = true;
    const isCurrent = () => alive && generation.current === run;
    const needsLatest = accepted.current !== latest.items[0]?.id;
    const needsMore = more !== consumedMore.current;
    if (paused || revoked.current || (!needsLatest && !needsMore)) {
      setBusy(false);
      return;
    }
    const load = async (before: number) => {
      if (!isCurrent()) throw new Error("记录加载已取消");
      if (!navigator.onLine) throw new Error("当前离线，请恢复网络后重试");
      const result = await loadPage(before, isCurrent);
      if (!isCurrent()) throw new Error("记录加载已取消");
      return result;
    };
    setBusy(true);
    setError("");
    void (async () => {
      try {
        let next = needsLatest
          ? await catchUpHistory(latest, current.current, load)
          : current.current;
        if (needsMore && next.nextBefore !== null) {
          const older = await load(next.nextBefore);
          next = {
            items: mergeHistory(next.items, older.items),
            nextBefore: older.nextBefore,
          };
        }
        if (!isCurrent()) return;
        current.current = next;
        accepted.current = latest.items[0]?.id;
        consumedMore.current = more;
        failedMore.current = false;
        setPage(next);
      } catch (e) {
        if (!isCurrent()) return;
        if (isPermissionError?.(e)) {
          revoked.current = true;
          current.current = { items: [], nextBefore: null };
          setPage(current.current);
          onRevoked?.();
        } else {
          // A failed click is consumed. Reconnecting may catch up new history,
          // but only an explicit retry may request that older page again.
          if (needsMore) {
            consumedMore.current = more;
            failedMore.current = true;
          }
          setError(e instanceof Error ? e.message : fallbackError);
        }
      } finally {
        if (isCurrent()) setBusy(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [
    latest,
    paused,
    more,
    retryCount,
    loadPage,
    fallbackError,
    isPermissionError,
    onRevoked,
  ]);

  const loadMore = useCallback(() => setMore((n) => n + 1), []);
  const retry = useCallback(() => {
    if (failedMore.current) setMore((n) => n + 1);
    else setRetryCount((n) => n + 1);
  }, []);
  return { page, busy, error, loadMore, retry };
}
