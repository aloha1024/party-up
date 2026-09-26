"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "./ui/button";
import { request, ClientRequestError } from "../lib/client-request";
import { catchUpHistory, mergeHistory } from "../lib/reservation-history";
import { removalPageSchema, type RemovalPage } from "../lib/roster-management";

export function RosterRemovalHistory({
  id,
  latest,
  scope,
  paused,
}: {
  id: string;
  latest: RemovalPage;
  scope: string;
  paused: boolean;
}) {
  const [page, setPage] = useState(latest);
  const current = useRef(page);
  const accepted = useRef(latest.items[0]?.id);
  const [more, setMore] = useState(0);
  const consumed = useRef(0);
  const failedMore = useRef(false);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const revoked = useRef(false);
  const router = useRouter();
  useEffect(() => {
    let alive = true;
    const needsLatest = accepted.current !== latest.items[0]?.id;
    const needsMore = more !== consumed.current;
    if (paused || revoked.current || (!needsLatest && !needsMore)) {
      setBusy(false);
      return;
    }
    const load = async (before: number) => {
      if (!alive) throw new Error("加载已取消");
      if (!navigator.onLine) throw new Error("当前离线，请恢复网络后重试");
      return request(
        `/api/reservations/${id}/roster-removals?before=${before}&scope=${scope}`,
        "GET",
        undefined,
        { schema: removalPageSchema },
      );
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
        if (!alive) return;
        current.current = next;
        accepted.current = latest.items[0]?.id;
        consumed.current = more;
        failedMore.current = false;
        setPage(next);
      } catch (e) {
        if (!alive) return;
        if (
          e instanceof ClientRequestError &&
          (e.serverCode === "VIEWER_CHANGED" ||
            e.status === 404 ||
            e.status === 401 ||
            e.status === 403)
        ) {
          revoked.current = true;
          current.current = { items: [], nextBefore: null };
          setPage(current.current);
          if (navigator.onLine) router.refresh();
        } else {
          if (needsMore) {
            consumed.current = more;
            failedMore.current = true;
          }
          setError(e instanceof Error ? e.message : "加载失败，请重试");
        }
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [id, latest, scope, paused, more, retry, router]);
  if (!page.items.length) return null;
  return (
    <section aria-label="报名移除记录" className="panel mt-6 p-5 sm:p-6">
      <h2 className="text-lg font-semibold">报名移除记录</h2>
      <p className="mt-2 text-xs leading-6 text-zinc-400">
        仅显示你有权查看的记录。时间为北京时间；被移除后仍可重新加入，原位置不保留。
      </p>
      <ol className="mt-4 space-y-4">
        {page.items.map((item) => (
          <li
            key={item.id}
            data-removal-id={item.id}
            className="border-t border-white/10 pt-4 text-sm"
          >
            <p className="text-zinc-400">
              {new Intl.DateTimeFormat("zh-CN", {
                timeZone: "Asia/Shanghai",
                dateStyle: "medium",
                timeStyle: "medium",
                hour12: false,
              }).format(new Date(item.createdAt))}{" "}
              · {item.actorRole === "ADMIN" ? "管理员" : "发起人"}
            </p>
            <p className="mt-2 break-words">
              {item.targetName} · 已移除
              {item.kind === "participants" ? "正式报名" : "候补"}
            </p>
            <p className="mt-2 whitespace-pre-wrap break-words text-zinc-300">
              原因：{item.reason}
            </p>
          </li>
        ))}
      </ol>
      {error && (
        <p role="alert" className="mt-4 text-sm text-red-400">
          {error}
        </p>
      )}
      {error ? (
        <Button
          key="retry"
          className="mt-4"
          disabled={busy || paused}
          onClick={() =>
            failedMore.current ? setMore((n) => n + 1) : setRetry((n) => n + 1)
          }
        >
          重试加载移除记录
        </Button>
      ) : (
        page.nextBefore !== null && (
          <Button
            key="more"
            className="mt-4"
            disabled={busy || paused}
            onClick={() => setMore((n) => n + 1)}
          >
            {busy ? "正在加载…" : "加载更早移除记录"}
          </Button>
        )
      )}
    </section>
  );
}
