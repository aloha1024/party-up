"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import { request } from "../lib/client-request";
import {
  catchUpHistory,
  historyPageSchema,
  mergeHistory,
  type HistoryPage,
} from "../lib/reservation-history";

const time = (value: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
const labels = {
  gameName: "游戏名称",
  hostName: "发起人昵称",
  description: "备注",
  scheduledAt: "开玩时间",
  maxPlayers: "人数上限",
};

export function ReservationHistory({
  id,
  latest,
  paused,
}: {
  id: string;
  latest: HistoryPage;
  paused: boolean;
}) {
  const [page, setPage] = useState(latest);
  const current = useRef(page);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [more, setMore] = useState(0);
  const consumedMore = useRef(0);
  const failedMore = useRef(false);
  const generation = useRef(0);
  const accepted = useRef(latest.items[0]?.id);

  useEffect(() => {
    const run = ++generation.current;
    let alive = true;
    const needsLatest = accepted.current !== latest.items[0]?.id;
    const needsMore = more !== consumedMore.current;
    if (paused || (!needsLatest && !needsMore)) {
      setBusy(false);
      return;
    }
    const load = async (before: number) => {
      if (!alive || generation.current !== run)
        throw new Error("记录加载已取消");
      if (!navigator.onLine) throw new Error("当前离线，请恢复网络后重试");
      return request(
        `/api/reservations/${encodeURIComponent(id)}/history?before=${before}`,
        "GET",
        undefined,
        { schema: historyPageSchema },
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
        consumedMore.current = more;
        failedMore.current = false;
        setPage(next);
      } catch (e) {
        if (alive) {
          // A failed manual page load waits for another explicit click. A
          // reconnect refresh must not silently replay that click.
          if (needsMore) {
            consumedMore.current = more;
            failedMore.current = true;
          }
          setError(e instanceof Error ? e.message : "记录加载失败，请重试");
        }
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [id, latest, paused, retry, more]);

  return (
    <section
      aria-label="变更记录"
      className="mt-6 rounded-2xl border border-white/10 bg-zinc-900/60 p-5 sm:p-6"
    >
      <h2 className="text-lg font-semibold">变更记录</h2>
      <p className="mt-2 text-xs text-zinc-500">
        时间均为北京时间；仅公开操作者角色，不保存昵称和备注的历史内容。
      </p>
      {!page.items.length && (
        <p className="mt-4 text-sm text-zinc-400">
          暂无变更记录，仅记录功能启用后的修改
        </p>
      )}
      <ol className="mt-4 space-y-4">
        {page.items.map((item) => (
          <li
            key={item.id}
            data-change-id={item.id}
            className="border-t border-white/10 pt-4 text-sm"
          >
            <p className="text-zinc-400">
              <time dateTime={item.createdAt}>{time(item.createdAt)}</time> ·{" "}
              {item.actorRole === "ADMIN" ? "管理员" : "发起人"}
            </p>
            {item.action !== "EDIT" ? (
              <p className="mt-2">
                {
                  {
                    CANCEL: "预约已取消",
                    END: "预约已结束",
                    REOPEN: "已撤销结束",
                  }[item.action]
                }
              </p>
            ) : (
              <ul className="mt-2 space-y-1">
                {item.fields.map((field) => (
                  <li key={field}>
                    {labels[field]}：
                    {field === "scheduledAt" &&
                    item.scheduledAtBefore &&
                    item.scheduledAtAfter
                      ? `${time(item.scheduledAtBefore)} → ${time(item.scheduledAtAfter)}`
                      : field === "maxPlayers"
                        ? `${item.maxPlayersBefore} 人 → ${item.maxPlayersAfter} 人`
                        : "已修改"}
                  </li>
                ))}
              </ul>
            )}
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
          重试加载记录
        </Button>
      ) : (
        page.nextBefore !== null && (
          <Button
            key="more"
            className="mt-4"
            disabled={busy || paused}
            onClick={() => setMore((n) => n + 1)}
          >
            {busy ? "正在加载…" : "加载更早记录"}
          </Button>
        )
      )}
    </section>
  );
}
