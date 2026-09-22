"use client";
import Link from "next/link";
import { Button } from "@/components/ui/button";
export default function AdminError({ retry }: { retry: () => void }) {
  return (
    <div
      role="alert"
      className="panel mx-auto max-w-3xl space-y-5 p-8 text-center"
    >
      <h1 className="text-2xl font-bold">暂时无法加载管理页面</h1>
      <p className="text-zinc-400">
        服务可能暂时不可用，请稍后重新加载。若刚提交过操作，请先确认结果。
      </p>
      <div className="flex flex-wrap justify-center gap-3">
        <Button onClick={retry}>重新加载</Button>
        <Button asChild variant="outline">
          <Link href="/admin">返回预约管理</Link>
        </Button>
      </div>
    </div>
  );
}
