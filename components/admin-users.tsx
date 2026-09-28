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
      <form className="flex gap-3">
        <input
          className="field"
          name="q"
          aria-label="搜索普通账号"
          defaultValue={q}
          placeholder="用户名或昵称"
          maxLength={80}
        />
        <Button>搜索</Button>
      </form>
      <p>共 {listing.total} 个普通账号</p>
      {error && (
        <p role="alert" className="text-red-300">
          {error}
        </p>
      )}
      {listing.items.map((user) => (
        <div className="panel space-y-3 p-5" key={user.id}>
          <p>
            {user.username} · {user.nickname}
          </p>
          <p className="text-sm text-zinc-400">
            {user.isActive ? "启用" : "停用"}
            {user.mustChangePassword ? " · 需修改密码" : ""}
          </p>
          <div className="flex flex-wrap gap-2">
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
      {reset && (
        <form
          className="panel space-y-4 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            void manage(reset, "reset");
          }}
        >
          <h2>重置 {reset.username} 的密码</h2>
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
        </form>
      )}
      <nav className="flex gap-4">
        {listing.page > 1 && (
          <Link
            href={`/admin/users?q=${encodeURIComponent(q)}&page=${listing.page - 1}`}
          >
            上一页
          </Link>
        )}
        <span>
          {listing.page} / {listing.pageCount}
        </span>
        {listing.page < listing.pageCount && (
          <Link
            href={`/admin/users?q=${encodeURIComponent(q)}&page=${listing.page + 1}`}
          >
            下一页
          </Link>
        )}
      </nav>
      <p className="text-sm text-zinc-400">
        停用不删除已有预约或名额。管理操作进入管理员审计；不提供游客封禁。
      </p>
    </section>
  );
}
