"use client";
import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function AdminAccounts({
  accounts,
}: {
  accounts: {
    id: number;
    username: string;
    mustChangePassword: boolean;
    isActive: boolean;
  }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  const [resetTarget, setResetTarget] = useState<{
    id: number;
    username: string;
  } | null>(null);
  function manage(id: number, data: { action: string; password?: string }) {
    setError("");
    start(async () => {
      try {
        const response = await fetch("/api/admin/accounts/" + id, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "操作失败");
        setResetTarget(null);
        toast.success(
          data.action === "resetPassword"
            ? "临时密码已重置，请交给账号使用者；原登录已失效"
            : data.action === "disable"
              ? "账号已禁用，原登录已失效"
              : "账号已启用，请重新登录",
        );
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "请求失败");
      }
    });
  }
  function resetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!resetTarget) return;
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") || "");
    if (password !== form.get("confirmation")) {
      setError("两次输入的密码不一致");
      return;
    }
    if (
      window.confirm(
        "确定重置「" +
          resetTarget.username +
          "」的密码？该账号需要重新登录并设置正式密码。",
      )
    )
      manage(resetTarget.id, { action: "resetPassword", password });
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    const password = String(form.get("password") || "");
    if (password !== form.get("confirmation")) {
      setError("两次输入的临时密码不一致");
      return;
    }
    setError("");
    start(async () => {
      try {
        const response = await fetch("/api/admin/accounts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: form.get("username"), password }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "创建失败，请重试");
        element.reset();
        toast.success("管理员已创建，请将账号和临时密码告知使用者");
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "请求失败，请重试");
      }
    });
  }
  return (
    <div className="space-y-6">
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
      {resetTarget && (
        <form className="panel space-y-4 p-6" onSubmit={resetPassword}>
          <h2 className="text-xl font-semibold">
            重置密码：{resetTarget.username}
          </h2>
          <p className="text-sm text-zinc-400">
            重置不会自动启用已禁用的账号。首次登录必须再次修改临时密码。
          </p>
          <label className="block space-y-2">
            <span>新临时密码</span>
            <Input
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              maxLength={128}
              disabled={pending}
            />
          </label>
          <label className="block space-y-2">
            <span>确认临时密码</span>
            <Input
              name="confirmation"
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              maxLength={128}
              disabled={pending}
            />
          </label>
          <div className="flex gap-2">
            <Button disabled={pending}>确认重置</Button>
            <Button
              variant="ghost"
              type="button"
              disabled={pending}
              onClick={() => setResetTarget(null)}
            >
              取消
            </Button>
          </div>
        </form>
      )}
      <form onSubmit={submit} className="panel space-y-5 p-6">
        <div>
          <h2 className="text-xl font-semibold">创建管理员</h2>
          <p className="mt-2 text-sm leading-6 text-zinc-400">
            新管理员可管理预约并修改自己的密码，但不能管理其他管理员账号。首次登录需更换临时密码。
          </p>
        </div>

        <label className="block space-y-2">
          <span>账号</span>
          <Input
            name="username"
            autoComplete="off"
            required
            minLength={3}
            maxLength={32}
            pattern="[a-z0-9_]{3,32}"
            placeholder="3–32 位小写字母、数字或下划线"
            disabled={pending}
          />
        </label>
        <label className="block space-y-2">
          <span>临时密码</span>
          <Input
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            maxLength={128}
            disabled={pending}
          />
        </label>
        <label className="block space-y-2">
          <span>确认临时密码</span>
          <Input
            name="confirmation"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            maxLength={128}
            disabled={pending}
          />
        </label>
        <p className="text-xs text-zinc-500">
          临时密码为 10–128 个字符，请妥善保存并交给账号使用者。
        </p>
        <Button disabled={pending}>{pending ? "处理中…" : "创建管理员"}</Button>
      </form>
      <section className="panel p-6" aria-labelledby="account-list-title">
        <h2 id="account-list-title" className="mb-4 text-xl font-semibold">
          管理员账号
        </h2>
        <ul className="divide-y divide-white/10">
          {accounts.map((account) => (
            <li
              key={account.id}
              className="flex flex-wrap items-center justify-between gap-2 py-3"
            >
              <span className="break-all font-medium">{account.username}</span>
              <span className="text-sm text-zinc-400">
                {account.id === 1 ? "主管理员" : "管理员"} ·{" "}
                {!account.isActive
                  ? "已禁用"
                  : account.mustChangePassword
                    ? "待首次改密"
                    : "已启用"}
              </span>
              {account.id !== 1 && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() => {
                      if (
                        window.confirm(
                          (account.isActive ? "禁用" : "启用") +
                            "「" +
                            account.username +
                            "」？",
                        )
                      )
                        manage(account.id, {
                          action: account.isActive ? "disable" : "enable",
                        });
                    }}
                  >
                    {account.isActive ? "禁用账号" : "启用账号"}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() => {
                      setError("");
                      setResetTarget(account);
                    }}
                  >
                    重置密码
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
