import type { Metadata } from "next";
import Link from "next/link";
import { Gamepad2, Plus } from "lucide-react";
import { Toaster } from "sonner";
import { Button } from "@/components/ui/button";
import "./globals.css";
import { currentPageViewer } from "@/server/page-identity";
import { publicViewer } from "@/server/user-identity";
import { unreadNotificationCount } from "@/server/notifications";
import {
  IdentityProvider,
  AccountNavigation,
} from "@/components/identity-provider";
export const metadata: Metadata = {
  title: "一起开黑 · 游戏预约",
  description: "创建游戏预约，分享链接，和队友一起准时开局。",
};
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const current = await currentPageViewer();
  const viewer = publicViewer(current);
  const unread =
    viewer.mode === "user"
      ? await unreadNotificationCount(
          current.user?.mustChangePassword ? undefined : current.token,
        )
      : 0;
  return (
    <html lang="zh-CN">
      <body>
        <IdentityProvider key={viewer.scope} identity={viewer}>
          <header className="border-b border-white/10">
            <div className="mx-auto grid min-h-20 max-w-6xl grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-4 px-5 py-4 sm:flex sm:flex-wrap sm:justify-between sm:px-8">
              <Link
                href="/"
                className="flex min-w-0 items-center gap-2 font-bold"
              >
                <span className="rounded-xl bg-lime-300 p-2 text-zinc-950">
                  <Gamepad2 size={25} />
                </span>
                <span>
                  一起开黑
                  <span className="ml-3 hidden text-xs font-normal tracking-widest text-zinc-500 sm:inline">
                    PARTY UP
                  </span>
                </span>
              </Link>
              <nav
                aria-label="主导航"
                className="contents sm:flex sm:flex-wrap sm:items-center sm:gap-5"
              >
                <div className="flex min-w-0 max-w-36 items-center justify-end sm:order-last sm:max-w-40 sm:border-l sm:border-white/10 sm:pl-5">
                  <AccountNavigation />
                </div>
                <div className="col-span-2 flex flex-wrap items-center gap-2 border-t border-white/10 pt-3 sm:border-0 sm:pt-0">
                  {viewer.mode === "user" && (
                    <Button asChild size="sm" variant="ghost">
                      <Link
                        href="/notifications"
                        prefetch={false}
                        aria-label="站内提醒"
                      >
                        站内提醒
                        {unread > 0 ? ` (${unread > 99 ? "99+" : unread})` : ""}
                      </Link>
                    </Button>
                  )}
                  <Button asChild size="sm" variant="ghost">
                    <Link href="/my-reservations" prefetch={false}>
                      我的预约
                    </Link>
                  </Button>
                  <Button asChild size="sm" variant="outline">
                    <Link href="/reservation/new">
                      <Plus />
                      创建预约
                    </Link>
                  </Button>
                </div>
              </nav>
            </div>
          </header>
          <main className="mx-auto min-h-[calc(100vh-160px)] max-w-6xl px-5 py-7 sm:px-8 sm:py-10">
            {(viewer.mode === "anonymous" || viewer.mode === "guest") && (
              <p className="mb-6 flex items-center gap-2 text-xs text-zinc-500">
                <span
                  className="size-1.5 rounded-full bg-zinc-600"
                  aria-hidden="true"
                />
                你正在使用游客模式
              </p>
            )}
            {children}
          </main>
          <footer className="mx-auto flex max-w-6xl items-center justify-between border-t border-white/10 px-5 py-6 text-xs text-zinc-500 sm:px-8">
            <span>PARTY UP / 好队友，一起约。</span>
          </footer>
          <Toaster theme="dark" richColors position="top-center" />
        </IdentityProvider>
      </body>
    </html>
  );
}
