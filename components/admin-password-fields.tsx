import { Input } from "@/components/ui/input";

export function AdminPasswordFields() {
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
