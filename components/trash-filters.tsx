"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { reservationTrashUrl } from "@/lib/reservation-trash";
import type { TrashPage } from "@/types/reservation-trash";

export function TrashFilters({ listing }: { listing: TrashPage }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const { filters } = listing;
  return (
    <form
      key={JSON.stringify([filters.q, filters.date, filters.pageSize])}
      action="/admin/trash"
      method="get"
      role="search"
      aria-label="筛选回收站"
      className="panel grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_auto]"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        start(() =>
          router.push(
            reservationTrashUrl({
              ...filters,
              q: String(form.get("q") || "").trim(),
              date: String(form.get("date") || ""),
              page: 1,
            }),
            { scroll: false },
          ),
        );
      }}
    >
      <label className="min-w-0 space-y-2 text-sm">
        <span>搜索已删除预约</span>
        <Input
          name="q"
          type="search"
          maxLength={80}
          defaultValue={filters.q}
          placeholder="游戏名称、发起人或预约 ID"
        />
      </label>
      <label className="min-w-0 space-y-2 text-sm">
        <span>移入日期（北京时间）</span>
        <Input name="date" type="date" defaultValue={filters.date} />
      </label>
      <div className="flex items-end gap-2">
        <input type="hidden" name="pageSize" value={filters.pageSize} />
        <Button disabled={pending}>{pending ? "筛选中…" : "筛选"}</Button>
        <Button asChild variant="outline">
          <Link href="/admin/trash">重置</Link>
        </Button>
      </div>
    </form>
  );
}
export function TrashPagination({ listing }: { listing: TrashPage }) {
  const { page, pageCount, total, pageSize, filters } = listing;
  return (
    <nav
      aria-label="回收站分页"
      className="flex flex-wrap items-center justify-between gap-4 text-sm"
    >
      <p className="text-zinc-400" role="status">
        共 {total} 场
        {total > 0 &&
          ` · 显示 ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} 场`}
      </p>
      <div className="flex items-center gap-3">
        {page > 1 ? (
          <Button asChild variant="outline">
            <Link
              prefetch={false}
              href={reservationTrashUrl(filters, page - 1)}
            >
              上一页
            </Link>
          </Button>
        ) : (
          <Button variant="outline" disabled>
            上一页
          </Button>
        )}
        <span className="text-zinc-400">
          {page} / {pageCount}
        </span>
        {page < pageCount ? (
          <Button asChild variant="outline">
            <Link
              prefetch={false}
              href={reservationTrashUrl(filters, page + 1)}
            >
              下一页
            </Link>
          </Button>
        ) : (
          <Button variant="outline" disabled>
            下一页
          </Button>
        )}
      </div>
    </nav>
  );
}
