"use client";
import Link from "next/link";
import { Button } from "@/components/ui/button";
export default function ErrorPage({ retry }: { retry: () => void }) {
  return (
    <div role="alert" className="panel p-8 text-center sm:p-12">
      <h1 className="mb-4 text-2xl font-bold">暂时无法加载页面</h1>
      <p className="mb-6 text-zinc-400">请检查网络连接，或稍后重新加载。</p>
      <div className="flex flex-wrap justify-center gap-3">
        <Button onClick={retry}>重新加载</Button>
        <Button asChild variant="outline">
          <Link href="/">返回预约大厅</Link>
        </Button>
      </div>
    </div>
  );
}
