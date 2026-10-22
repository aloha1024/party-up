"use client";
import { recruitmentClosure, recruitmentWakeups } from "../lib/recruitment";
import { z } from "zod";
import { request } from "@/lib/client-request";
import { FormEvent, type ReactNode, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AdminReservationShare } from "@/components/admin-reservation-share";
import { Badge } from "@/components/reservation-ui";
import { formatTime } from "@/lib/utils";
import {
  ReservationFilters,
  ReservationPagination,
} from "@/components/reservation-filters";
import { useReservationRefresh } from "@/components/use-reservation-refresh";
import type { ReservationSummary, ReservationPage } from "@/types/reservation";

const adminNavigation = [
  { view: "statistics", href: "/admin/statistics", label: "活动概览" },
  { view: "reservations", href: "/admin", label: "预约管理" },
  { view: "trash", href: "/admin/trash", label: "回收站" },
  { view: "audit", href: "/admin/audit", label: "操作记录" },
  { view: "users", href: "/admin/users", label: "普通账号" },
  { view: "accounts", href: "/admin/accounts", label: "管理员账号" },
  { view: "password", href: "/admin/password", label: "修改密码" },
] as const;

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
  view?:
    | "reservations"
    | "password"
    | "accounts"
    | "trash"
    | "audit"
    | "users"
    | "statistics";
  canCreateAdmins?: boolean;
  children?: ReactNode;
  refreshSample?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [sharing, setSharing] = useState(false);
  useReservationRefresh({
    sample: refreshSample,
    data: { listing, canCreateAdmins, authenticated },
    scope: JSON.stringify(listing?.filters),
    scheduledAt: reservations.flatMap(recruitmentWakeups),
    enabled: authenticated && view === "reservations",
    paused: pending || sharing,
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
    <div className="min-w-0">
      <Link href="/" className="text-sm text-zinc-400">
        ← 返回预约大厅
      </Link>
      <div className="my-6 flex flex-wrap items-center justify-between gap-4 sm:my-8">
        <h1 className="min-w-0 text-2xl font-bold sm:text-3xl">
          {view === "statistics"
            ? "活动概览"
            : view === "audit"
              ? "操作记录"
              : view === "trash"
                ? "回收站"
                : view === "accounts"
                  ? "管理员账号"
                  : view === "users"
                    ? "普通账号"
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
        <nav
          aria-label="管理员导航"
          className="panel mb-8 grid grid-cols-2 gap-2 p-2 sm:grid-cols-4 lg:grid-cols-7"
        >
          {adminNavigation
            .filter((item) => item.view !== "accounts" || canCreateAdmins)
            .map((item) => (
              <Button
                key={item.view}
                asChild
                variant={view === item.view ? "default" : "ghost"}
                className="min-w-0 px-3"
              >
                <Link
                  href={item.href}
                  prefetch={item.view === "statistics" ? false : undefined}
                  aria-current={view === item.view ? "page" : undefined}
                >
                  {item.label}
                </Link>
              </Button>
            ))}
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
          {view === "accounts" ||
          view === "trash" ||
          view === "audit" ||
          view === "statistics" ||
          view === "users" ? (
            children
          ) : view === "password" ? (
            <form
              className="panel max-w-2xl space-y-5 p-5 sm:p-6"
              onSubmit={changePassword}
            >
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
              <AdminReservationShare
                disabled={pending}
                onPendingChange={setSharing}
              />
              <p className="text-sm text-zinc-400">
                共 {listing?.total ?? reservations.length}{" "}
                场预约。移入回收站后不再公开展示，可在回收站恢复。
              </p>
              {reservations.map((r) => (
                <div
                  className="panel grid min-w-0 gap-4 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center"
                  key={r.id}
                >
                  <div className="min-w-0">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <Badge reservation={r} />
                    </div>
                    <Link
                      className="block break-all text-lg font-semibold hover:text-lime-300"
                      href={`/reservation/${r.id}`}
                    >
                      {r.gameName}
                    </Link>
                    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm text-zinc-400">
                      <span>{formatTime(r.scheduledAt)}</span>
                      <span className="break-all">发起人：{r.hostName}</span>
                      <span>
                        {r.participantCount}/{r.maxPlayers} 人
                      </span>
                      {r.status === "OPEN" && !recruitmentClosure(r) && (
                        <span className="text-lime-300">
                          还可报名{" "}
                          {Math.max(0, r.maxPlayers - r.participantCount)} 人
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 border-t border-white/10 pt-4 lg:border-t-0 lg:pt-0">
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
