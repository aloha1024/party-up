"use client";
import { FormEvent, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatTime } from "@/lib/utils";
import type { Reservation } from "@/types/reservation";

async function request(url: string, method: string, body?: unknown) {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "操作失败，请重试");
  return result.data;
}

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
      const data = await request("/api/admin/session", "POST", {
        username,
        password,
        ...(firstLogin ? { newPassword } : {}),
      });
      if (data.requiresPasswordChange) {
        setFirstLogin(true);
        setError("");
        toast.info("首次登录，请设置新的管理员密码");
        return;
      }
      setPassword("");
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
        <h1 className="text-3xl font-bold">预约管理</h1>
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
          </form>
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
                      run(async () => {
                        await request(
                          `/api/admin/reservations/${r.id}`,
                          "DELETE",
                        );
                        toast.success("预约已删除");
                        router.refresh();
                      });
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
