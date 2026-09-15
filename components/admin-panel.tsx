"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatTime } from "@/lib/utils";
import type { Reservation } from "@/types/reservation";
export function AdminPanel({
  authenticated,
  reservations,
}: {
  authenticated: boolean;
  reservations: Reservation[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  function action(url: string, method: string, body?: unknown) {
    setError("");
    start(async () => {
      try {
        const response = await fetch(url, {
          method,
          headers: { "Content-Type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "操作失败，请重试");
        toast.success(
          method === "POST"
            ? "管理员登录成功"
            : url.includes("/reservations/")
              ? "预约已删除"
              : "已退出登录",
        );
        router.refresh();
      } catch (e) {
        setError((e as Error).message);
        router.refresh();
      }
    });
  }
  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/" className="text-sm text-zinc-400">
        ← 返回预约大厅
      </Link>
      <div className="my-8 flex items-center justify-between gap-4">
        <h1 className="text-3xl font-bold">预约管理</h1>
        {authenticated && (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => action("/api/admin/session", "DELETE")}
          >
            退出登录
          </Button>
        )}
      </div>
      {error && (
        <p className="mb-5 text-sm text-red-400" role="alert">
          {error}
        </p>
      )}
      {!authenticated ? (
        <form
          className="panel mx-auto max-w-md space-y-5 p-6"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            action("/api/admin/session", "POST", {
              username: form.get("username"),
              password: form.get("password"),
            });
          }}
        >
          <h2 className="text-xl font-semibold">管理员登录</h2>
          <label className="block space-y-2">
            <span>账号</span>
            <Input
              name="username"
              autoComplete="username"
              maxLength={64}
              required
            />
          </label>
          <label className="block space-y-2">
            <span>密码</span>
            <Input
              name="password"
              type="password"
              autoComplete="current-password"
              maxLength={256}
              required
            />
          </label>
          <Button className="w-full" disabled={pending}>
            {pending ? "正在登录…" : "登录"}
          </Button>
        </form>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-zinc-400">
            共 {reservations.length}{" "}
            场预约。删除会同时移除接龙名单，且无法撤销。
          </p>
          {reservations.map((r) => (
            <div
              className="panel flex flex-wrap items-center justify-between gap-4 p-5"
              key={r.id}
            >
              <div className="min-w-0">
                <Link
                  className="break-all text-lg font-semibold hover:text-lime-300"
                  href={`/reservation/${r.id}`}
                >
                  {r.gameName}
                </Link>
                <p className="mt-2 text-sm text-zinc-400">
                  {formatTime(r.scheduledAt)} · {r.hostName} ·{" "}
                  {r.participants.length}/{r.maxPlayers} 人
                </p>
              </div>
              <div className="flex gap-2">
                {!["STARTED", "CANCELLED"].includes(r.status) && (
                  <Button asChild variant="outline">
                    <Link href={`/reservation/${r.id}/edit`}>编辑预约</Link>
                  </Button>
                )}
                <Button
                  className="text-red-400 hover:text-red-300"
                  variant="outline"
                  disabled={pending}
                  onClick={() => {
                    if (
                      window.confirm(
                        `确定永久删除「${r.gameName}」及其全部接龙名单？此操作无法撤销。`,
                      )
                    )
                      action(`/api/admin/reservations/${r.id}`, "DELETE");
                  }}
                >
                  删除预约
                </Button>
              </div>
            </div>
          ))}
          {!reservations.length && (
            <p className="panel p-8 text-center text-zinc-400">暂无预约</p>
          )}
        </div>
      )}
    </div>
  );
}
