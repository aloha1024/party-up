import { useState, type FormEvent } from "react";
import { z } from "zod";
import { toast } from "sonner";
import { request } from "@/lib/client-request";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AdminPasswordFields } from "./admin-password-fields";
import type { AdminFormOperation } from "./admin-operation";

export function AdminLoginForm({
  operation,
}: {
  operation: AdminFormOperation;
}) {
  const { hydrated, pending, run, checkOnline, setError, refreshAfterSuccess } =
    operation;
  const [firstLogin, setFirstLogin] = useState(false);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");

  function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hydrated || pending || !checkOnline()) return;
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
      refreshAfterSuccess();
    });
  }

  return (
    <form method="post" className="panel mx-auto max-w-md p-6" onSubmit={login}>
      <noscript>
        <p className="mb-4 text-sm text-amber-300">
          密码操作需要启用 JavaScript，请启用后刷新页面。
        </p>
      </noscript>
      <fieldset disabled={!hydrated || pending} className="min-w-0 space-y-5">
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
        {firstLogin && <AdminPasswordFields />}
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
      </fieldset>
    </form>
  );
}
