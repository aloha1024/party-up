"use client";
import { recruitmentWakeups } from "../lib/recruitment";
import { request } from "@/lib/client-request";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useState,
  useTransition,
} from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useReservationRefresh } from "@/components/use-reservation-refresh";
import {
  AdminSessionEndedContext,
  useAdminFeedback,
} from "@/components/use-admin-feedback";
import type { ReservationSummary, ReservationPage } from "@/types/reservation";

import { AdminLoginForm } from "./admin-login-form";
import { AdminPasswordForm } from "./admin-password-form";
import { AdminReservationList } from "./admin-reservation-list";
import type { AdminFormOperation } from "./admin-operation";

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
  const [pending, start] = useTransition();
  const [hydrated, setHydrated] = useState(false);
  const [sessionEnded, setSessionEnded] = useState("");
  const endSession = useCallback(
    (message: string) => {
      if (authenticated) setSessionEnded(message);
    },
    [authenticated],
  );
  const {
    error,
    setError,
    checkOnline,
    handleError,
    refreshAfterSuccess,
    refreshStatus,
  } = useAdminFeedback(endSession);
  useEffect(() => setHydrated(true), []);
  useEffect(() => {
    if (!authenticated) setSessionEnded("");
  }, [authenticated]);
  useReservationRefresh({
    sample: refreshSample,
    data: { listing, canCreateAdmins, authenticated },
    scope: JSON.stringify(listing?.filters),
    scheduledAt: reservations.flatMap(recruitmentWakeups),
    enabled: authenticated && !sessionEnded && view === "reservations",
    paused: pending,
  });

  function run(task: () => Promise<void>) {
    if (pending || (sessionEnded && authenticated) || !checkOnline()) return;
    setError("");
    start(async () => {
      try {
        if (!checkOnline()) return;
        await task();
      } catch (e) {
        handleError(e);
      }
    });
  }

  const operation: AdminFormOperation = {
    hydrated,
    pending,
    run,
    checkOnline,
    setError,
    refreshAfterSuccess,
  };

  if (sessionEnded && authenticated)
    return (
      <section className="panel mx-auto max-w-3xl space-y-5 p-6">
        <h1 className="text-2xl font-bold">管理会话已结束</h1>
        <p role="alert">
          {sessionEnded}
          {error && error !== sessionEnded && (
            <span className="mt-2 block text-sm text-amber-300">{error}</span>
          )}
        </p>
        <Button
          disabled={pending}
          onClick={() => {
            if (!navigator.onLine) {
              setError("当前离线，请联网后前往管理员登录。");
              return;
            }
            // A manual verification must also reset a locked local view if another
            // tab has already signed in again with a valid administrator session.
            window.location.assign("/admin");
          }}
        >
          前往管理员登录
        </Button>
      </section>
    );

  return (
    <AdminSessionEndedContext.Provider value={endSession}>
      <div className="mx-auto max-w-3xl">
        <Link href="/" className="text-sm text-zinc-400">
          ← 返回预约大厅
        </Link>
        <div className="my-8 flex items-center justify-between gap-4">
          <h1 className="text-3xl font-bold">
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
                  endSession("已退出登录，请联网后重新登录。");
                  toast.success("已退出登录");
                  refreshAfterSuccess();
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
              variant={view === "statistics" ? "default" : "outline"}
            >
              <Link
                href="/admin/statistics"
                prefetch={false}
                aria-current={view === "statistics" ? "page" : undefined}
              >
                活动概览
              </Link>
            </Button>
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
            <Button
              asChild
              variant={view === "password" ? "default" : "outline"}
            >
              <Link
                href="/admin/password"
                aria-current={view === "password" ? "page" : undefined}
              >
                修改密码
              </Link>
            </Button>
            <Button asChild variant={view === "users" ? "default" : "outline"}>
              <Link href="/admin/users">普通账号</Link>
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
          <div className="mb-5 space-y-3">
            <p className="mb-5 text-sm text-red-400" role="alert">
              {error}
            </p>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={refreshStatus}
            >
              刷新核对状态
            </Button>
          </div>
        )}
        {!authenticated ? (
          <AdminLoginForm operation={operation} />
        ) : (
          <div className="space-y-6">
            {view === "accounts" ||
            view === "trash" ||
            view === "audit" ||
            view === "statistics" ||
            view === "users" ? (
              children
            ) : view === "password" ? (
              <AdminPasswordForm
                operation={operation}
                endSession={endSession}
              />
            ) : (
              <AdminReservationList
                reservations={reservations}
                listing={listing}
                operation={operation}
              />
            )}
          </div>
        )}
      </div>
    </AdminSessionEndedContext.Provider>
  );
}
