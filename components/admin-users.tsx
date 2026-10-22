"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "./ui/button";
import { request } from "../lib/client-request";
type Item = {
  id: string;
  username: string;
  nickname: string;
  isActive: boolean;
  mustChangePassword: boolean;
  version: number;
};
export function AdminUsers({
  listing,
  q,
}: {
  listing: { items: Item[]; page: number; pageCount: number; total: number };
  q: string;
}) {
  const router = useRouter();
  const [error, setError] = useState(""),
    [pending, setPending] = useState(false),
    [reset, setReset] = useState<Item>(),
    [password, setPassword] = useState("");
  async function manage(user: Item, action: string) {
    if (!navigator.onLine) {
      setError("当前离线，请联网后确认账号状态");
      return;
    }
    if (
      !window.confirm(
        `确认对普通账号“${user.username}”执行${action === "reset" ? "重置密码" : action === "revoke" ? "撤销所有登录" : action === "disable" ? "停用" : "启用"}？`,
      )
    )
      return;
    setPending(true);
    setError("");
    try {
      await request(`/api/admin/users/${user.id}`, "PATCH", {
        action,
        version: user.version,
        ...(action === "reset" ? { password } : {}),
      });
      setPassword("");
      setReset(undefined);
      router.refresh();
    } catch (e) {
      setError((e as Error).message + " 不会自动重发，请刷新核对。");
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="space-y-5">
      <form
        role="search"
        aria-label="筛选普通账号"
        className="panel grid gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end sm:p-5"
      >
        <label className="min-w-0 space-y-2 text-sm">
          <span>搜索普通账号</span>
          <input
            className="field"
            name="q"
            aria-label="搜索普通账号"
            defaultValue={q}
            placeholder="用户名或昵称"
            maxLength={80}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button>搜索</Button>
          <Button asChild variant="outline">
            <Link href="/admin/users">重置</Link>
          </Button>
        </div>
      </form>
      <p className="text-sm text-zinc-400">共 {listing.total} 个普通账号</p>
      {error && (
        <p role="alert" className="text-red-300">
          {error}
        </p>
      )}
      {listing.items.map((user) => (
        <div
          className="panel grid min-w-0 gap-4 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center"
          key={user.id}
        >
          <div className="min-w-0 space-y-2">
            <p className="break-all font-medium">
              {user.username} · {user.nickname}
            </p>
            <p className="text-sm text-zinc-400">
              {user.isActive ? "启用" : "停用"}
              {user.mustChangePassword ? " · 需修改密码" : ""}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 border-t border-white/10 pt-4 lg:border-t-0 lg:pt-0">
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => manage(user, user.isActive ? "disable" : "enable")}
            >
              {user.isActive ? "停用" : "启用"}
            </Button>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => manage(user, "revoke")}
            >
              退出所有设备
            </Button>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => {
                setReset(user);
                setPassword("");
              }}
            >
              重置密码
            </Button>
          </div>
        </div>
      ))}
      {!listing.items.length && (
        <p className="panel p-8 text-center text-zinc-400">
          暂无符合条件的普通账号
        </p>
      )}
      {reset && (
        <form
          className="panel max-w-2xl space-y-4 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            void manage(reset, "reset");
          }}
        >
          <h2 className="break-all font-semibold">
            重置 {reset.username} 的密码
          </h2>
          <p className="text-sm text-zinc-400">
            请先核实用户身份。旧登录及恢复码失效，下次登录必须改密；不会自动启用账号。
          </p>
          <input
            className="field"
            aria-label="临时密码"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={10}
            maxLength={128}
            required
          />
          <div className="flex flex-wrap gap-2">
            <Button disabled={pending}>确认重置</Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setReset(undefined);
                setPassword("");
              }}
            >
              取消
            </Button>
          </div>
        </form>
      )}
      <nav
        aria-label="普通账号分页"
        className="flex flex-wrap items-center gap-3 text-sm"
      >
        {listing.page > 1 && (
          <Button asChild variant="outline">
            <Link
              href={`/admin/users?q=${encodeURIComponent(q)}&page=${listing.page - 1}`}
            >
              上一页
            </Link>
          </Button>
        )}
        <span>
          {listing.page} / {listing.pageCount}
        </span>
        {listing.page < listing.pageCount && (
          <Button asChild variant="outline">
            <Link
              href={`/admin/users?q=${encodeURIComponent(q)}&page=${listing.page + 1}`}
            >
              下一页
            </Link>
          </Button>
        )}
      </nav>
      <p className="text-sm text-zinc-400">
        停用不删除已有预约或名额。管理操作进入管理员审计；不提供游客封禁。
      </p>
    </section>
  );
}
