"use client";
import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "./ui/button";
import { useHistoryPagination } from "./use-history-pagination";
import { request, ClientRequestError } from "../lib/client-request";
import { removalPageSchema, type RemovalPage } from "../lib/roster-management";

function isPermissionError(error: unknown) {
  return (
    error instanceof ClientRequestError &&
    (error.serverCode === "VIEWER_CHANGED" ||
      error.status === 404 ||
      error.status === 401 ||
      error.status === 403)
  );
}

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
  const router = useRouter();
  const loadPage = useCallback(
    (before: number, isCurrent: () => boolean) =>
      request(
        `/api/reservations/${id}/roster-removals?before=${before}&scope=${scope}`,
        "GET",
        undefined,
        { schema: removalPageSchema, isCurrent },
      ),
    [id, scope],
  );
  const onRevoked = useCallback(() => {
    if (navigator.onLine) router.refresh();
  }, [router]);
  const { page, busy, error, loadMore, retry } = useHistoryPagination({
    latest,
    paused,
    loadPage,
    fallbackError: "加载失败，请重试",
    isPermissionError,
    onRevoked,
  });
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
          onClick={retry}
        >
          重试加载移除记录
        </Button>
      ) : (
        page.nextBefore !== null && (
          <Button
            key="more"
            className="mt-4"
            disabled={busy || paused}
            onClick={loadMore}
          >
            {busy ? "正在加载…" : "加载更早移除记录"}
          </Button>
        )
      )}
    </section>
  );
}
