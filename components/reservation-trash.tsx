"use client";
import { request } from "@/lib/client-request";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useReservationRefresh } from "@/components/use-reservation-refresh";
import { TrashFilters, TrashPagination } from "@/components/trash-filters";
import type { TrashItem, TrashPage } from "@/types/reservation-trash";
const deletionDate = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
export function ReservationTrash({ listing }: { listing: TrashPage }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  useReservationRefresh(true, pending);
  function action(item: TrashItem, method: "POST" | "DELETE") {
    if (
      method === "DELETE" &&
      !window.confirm(
        "永久删除「" + item.gameName + "」及其全部报名？此操作无法撤销。",
      )
    )
      return;
    setError("");
    start(async () => {
      try {
        await request("/api/admin/trash/" + item.id, method);
        toast.success(
          method === "POST"
            ? "预约已恢复，原链接和名单已保留"
            : "预约已永久删除",
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "请求失败");
      } finally {
        router.refresh();
      }
    });
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-400">
        移入回收站的预约不再公开展示。恢复保留原链接、报名名单及取消状态；已过期的预约恢复后仍为已开始。
      </p>
      <TrashFilters listing={listing} />
      {error && (
        <p role="alert" className="text-red-400">
          {error}
        </p>
      )}
      {listing.items.map((item) => (
        <div
          key={item.id}
          className="panel flex flex-wrap items-center justify-between gap-4 p-5"
        >
          <div className="min-w-0">
            <h2 className="break-all font-semibold">{item.gameName}</h2>
            <p className="mt-2 text-sm text-zinc-400">
              {item.hostName} · {item.participantCount} 人 ·{" "}
              {deletionDate.format(new Date(item.deletedAt))} 移入（北京时间）
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button disabled={pending} onClick={() => action(item, "POST")}>
              恢复预约
            </Button>
            <Button
              variant="outline"
              className="text-red-400"
              disabled={pending}
              onClick={() => action(item, "DELETE")}
            >
              永久删除
            </Button>
          </div>
        </div>
      ))}
      {!listing.items.length && (
        <p className="panel p-8 text-center text-zinc-400">
          {listing.filters.q || listing.filters.date
            ? "没有符合筛选条件的预约，请调整或重置筛选"
            : "回收站为空"}
        </p>
      )}
      <TrashPagination listing={listing} />
    </div>
  );
}
