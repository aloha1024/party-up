"use client";
import { Button } from "@/components/ui/button";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <div className="panel p-12 text-center">
      <h1 className="mb-4 text-2xl font-bold">暂时无法加载预约</h1>
      <p className="mb-6 text-zinc-400">请检查网络连接，稍后重试。</p>
      <Button onClick={reset}>重新加载</Button>
    </div>
  );
}
