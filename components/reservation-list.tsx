"use client";
import {
  ReservationFilters,
  ReservationPagination,
} from "@/components/reservation-filters";
import { Button } from "@/components/ui/button";
import { useReservationRefresh } from "@/components/use-reservation-refresh";
import { formatTime } from "@/lib/utils";
import {
  reservationListUrl,
  type MyReservationTab,
} from "@/lib/reservation-list";
import type { ReservationPage } from "@/types/reservation";
import { ArrowUpRight, Clock3, Gamepad2, Plus, Users } from "lucide-react";
import Link from "next/link";

import { Badge } from "./reservation-ui";
export function ReservationList({
  listing,
  refreshSample,
  tab,
  hasIdentity = true,
}: {
  listing: ReservationPage;
  refreshSample: string;
  tab?: MyReservationTab;
  hasIdentity?: boolean;
}) {
  const path = tab ? "/my-reservations" : "/";
  const labels = {
    hosted: "我发起的",
    joined: "我参加的",
    waiting: "我候补的",
  };
  const category = labels[tab ?? "joined"];
  useReservationRefresh({
    sample: refreshSample,
    data: { listing, tab, hasIdentity },
    scope: JSON.stringify([path, tab, listing.filters]),
    scheduledAt: listing.items.map((r) => r.scheduledAt),
  });
  const reservations = listing.items;
  const filtered = !!(
    listing.filters.q ||
    listing.filters.date ||
    listing.filters.view !== "all"
  );
  return (
    <>
      <div className="mb-10 flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="eyebrow mb-3">{tab ? "MY PARTIES" : "THE LOBBY"}</p>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            {tab ? "我的预约" : "游戏预约"}
            <span className="text-lime-300">.</span>
          </h1>
          <p className="mt-3 text-sm text-zinc-400">
            {tab
              ? "仅显示当前浏览器的记录，换设备或清除浏览器数据后无法找回。"
              : "找到你的队友，让下一局准时开始。"}
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <span className="size-2 rounded-full bg-lime-300" />
          {listing.total} 场预约
        </div>
      </div>
      {tab && (
        <nav aria-label="我的预约分类" className="mb-6 flex flex-wrap gap-3">
          {(["joined", "hosted", "waiting"] as const).map((value) => (
            <Button
              key={value}
              asChild
              variant={tab === value ? "default" : "outline"}
            >
              <Link
                prefetch={false}
                aria-current={tab === value ? "page" : undefined}
                href={reservationListUrl(path, listing.filters, 1, value)}
              >
                {labels[value]}
              </Link>
            </Button>
          ))}
        </nav>
      )}
      <ReservationFilters listing={listing} path={path} tab={tab} />
      {listing.filters.view === "available" && (
        <p className="mb-4 text-xs text-zinc-500">空位以提交时为准</p>
      )}
      <div className="mb-6 flex items-center justify-between border-b border-white/10 pb-4">
        <span className="flex items-center gap-2 text-sm font-medium">
          <Gamepad2 size={18} className="text-lime-300" />
          {filtered ? "筛选结果" : tab ? category : "全部预约"}{" "}
          <span className="ml-1 text-zinc-500">
            {listing.total.toString().padStart(2, "0")}
          </span>
        </span>
        <span className="text-xs text-zinc-500">按开玩时间排序 · 北京时间</span>
      </div>
      {reservations.length ? (
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {reservations.map((r, i) => (
            <Link
              key={r.id}
              href={`/reservation/${r.id}`}
              className="panel group overflow-hidden transition hover:-translate-y-1 hover:border-lime-300/40 focus-visible:outline-lime-300"
            >
              <div
                className={`relative flex h-28 items-center justify-between overflow-hidden border-b border-white/5 px-6 ${["bg-[#252d25]", "bg-[#272736]", "bg-[#302729]"][i % 3]}`}
              >
                <Gamepad2 size={64} strokeWidth={1} className="text-white/15" />
                <span className="absolute right-4 top-0 text-8xl font-black italic text-white/[.035]">
                  PLAY
                </span>
                <Badge reservation={r} />
              </div>
              <div className="p-6">
                <h2 className="truncate text-xl font-bold">{r.gameName}</h2>
                <p className="mt-4 flex items-center gap-2 text-sm text-zinc-300">
                  <Clock3 size={15} className="text-zinc-500" />
                  {formatTime(r.scheduledAt)}
                </p>
                <p className="mt-2 truncate text-sm text-zinc-500">
                  发起人：{r.hostName}
                </p>
                <div className="mt-6 h-1 rounded-full bg-white/5">
                  <div
                    className="h-1 rounded-full bg-lime-300/70"
                    style={{
                      width: `${(r.participantCount / r.maxPlayers) * 100}%`,
                    }}
                  />
                </div>
                <div className="mt-4 flex items-center justify-between">
                  <span className="flex items-center gap-2 text-sm text-zinc-400">
                    <Users size={16} />
                    <strong className="text-white">
                      {r.participantCount}
                    </strong>{" "}
                    / {r.maxPlayers} 人
                  </span>
                  <ArrowUpRight
                    size={18}
                    className="text-zinc-500 group-hover:text-lime-300"
                  />
                </div>
                {r.status === "OPEN" && (
                  <p className="mt-3 text-xs text-lime-300">
                    还可报名 {Math.max(0, r.maxPlayers - r.participantCount)} 人
                  </p>
                )}
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="panel flex min-h-80 flex-col items-center justify-center px-6 text-center">
          <Gamepad2 size={48} strokeWidth={1} className="mb-5 text-lime-300" />
          <h2 className="text-xl font-semibold">
            {tab && !hasIdentity
              ? "暂无当前浏览器的预约记录"
              : filtered
                ? "没有符合条件的预约"
                : tab
                  ? tab === "hosted"
                    ? "你还没有发起预约"
                    : tab === "waiting"
                      ? "你还没有候补预约"
                      : "你还没有参加预约"
                  : "大厅已就绪，等你开第一局"}
          </h2>
          <p className="mb-6 mt-3 text-sm text-zinc-400">
            {tab && !hasIdentity
              ? "请使用创建或报名时的浏览器"
              : filtered
                ? "试试其他游戏名称、日期或状态，或清除筛选条件。"
                : tab
                  ? "去大厅寻找队友，或创建自己的预约。"
                  : "选个游戏、定好时间，把链接发给队友。"}
          </p>
          <div className="flex gap-3">
            {tab && (
              <Button asChild variant="outline">
                <Link href="/">去大厅</Link>
              </Button>
            )}
            <Button asChild>
              <Link href="/reservation/new">
                <Plus />
                创建预约
              </Link>
            </Button>
          </div>
        </div>
      )}
      <ReservationPagination listing={listing} path={path} tab={tab} />
    </>
  );
}
