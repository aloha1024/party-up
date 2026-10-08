"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "./ui/button";
import { request } from "../lib/client-request";
import { useReservationRefresh } from "./use-reservation-refresh";
import { formatTime } from "../lib/utils";

type Listing = {
  items: {
    id: number;
    reservationId: string | null;
    gameName: string;
    kind: string;
    createdAt: string;
    readAt: string | null;
  }[];
  total: number;
  page: number;
  pageCount: number;
  unreadCount: number;
};
const labels: Record<string, string> = {
  PROMOTED: "候补已递补",
  RESCHEDULED: "开玩时间已修改",
  CANCELLED: "预约已取消",
  REMOVED: "报名已被移除",
  MEETING_UPDATED: "集合信息已更新",
};
export function Notifications({
  listing,
  unread,
  sample,
}: {
  listing: Listing;
  unread: "all" | "unread";
  sample: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useReservationRefresh({
    sample,
    data: listing,
    scope: `${unread}:${listing.page}`,
    paused: pending,
  });
  async function mark(data: { id: number } | { all: true }) {
    if (pending) return;
    if (!navigator.onLine) {
      setError("当前离线，请联网后重试");
      return;
    }
    setPending(true);
    setError("");
    try {
      await request("/api/notifications", "PATCH", data);
      if (navigator.onLine) router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="mx-auto max-w-3xl space-y-5">
      <h1 className="text-3xl font-bold">我的提醒</h1>
      <p className="text-sm text-zinc-400">
        游客仅当前浏览器可查看，账号可跨设备查看。提醒在打开网站后更新，不发送站外通知。新功能启用前的变化不会补发。
      </p>
      <nav className="flex flex-wrap gap-3" aria-label="提醒筛选">
        <Button asChild variant={unread === "all" ? "default" : "outline"}>
          <Link href="/notifications" prefetch={false}>
            全部提醒
          </Link>
        </Button>
        <Button asChild variant={unread === "unread" ? "default" : "outline"}>
          <Link href="/notifications?unread=unread" prefetch={false}>
            未读提醒
          </Link>
        </Button>
        <Button
          variant="outline"
          disabled={pending || !listing.unreadCount}
          onClick={() => void mark({ all: true })}
        >
          全部标为已读
        </Button>
      </nav>
      <p className="text-sm text-zinc-400">
        未读 {listing.unreadCount} 条 · 当前筛选共 {listing.total} 条
      </p>
      {error && (
        <p role="alert" className="text-red-300">
          {error}
        </p>
      )}
      {!listing.items.length && (
        <p className="panel p-6">
          暂无提醒。创建或参加预约后，相关变化将在这里显示。
        </p>
      )}
      <ol className="space-y-3">
        {listing.items.map((item) => (
          <li
            key={item.id}
            data-notification-id={item.id}
            className="panel space-y-3 p-5"
          >
            <p className="text-sm text-zinc-400">
              {formatTime(item.createdAt)} · {item.readAt ? "已读" : "未读"}
            </p>
            <p className="font-semibold">
              {item.reservationId
                ? labels[item.kind] || "预约有新变化"
                : "预约已移除或查看权限已变化"}
            </p>
            {item.reservationId ? (
              <Link
                className="block break-words text-lime-300 underline"
                href={`/reservation/${item.reservationId}`}
              >
                {item.gameName}
              </Link>
            ) : (
              <p className="text-sm text-zinc-400">
                此提醒的预约内容暂不可查看。
              </p>
            )}
            {item.kind === "REMOVED" && item.reservationId && (
              <p className="text-sm text-zinc-400">
                进入详情查看仅本人及管理者可见的移除原因。
              </p>
            )}
            {!item.readAt && (
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => void mark({ id: item.id })}
              >
                标为已读
              </Button>
            )}
          </li>
        ))}
      </ol>
      <nav
        aria-label="提醒分页"
        className="flex items-center justify-between gap-3"
      >
        <span>
          {listing.page} / {listing.pageCount}
        </span>
        <div className="flex gap-3">
          {listing.page > 1 && (
            <Button asChild variant="outline">
              <Link
                prefetch={false}
                href={`/notifications?unread=${unread}&page=${listing.page - 1}`}
              >
                上一页
              </Link>
            </Button>
          )}
          {listing.page < listing.pageCount && (
            <Button asChild variant="outline">
              <Link
                prefetch={false}
                href={`/notifications?unread=${unread}&page=${listing.page + 1}`}
              >
                下一页
              </Link>
            </Button>
          )}
        </div>
      </nav>
    </section>
  );
}
