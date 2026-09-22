import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAdmin, canCreateAdministrators } from "@/server/admin";
import { listAdminAudit } from "@/server/admin-audit-list";
import { AdminPanel } from "@/components/admin-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  auditActions,
  auditLabels,
  auditQuerySchema,
  auditUrl,
  type AuditAction,
} from "@/lib/admin-audit";

import type { PageSearchParams } from "@/lib/reservation-list";
export const dynamic = "force-dynamic";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin");
  const parsed = auditQuerySchema.safeParse(await searchParams);
  const listing = parsed.success ? await listAdminAudit(parsed.data) : null;
  return (
    <AdminPanel
      authenticated
      reservations={[]}
      view="audit"
      canCreateAdmins={canCreateAdministrators(admin)}
    >
      <p className="text-sm text-zinc-400">
        记录启用此功能后管理员成功执行的预约和账号管理操作。永久删除预约后，操作记录仍会保留。
      </p>
      {!listing ? (
        <p role="alert" className="panel p-5">
          筛选条件无效。
          <Link className="text-lime-300 underline" href="/admin/audit">
            清除筛选
          </Link>
        </p>
      ) : (
        <>
          <form
            action="/admin/audit"
            method="get"
            role="search"
            aria-label="筛选操作记录"
            className="panel grid gap-4 p-4 sm:grid-cols-[1fr_1fr_auto]"
          >
            <label className="min-w-0 space-y-2 text-sm">
              <span>搜索记录</span>
              <Input
                name="q"
                maxLength={80}
                defaultValue={listing.filters.q}
                placeholder="管理员、对象名称或对象 ID"
              />
            </label>
            <label className="min-w-0 space-y-2 text-sm">
              <span>操作类型</span>
              <select
                name="action"
                className="field"
                defaultValue={listing.filters.action}
              >
                <option value="all">全部操作</option>
                {auditActions.map((action) => (
                  <option key={action} value={action}>
                    {auditLabels[action]}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-end gap-2">
              <Button>筛选</Button>
              <Button asChild variant="outline">
                <Link href="/admin/audit">重置</Link>
              </Button>
            </div>
          </form>
          <ol className="space-y-3">
            {listing.items.map((item) => (
              <li key={item.id} className="panel space-y-2 p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    {auditLabels[item.action as AuditAction] ?? item.action}
                  </span>
                  <time
                    dateTime={item.createdAt}
                    className="text-sm text-zinc-400"
                  >
                    {new Intl.DateTimeFormat("zh-CN", {
                      timeZone: "Asia/Shanghai",
                      year: "numeric",
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                      hour12: false,
                    }).format(new Date(item.createdAt))}
                    （北京时间）
                  </time>
                </div>
                <p className="break-all">{item.targetLabel}</p>
                <p className="break-all text-sm text-zinc-400">
                  操作人：{item.actorName} · 账号 #{item.actorId}
                </p>
                <p className="break-all text-xs text-zinc-500">
                  {item.targetType === "reservation" ? "预约" : "管理员"} ID：
                  {item.targetId}
                </p>
              </li>
            ))}
          </ol>
          {!listing.items.length && (
            <p className="panel p-8 text-center text-zinc-400">
              暂无符合条件的操作记录
            </p>
          )}
          <nav
            aria-label="操作记录分页"
            className="flex flex-wrap items-center justify-between gap-3 text-sm"
          >
            <p className="text-zinc-400">
              共 {listing.total} 条 · {listing.page} / {listing.pageCount} 页
            </p>
            <div className="flex gap-2">
              {listing.page > 1 && (
                <Button asChild variant="outline">
                  <Link href={auditUrl(listing.filters, listing.page - 1)}>
                    上一页
                  </Link>
                </Button>
              )}
              {listing.page < listing.pageCount && (
                <Button asChild variant="outline">
                  <Link href={auditUrl(listing.filters, listing.page + 1)}>
                    下一页
                  </Link>
                </Button>
              )}
            </div>
          </nav>
        </>
      )}
    </AdminPanel>
  );
}
