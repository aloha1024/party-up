"use client";
import Link from "next/link";
import { Button } from "./ui/button";
import { Badge } from "./reservation-ui";
import { useIdentity } from "./identity-provider";
import { useReservationRefresh } from "./use-reservation-refresh";
import { formatTime } from "../lib/utils";
import {
  beijingDate,
  personalPageUrl,
  scheduleWakeups,
  type PersonalPageFilters,
  type SchedulePage,
} from "../lib/reservation-schedule";

export function ReservationSchedule({
  listing,
  filters,
  refreshSample,
  hasIdentity,
}: {
  listing: SchedulePage;
  filters: PersonalPageFilters;
  refreshSample: string;
  hasIdentity: boolean;
}) {
  const viewer = useIdentity();
  const current = { ...filters, schedulePage: listing.page };
  useReservationRefresh({
    sample: refreshSample,
    data: { listing, hasIdentity },
    scope: JSON.stringify([listing.range, listing.day, listing.page]),
    scheduledAt: scheduleWakeups(listing),
  });
  const days = [
    ...new Set(listing.items.map((r) => beijingDate(r.scheduledAt))),
  ];
  return (
    <>
      <h1 className="text-3xl font-bold sm:text-4xl">
        我的日程<span className="text-lime-300">.</span>
      </h1>
      <p className="mt-3 text-sm text-zinc-400">
        {viewer?.mode === "user"
          ? "显示当前账号的日程，登录同一账号可跨设备查看。"
          : "仅显示当前浏览器的游客日程，注册登录后可确认关联。"}
      </p>
      <p className="mt-2 text-sm text-zinc-400">
        合并发起、参加和候补记录，仅按日程时间范围展示，不应用列表筛选。时间均为北京时间，未确认不代表缺席。
      </p>
      <nav aria-label="日程时间范围" className="my-6 flex flex-wrap gap-3">
        {(["today", "week"] as const).map((range) => (
          <Button
            key={range}
            asChild
            variant={listing.range === range ? "default" : "outline"}
          >
            <Link
              prefetch={false}
              aria-current={listing.range === range ? "page" : undefined}
              href={personalPageUrl(current, { range, schedulePage: 1 })}
            >
              {range === "today" ? "今天" : "未来 7 天"}
            </Link>
          </Button>
        ))}
      </nav>
      <p className="mb-5 text-sm text-zinc-400">
        {listing.day} 起 ·{" "}
        {listing.range === "today" ? "当天" : "含今天的 7 个自然日"} · 共{" "}
        {listing.total} 场
      </p>
      {listing.nearest && (
        <aside
          aria-label="最近开局"
          className="panel mb-6 border-lime-300/40 p-5"
        >
          <p className="text-sm text-lime-300">最近正式参加的预约</p>
          <Link
            className="mt-2 block break-words font-semibold underline"
            href={`/reservation/${listing.nearest.id}`}
          >
            {listing.nearest.gameName} ·{" "}
            {formatTime(listing.nearest.scheduledAt)}
          </Link>
        </aside>
      )}
      {!listing.items.length && (
        <section className="panel space-y-4 p-6">
          <h2 className="text-xl font-semibold">
            {hasIdentity ? "这段时间暂无日程" : "暂无当前浏览器的预约记录"}
          </h2>
          <p className="text-sm text-zinc-400">
            {hasIdentity
              ? "去大厅寻找队友，或创建自己的预约。"
              : "请使用创建或报名时的浏览器，或登录已有账号查看。"}
          </p>
          <div className="flex flex-wrap gap-3">
            <Button asChild variant="outline">
              <Link href="/">去大厅</Link>
            </Button>
            <Button asChild>
              <Link href="/reservation/new">创建预约</Link>
            </Button>
          </div>
        </section>
      )}
      {days.map((day) => (
        <section key={day} aria-label={`${day} 日程`} className="mb-7">
          <h2 className="mb-3 text-lg font-semibold">
            {day}
            {day === listing.day ? " · 今天" : ""}
          </h2>
          <ol className="space-y-3">
            {listing.items
              .filter((r) => beijingDate(r.scheduledAt) === day)
              .map((r) => (
                <li
                  key={r.id}
                  data-schedule-id={r.id}
                  className={`panel p-5 ${["CANCELLED", "ENDED"].includes(r.status) ? "border-white/5 bg-zinc-950 text-zinc-400" : ""}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <Link
                      href={`/reservation/${r.id}`}
                      className="min-w-0 break-words text-lg font-semibold underline decoration-white/20 underline-offset-4"
                    >
                      {r.gameName}
                    </Link>
                    <Badge reservation={r} />
                  </div>
                  <p className="mt-3 text-sm">
                    {formatTime(r.scheduledAt)} · 发起人：{r.hostName} ·{" "}
                    {r.participantCount} / {r.maxPlayers} 人
                  </p>
                  <p className="mt-2 text-sm text-zinc-400">
                    {[
                      r.isHost && "我发起的",
                      r.isParticipant && "我参加的",
                      r.isWaiting && "我候补的（尚未正式参加）",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  {r.attendance && (
                    <p className="mt-2 text-sm" data-attendance={r.attendance}>
                      {
                        {
                          closed: "到场确认已锁定",
                          waiting: "尚未开放确认",
                          ready: "可确认到场",
                          confirmed: "已确认到场",
                        }[r.attendance]
                      }
                      {r.checkedInAt &&
                        ` · 已确认到场：${formatTime(r.checkedInAt)}`}
                      {r.attendance === "waiting" &&
                        ` · ${formatTime(new Date(Date.parse(r.scheduledAt) - 30 * 60000).toISOString())} 开放`}
                      {r.attendance === "ready" && " · 进入详情确认"}
                    </p>
                  )}
                  {r.simultaneous && (
                    <p className="mt-2 text-sm text-amber-300">
                      同期开局，请核对安排
                    </p>
                  )}
                </li>
              ))}
          </ol>
        </section>
      ))}
      <nav
        aria-label="日程分页"
        className="mt-6 flex flex-wrap items-center justify-between gap-3"
      >
        <span className="text-sm text-zinc-400">
          共 {listing.total} 场 · {listing.page} / {listing.pageCount}
        </span>
        <div className="flex gap-3">
          {listing.page > 1 ? (
            <Button asChild variant="outline">
              <Link
                prefetch={false}
                href={personalPageUrl(current, {
                  schedulePage: listing.page - 1,
                })}
              >
                上一页
              </Link>
            </Button>
          ) : (
            <Button variant="outline" disabled>
              上一页
            </Button>
          )}
          {listing.page < listing.pageCount ? (
            <Button asChild variant="outline">
              <Link
                prefetch={false}
                href={personalPageUrl(current, {
                  schedulePage: listing.page + 1,
                })}
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
    </>
  );
}
