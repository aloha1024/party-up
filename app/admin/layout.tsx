import type { ReactNode } from "react";
import { buildVersion } from "@/server/build-version";
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <p className="mx-auto mt-10 max-w-3xl break-all text-xs text-zinc-500">
        运行版本：{buildVersion()}
      </p>
    </>
  );
}
