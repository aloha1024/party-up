import type { ReactNode } from "react";
import { buildVersion } from "@/server/build-version";
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="admin-shell mx-auto min-w-0 max-w-6xl">
      {children}
      <p className="mt-10 break-all text-xs text-zinc-500">
        运行版本：{buildVersion()}
      </p>
    </div>
  );
}
