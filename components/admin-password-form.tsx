import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { request } from "@/lib/client-request";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AdminPasswordFields } from "./admin-password-fields";
import type { AdminFormOperation } from "./admin-operation";

export function AdminPasswordForm({
  operation,
  endSession,
}: {
  operation: AdminFormOperation;
  endSession: (message: string) => void;
}) {
  const router = useRouter();
  const { hydrated, pending, run, checkOnline, setError, refreshAfterSuccess } =
    operation;
  function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hydrated || pending || !checkOnline()) return;
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
      refreshAfterSuccess();
    });
  }

  return (
    <form method="post" className="panel p-6" onSubmit={changePassword}>
      <noscript>
        <p className="mb-4 text-sm text-amber-300">
          密码操作需要启用 JavaScript，请启用后刷新页面。
        </p>
      </noscript>
      <fieldset disabled={!hydrated || pending} className="min-w-0 space-y-5">
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
        <AdminPasswordFields />
        <Button disabled={pending}>{pending ? "正在保存…" : "修改密码"}</Button>
        <div className="border-t border-white/10 pt-5">
          <p className="mb-3 text-sm text-zinc-400">
            在公用设备登录过？可以使当前账号在所有设备上的登录立即失效，包括本设备。
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => {
              if (pending || !checkOnline()) return;
              if (!window.confirm("确定退出所有设备？本设备也需要重新登录。"))
                return;
              run(async () => {
                await request("/api/admin/session/all", "DELETE");
                endSession("所有设备的登录已失效，请联网后重新登录。");
                toast.success("所有设备的登录已失效");
                if (navigator.onLine) router.replace("/admin");
                refreshAfterSuccess();
              });
            }}
          >
            退出所有设备
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
