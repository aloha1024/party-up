import type { Metadata } from "next";
import Link from "next/link";
import { Gamepad2, Plus } from "lucide-react";
import { Toaster } from "sonner";
import { Button } from "@/components/ui/button";
import "./globals.css";
export const metadata: Metadata = {
  title: "一起开黑 · 游戏预约",
  description: "创建游戏预约，分享链接，和队友一起准时开局。",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>
        <header className="border-b border-white/10">
          <div className="mx-auto flex h-20 max-w-6xl items-center justify-between px-5 sm:px-8">
            <Link href="/" className="flex items-center gap-3 font-bold">
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
            <Button asChild size="sm">
              <Link href="/reservation/new">
                <Plus />
                创建预约
              </Link>
            </Button>
          </div>
        </header>
        <main className="mx-auto min-h-[calc(100vh-160px)] max-w-6xl px-5 py-10 sm:px-8 sm:py-14">
          {children}
        </main>
        <footer className="mx-auto flex max-w-6xl items-center justify-between border-t border-white/10 px-5 py-6 text-xs text-zinc-500 sm:px-8">
          <span>PARTY UP / 好队友，一起约。</span>
        </footer>
        <Toaster theme="dark" richColors position="top-center" />
      </body>
    </html>
  );
}
