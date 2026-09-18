"use client";
import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function AdminAccounts({
  accounts,
}: {
  accounts: { id: number; username: string; mustChangePassword: boolean }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
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
      <form onSubmit={submit} className="panel space-y-5 p-6">
        <div>
          <h2 className="text-xl font-semibold">创建管理员</h2>
          <p className="mt-2 text-sm leading-6 text-zinc-400">
            新管理员可编辑、删除预约并修改自己的密码，但不能创建管理员。首次登录需更换临时密码。
          </p>
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-400">
            {error}
          </p>
        )}
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
        <Button disabled={pending}>
          {pending ? "正在创建…" : "创建管理员"}
        </Button>
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
                {account.mustChangePassword ? "待首次改密" : "已设置密码"}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
