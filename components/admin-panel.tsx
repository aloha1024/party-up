"use client";
import { z } from "zod";
import { request } from "@/lib/client-request";
import { FormEvent, type ReactNode, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatTime } from "@/lib/utils";
import {
  ReservationFilters,
  ReservationPagination,
} from "@/components/reservation-filters";
import { useReservationRefresh } from "@/components/use-reservation-refresh";
import type { ReservationSummary, ReservationPage } from "@/types/reservation";

export function AdminPanel({
  authenticated,
  reservations,
  listing,
  view = "reservations",
  canCreateAdmins = false,
  children,
  refreshSample = "",
}: {
  authenticated: boolean;
  reservations: ReservationSummary[];
  listing?: ReservationPage;
  view?: "reservations" | "password" | "accounts" | "trash" | "audit";
  canCreateAdmins?: boolean;
  children?: ReactNode;
  refreshSample?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  useReservationRefresh({
    sample: refreshSample,
    data: { listing, canCreateAdmins, authenticated },
    scope: JSON.stringify(listing?.filters),
    scheduledAt: reservations.map((r) => r.scheduledAt),
    enabled: authenticated && view === "reservations",
    paused: pending,
  });
  const [error, setError] = useState("");
  const [firstLogin, setFirstLogin] = useState(false);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");

  function run(task: () => Promise<void>) {
    setError("");
    start(async () => {
      try {
        await task();
      } catch (e) {
        setError((e as Error).message);
        router.refresh();
      }
    });
  }

  function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get("newPassword") || "");
    const confirmation = String(form.get("confirmation") || "");
    if (firstLogin && newPassword !== confirmation)
      return setError("两次输入的新密码不一致");
    run(async () => {
      const data = await request(
        "/api/admin/session",
        "POST",
        {
          username,
          password,
          ...(firstLogin ? { newPassword } : {}),
        },
        { schema: z.object({ requiresPasswordChange: z.boolean() }) },
      );
      if (data.requiresPasswordChange) {
        setFirstLogin(true);
        setError("");
        toast.info("首次登录，请设置新的管理员密码");
        return;
      }
      setPassword("");
      setFirstLogin(false);
      toast.success("管理员登录成功");
      router.refresh();
    });
  }

  function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const currentPassword = String(form.get("currentPassword") || "");
    const newPassword = String(form.get("newPassword") || "");
    if (newPassword !== String(form.get("confirmation") || ""))
      return setError("两次输入的新密码不一致");
    run(async () => {
      await request("/api/admin/session", "PATCH", {
        currentPassword,
        newPassword,
      });
      formElement.reset();
      toast.success("管理员密码已修改，其他设备的登录已失效");
      router.refresh();
    });
  }

  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/" className="text-sm text-zinc-400">
        ← 返回预约大厅
      </Link>
      <div className="my-8 flex items-center justify-between gap-4">
        <h1 className="text-3xl font-bold">
          {view === "audit"
            ? "操作记录"
            : view === "trash"
              ? "回收站"
              : view === "accounts"
                ? "管理员账号"
                : view === "password"
                  ? "修改管理员密码"
                  : "预约管理"}
        </h1>
        {authenticated && (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              run(async () => {
                await request("/api/admin/session", "DELETE");
                toast.success("已退出登录");
                router.refresh();
              })
            }
          >
            退出登录
          </Button>
        )}
      </div>
      {authenticated && (
        <nav aria-label="管理员导航" className="mb-6 flex flex-wrap gap-3">
          <Button
            asChild
            variant={view === "reservations" ? "default" : "outline"}
          >
            <Link
              href="/admin"
              aria-current={view === "reservations" ? "page" : undefined}
            >
              预约管理
            </Link>
          </Button>
          <Button asChild variant={view === "password" ? "default" : "outline"}>
            <Link
              href="/admin/password"
              aria-current={view === "password" ? "page" : undefined}
            >
              修改密码
            </Link>
          </Button>
          {canCreateAdmins && (
            <Button
              asChild
              variant={view === "accounts" ? "default" : "outline"}
            >
              <Link
                href="/admin/accounts"
                aria-current={view === "accounts" ? "page" : undefined}
              >
                管理员账号
              </Link>
            </Button>
          )}
          <Button asChild variant={view === "trash" ? "default" : "outline"}>
            <Link
              href="/admin/trash"
              aria-current={view === "trash" ? "page" : undefined}
            >
              回收站
            </Link>
          </Button>
          <Button asChild variant={view === "audit" ? "default" : "outline"}>
            <Link
              href="/admin/audit"
              aria-current={view === "audit" ? "page" : undefined}
            >
              操作记录
            </Link>
          </Button>
        </nav>
      )}
      {error && (
        <p className="mb-5 text-sm text-red-400" role="alert">
          {error}
        </p>
      )}
      {!authenticated ? (
        <form className="panel mx-auto max-w-md space-y-5 p-6" onSubmit={login}>
          <div>
            <h2 className="text-xl font-semibold">
              {firstLogin ? "设置管理员密码" : "管理员登录"}
            </h2>
            {firstLogin && (
              <p className="mt-2 text-sm leading-6 text-zinc-400">
                临时密码验证成功。设置新密码后才能进入管理页面。
              </p>
            )}
          </div>
          <label className="block space-y-2">
            <span>账号</span>
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              maxLength={64}
              disabled={firstLogin}
              required
            />
          </label>
          <label className="block space-y-2">
            <span>{firstLogin ? "临时密码" : "密码"}</span>
            <Input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              autoComplete="current-password"
              maxLength={256}
              disabled={firstLogin}
              required
            />
          </label>
          {firstLogin && <PasswordFields />}
          <Button className="w-full" disabled={pending}>
            {pending ? "正在处理…" : firstLogin ? "设置密码并登录" : "登录"}
          </Button>
          {firstLogin && (
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => {
                setFirstLogin(false);
                setPassword("");
                setError("");
              }}
            >
              返回登录
            </Button>
          )}
        </form>
      ) : (
        <div className="space-y-6">
          {view === "accounts" || view === "trash" || view === "audit" ? (
            children
          ) : view === "password" ? (
            <form className="panel space-y-5 p-6" onSubmit={changePassword}>
              <div>
                <h2 className="text-xl font-semibold">修改管理员密码</h2>
                <p className="mt-2 text-sm text-zinc-400">
                  修改后，其他浏览器和设备上的管理员登录会立即失效。
                </p>
              </div>
              <label className="block space-y-2">
                <span>当前密码</span>
                <Input
                  name="currentPassword"
                  type="password"
                  autoComplete="current-password"
                  maxLength={256}
                  required
                />
              </label>
              <PasswordFields />
              <Button disabled={pending}>
                {pending ? "正在保存…" : "修改密码"}
              </Button>
              <div className="border-t border-white/10 pt-5">
                <p className="mb-3 text-sm text-zinc-400">
                  在公用设备登录过？可以使当前账号在所有设备上的登录立即失效，包括本设备。
                </p>
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => {
                    if (
                      !window.confirm(
                        "确定退出所有设备？本设备也需要重新登录。",
                      )
                    )
                      return;
                    run(async () => {
                      await request("/api/admin/session/all", "DELETE");
                      toast.success("所有设备的登录已失效");
                      router.replace("/admin");
                      router.refresh();
                    });
                  }}
                >
                  退出所有设备
                </Button>
              </div>
            </form>
          ) : (
            <>
              {listing && (
                <>
                  <ReservationFilters listing={listing} path="/admin" />
                  {listing.filters.view === "available" && (
                    <p className="text-xs text-zinc-500">空位以提交时为准</p>
                  )}
                </>
              )}
              <p className="text-sm text-zinc-400">
                共 {listing?.total ?? reservations.length}{" "}
                场预约。移入回收站后不再公开展示，可在回收站恢复。
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
                      {r.visibility === "INVITE" && (
                        <span className="ml-2 text-xs text-amber-300">
                          邀请制
                        </span>
                      )}
                    </Link>
                    <p className="mt-2 text-sm text-zinc-400">
                      {formatTime(r.scheduledAt)} · {r.hostName} ·{" "}
                      {r.participantCount}/{r.maxPlayers} 人
                      {r.status === "OPEN" && (
                        <span className="ml-3 text-lime-300">
                          还可报名{" "}
                          {Math.max(0, r.maxPlayers - r.participantCount)} 人
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {!["STARTED", "CANCELLED", "ENDED"].includes(r.status) && (
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
                            `确定将「${r.gameName}」移入回收站？可在回收站恢复。`,
                          )
                        )
                          run(async () => {
                            await request(
                              `/api/admin/reservations/${r.id}`,
                              "DELETE",
                            );
                            toast.success("预约已移入回收站");
                            router.refresh();
                          });
                      }}
                    >
                      移入回收站
                    </Button>
                  </div>
                </div>
              ))}
              {listing && (
                <ReservationPagination listing={listing} path="/admin" />
              )}
              {!reservations.length && (
                <p className="panel p-8 text-center text-zinc-400">暂无预约</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function PasswordFields() {
  return (
    <>
      <label className="block space-y-2">
        <span>新密码</span>
        <Input
          name="newPassword"
          type="password"
          autoComplete="new-password"
          minLength={10}
          maxLength={128}
          required
        />
        <span className="block text-xs text-zinc-500">
          至少 10 个字符，最多 128 个字符
        </span>
      </label>
      <label className="block space-y-2">
        <span>确认新密码</span>
        <Input
          name="confirmation"
          type="password"
          autoComplete="new-password"
          minLength={10}
          maxLength={128}
          required
        />
      </label>
    </>
  );
}
