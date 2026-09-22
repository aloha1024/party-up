"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { formatTime } from "@/lib/utils";
type Item = {
  id: string;
  gameName: string;
  hostName: string;
  deletedAt: string;
  participantCount: number;
};
export function ReservationTrash({ reservations }: { reservations: Item[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  function action(item: Item, method: "POST" | "DELETE") {
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
        const response = await fetch("/api/admin/trash/" + item.id, { method });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "操作失败");
        toast.success(
          method === "POST"
            ? "预约已恢复，原链接和名单已保留"
            : "预约已永久删除",
        );
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "请求失败");
      }
    });
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-400">
        移入回收站的预约不再公开展示。恢复保留原链接、报名名单及取消状态；已过期的预约恢复后仍为已开始。
      </p>
      {error && (
        <p role="alert" className="text-red-400">
          {error}
        </p>
      )}
      {reservations.map((item) => (
        <div
          key={item.id}
          className="panel flex flex-wrap items-center justify-between gap-4 p-5"
        >
          <div className="min-w-0">
            <h2 className="break-all font-semibold">{item.gameName}</h2>
            <p className="mt-2 text-sm text-zinc-400">
              {item.hostName} · {item.participantCount} 人 ·{" "}
              {formatTime(item.deletedAt)} 移入
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
      {!reservations.length && (
        <p className="panel p-8 text-center text-zinc-400">回收站为空</p>
      )}
    </div>
  );
}
