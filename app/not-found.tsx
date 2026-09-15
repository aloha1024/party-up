import Link from "next/link";
import { Button } from "@/components/ui/button";
export default function NotFound() {
  return (
    <div className="panel p-12 text-center">
      <h1 className="mb-4 text-2xl font-bold">没有找到这场预约</h1>
      <p className="mb-6 text-zinc-400">链接可能有误，或预约已被移除。</p>
      <Button asChild>
        <Link href="/">回到预约大厅</Link>
      </Button>
    </div>
  );
}
