"use client";

import { useCallback } from "react";
import { Button } from "./ui/button";
import { useHistoryPagination } from "./use-history-pagination";
import { request } from "../lib/client-request";
import {
  historyPageSchema,
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
  registrationDeadline: "报名截止时间",
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
  const loadPage = useCallback(
    (before: number, isCurrent: () => boolean) =>
      request(
        `/api/reservations/${encodeURIComponent(id)}/history?before=${before}`,
        "GET",
        undefined,
        { schema: historyPageSchema, isCurrent },
      ),
    [id],
  );
  const { page, busy, error, loadMore, retry } = useHistoryPagination({
    latest,
    paused,
    loadPage,
    fallbackError: "记录加载失败，请重试",
  });

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
                    PAUSE: "已暂停招募",
                    RESUME: "已恢复招募",
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
                      : field === "registrationDeadline"
                        ? `${item.registrationDeadlineBefore ? time(item.registrationDeadlineBefore) : "开局前均可报名"} → ${item.registrationDeadlineAfter ? time(item.registrationDeadlineAfter) : "开局前均可报名"}`
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
          onClick={retry}
        >
          重试加载记录
        </Button>
      ) : (
        page.nextBefore !== null && (
          <Button
            key="more"
            className="mt-4"
            disabled={busy || paused}
            onClick={loadMore}
          >
            {busy ? "正在加载…" : "加载更早记录"}
          </Button>
        )
      )}
    </section>
  );
}
