"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { reservationListUrl } from "@/lib/reservation-list";
import type { ReservationPage } from "@/types/reservation";

export function ReservationFilters({
  listing,
  path = "/",
}: {
  listing: ReservationPage;
  path?: "/" | "/admin";
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const filters = listing.filters;
  return (
    <form
      key={JSON.stringify([
        filters.q,
        filters.view,
        filters.date,
        filters.pageSize,
      ])}
      action={path}
      method="get"
      role="search"
      aria-label="筛选预约"
      className="panel mb-6 grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_auto]"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const query = new URLSearchParams();
        for (const name of ["q", "view", "date"]) {
          const value = String(form.get(name) || "").trim();
          if (value && value !== "all") query.set(name, value);
        }
        if (filters.pageSize !== 12)
          query.set("pageSize", String(filters.pageSize));
        start(() =>
          router.push(path + (query.size ? "?" + query : ""), {
            scroll: false,
          }),
        );
      }}
    >
      <label className="min-w-0 space-y-2 text-sm">
        <span>搜索预约</span>
        <Input
          name="q"
          type="search"
          maxLength={80}
          defaultValue={filters.q}
          placeholder="游戏名称或发起人"
        />
      </label>
      <label className="min-w-0 space-y-2 text-sm">
        <span>预约状态</span>
        <select name="view" className="field" defaultValue={filters.view}>
          <option value="all">全部预约</option>
          <option value="upcoming">未开始（含满员）</option>
          <option value="started">已开始</option>
          <option value="cancelled">已取消</option>
        </select>
      </label>
      <label className="min-w-0 space-y-2 text-sm">
        <span>开玩日期（北京时间）</span>
        <Input name="date" type="date" defaultValue={filters.date} />
      </label>
      <div className="flex items-end gap-2">
        <input type="hidden" name="pageSize" value={filters.pageSize} />
        <Button disabled={pending}>{pending ? "筛选中…" : "筛选"}</Button>
        <Button asChild variant="outline">
          <Link href={path}>重置</Link>
        </Button>
      </div>
    </form>
  );
}
export function ReservationPagination({
  listing,
  path = "/",
}: {
  listing: ReservationPage;
  path?: "/" | "/admin";
}) {
  const { page, pageCount, total, pageSize, filters } = listing;
  return (
    <nav
      aria-label="预约分页"
      className="mt-7 flex flex-wrap items-center justify-between gap-4 text-sm"
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
              href={reservationListUrl(path, filters, page - 1)}
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
              href={reservationListUrl(path, filters, page + 1)}
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
