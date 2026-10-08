import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAdmin, canCreateAdministrators } from "@/server/admin";
import { adminStatistics } from "@/server/admin-statistics";
import { AdminPanel } from "@/components/admin-panel";
import { Button } from "@/components/ui/button";
import {
  adminStatisticsSchema,
  adminStatisticsUrl,
  statisticsRangeLabels,
  type StatisticsRange,
} from "@/lib/admin-statistics";
import type { PageSearchParams } from "@/lib/reservation-list";
import { formatTime } from "@/lib/utils";

export const dynamic = "force-dynamic";
const dateLabel = (value: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));

function Metric({ label, count }: { label: string; count: number }) {
  return (
    <div role="group" aria-label={label} className="panel space-y-3 p-5">
      <dt className="text-sm text-zinc-400">{label}</dt>
      <dd className="text-3xl font-semibold tabular-nums text-lime-300">
        {count}
      </dd>
    </div>
  );
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin");
  const parsed = adminStatisticsSchema.safeParse(await searchParams);
  const statistics = parsed.success ? await adminStatistics(parsed.data) : null;
  return (
    <AdminPanel
      authenticated
      reservations={[]}
      view="statistics"
      canCreateAdmins={canCreateAdministrators(admin)}
    >
      {!statistics ? (
        <p role="alert" className="panel p-5">
          统计范围无效。
          <Link className="text-lime-300 underline" href="/admin/statistics">
            清除筛选
          </Link>
        </p>
      ) : (
        <>
          <nav aria-label="统计时间范围" className="flex flex-wrap gap-3">
            {(Object.keys(statisticsRangeLabels) as StatisticsRange[]).map(
              (range) => (
                <Button
                  key={range}
                  asChild
                  variant={statistics.range === range ? "default" : "outline"}
                >
                  <Link
                    href={adminStatisticsUrl(range)}
                    prefetch={false}
                    aria-current={
                      statistics.range === range ? "page" : undefined
                    }
                  >
                    {statisticsRangeLabels[range]}
                  </Link>
                </Button>
              ),
            )}
            <form action="/admin/statistics" method="get">
              <input type="hidden" name="range" value={statistics.range} />
              <Button type="submit" variant="outline">
                刷新数据
              </Button>
            </form>
          </nav>
          <div className="space-y-2 text-sm leading-6 text-zinc-400">
            <p>
              北京时间 {dateLabel(statistics.start)} 至{" "}
              {dateLabel(
                new Date(new Date(statistics.end).getTime() - 1).toISOString(),
              )}
              ，含首尾日期。按开玩时间统计，包含公开与邀请预约，排除回收站中的预约。
            </p>
            <p>
              数据时间：
              <time dateTime={statistics.asOf}>
                {formatTime(statistics.asOf)}（北京时间）
              </time>
              。刷新后查看最新数据。
            </p>
          </div>
          <section aria-label="预约状态概览" className="space-y-4">
            <h2 className="text-lg font-semibold">预约状态</h2>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Metric label="预约总数" count={statistics.reservations.total} />
              <Metric label="未开始" count={statistics.reservations.upcoming} />
              <Metric
                label="已开始未结束"
                count={statistics.reservations.started}
              />
              <Metric label="已结束" count={statistics.reservations.ended} />
              <Metric
                label="已取消"
                count={statistics.reservations.cancelled}
              />
            </dl>
          </section>
          <section aria-label="当前名单概览" className="space-y-4">
            <h2 className="text-lg font-semibold">当前名单</h2>
            <p className="text-sm leading-6 text-zinc-400">
              统计所选范围内各场预约当前保留的名单，包含已结束和已取消的预约。同一人报名多场按多人次计算；退出或被移除的报名不计入，候补递补后只计正式报名。以下数据不是历史累计报名数；到场确认仅表示主动确认，不代表实际出勤率。
            </p>
            <dl className="grid gap-3 sm:grid-cols-3">
              <Metric
                label="当前正式报名人次"
                count={statistics.roster.participants}
              />
              <Metric label="当前候补人次" count={statistics.roster.waitlist} />
              <Metric
                label="已确认到场人次"
                count={statistics.roster.checkedIn}
              />
            </dl>
          </section>
          <section aria-label="全站当前账号概览" className="space-y-4">
            <h2 className="text-lg font-semibold">全站当前普通账号</h2>
            <p className="text-sm leading-6 text-zinc-400">
              不受上方日期范围限制，不包含游客身份和管理员账号。
            </p>
            <dl className="grid grid-cols-2 gap-3">
              <Metric label="账号总数" count={statistics.accounts.total} />
              <Metric label="启用账号数" count={statistics.accounts.active} />
            </dl>
          </section>
        </>
      )}
    </AdminPanel>
  );
}
