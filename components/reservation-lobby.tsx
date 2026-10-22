"use client";

import Link from "next/link";
import { ArrowUpRight, Clock3, Gamepad2, Plus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/reservation-ui";
import {
  ReservationFilters,
  ReservationPagination,
} from "@/components/reservation-filters";
import { recruitmentClosure } from "@/lib/recruitment";
import { formatTime } from "@/lib/utils";
import type { ReservationPage } from "@/types/reservation";

export function ReservationLobby({ listing }: { listing: ReservationPage }) {
  const filtered = !!(
    listing.filters.q ||
    listing.filters.date ||
    listing.filters.view !== "all"
  );
  return (
    <div className="lobby min-w-0">
      <section
        aria-labelledby="lobby-title"
        className="mb-8 flex flex-col gap-6 border-b border-white/10 pb-8 sm:mb-10 sm:flex-row sm:items-end sm:justify-between sm:pb-10"
      >
        <div className="min-w-0">
          <p className="mb-4 flex items-center gap-2 text-xs font-medium tracking-wider text-lime-300">
            <span
              className="size-1.5 rounded-full bg-lime-300"
              aria-hidden="true"
            />
            游戏预约大厅
          </p>
          <h1
            id="lobby-title"
            className="text-3xl font-bold tracking-tight sm:text-5xl sm:leading-tight"
          >
            好队友，<span className="text-lime-300">一起约。</span>
          </h1>
          <p className="mt-4 text-sm leading-6 text-zinc-400">
            找到想玩的游戏，约好下一局的时间。
          </p>
        </div>
        <Button asChild className="w-fit shrink-0">
          <Link href="/reservation/new">
            <Plus aria-hidden="true" />
            发起一场预约
          </Link>
        </Button>
      </section>

      <ReservationFilters listing={listing} />

      <section aria-labelledby="lobby-results-title" className="mt-8">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <h2
            id="lobby-results-title"
            className="flex items-center gap-3 text-lg font-semibold"
          >
            {filtered ? "筛选结果" : "全部预约"}
            <span className="rounded-md bg-white/5 px-2 py-0.5 text-xs font-normal tabular-nums text-zinc-400">
              {listing.total} 场
            </span>
          </h2>
          <p className="text-xs text-zinc-500">按开玩时间排序 · 北京时间</p>
        </div>
        {listing.filters.view === "available" && (
          <p className="mb-4 text-xs text-zinc-500">空位以提交时为准</p>
        )}
        {listing.items.length ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {listing.items.map((reservation) => {
              const available =
                reservation.status === "OPEN" &&
                !recruitmentClosure(reservation);
              return (
                <Link
                  key={reservation.id}
                  href={`/reservation/${reservation.id}`}
                  className="panel group flex min-w-0 flex-col p-5 transition-colors hover:border-lime-300/40 hover:bg-[#1e211e] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-lime-300 sm:p-6"
                >
                  <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                    <span className="flex size-10 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-zinc-400">
                      <Gamepad2
                        size={21}
                        strokeWidth={1.5}
                        aria-hidden="true"
                      />
                    </span>
                    <Badge reservation={reservation} />
                  </div>
                  <h3 className="break-all text-lg font-semibold leading-7 text-zinc-100 group-hover:text-lime-200">
                    {reservation.gameName}
                  </h3>
                  <p className="mt-2 break-all text-sm text-zinc-500">
                    发起人：{reservation.hostName}
                  </p>
                  <p className="mb-5 mt-5 flex items-center gap-2 text-sm text-zinc-300">
                    <Clock3
                      size={16}
                      className="shrink-0 text-zinc-500"
                      aria-hidden="true"
                    />
                    <time dateTime={reservation.scheduledAt}>
                      {formatTime(reservation.scheduledAt)}
                    </time>
                  </p>
                  <div className="mt-auto border-t border-white/10 pt-4">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                      <span className="flex items-center gap-2 text-zinc-400">
                        <Users size={16} aria-hidden="true" />
                        <span>
                          <strong className="font-semibold text-zinc-200">
                            {reservation.participantCount}
                          </strong>{" "}
                          / {reservation.maxPlayers} 人
                        </span>
                      </span>
                      <span className="flex items-center gap-1 text-xs text-zinc-400 group-hover:text-lime-300">
                        查看预约
                        <ArrowUpRight size={15} aria-hidden="true" />
                      </span>
                    </div>
                    <div
                      className="mt-3 h-1 overflow-hidden rounded-full bg-white/5"
                      aria-hidden="true"
                    >
                      <div
                        className={`h-full rounded-full ${available ? "bg-lime-300/70" : "bg-zinc-600"}`}
                        style={{
                          width: `${Math.min(100, (reservation.participantCount / reservation.maxPlayers) * 100)}%`,
                        }}
                      />
                    </div>
                    <p
                      className={`mt-3 text-xs ${available ? "text-lime-300" : "text-zinc-500"}`}
                    >
                      {available
                        ? `还可报名 ${Math.max(0, reservation.maxPlayers - reservation.participantCount)} 人`
                        : "查看预约详情与名单"}
                    </p>
                  </div>
                </Link>
              );
            })}
          </div>
        ) : (
          <div className="panel flex min-h-64 flex-col items-center justify-center px-5 py-10 text-center">
            <span className="mb-4 rounded-2xl bg-white/5 p-4 text-zinc-400">
              <Gamepad2 size={28} strokeWidth={1.5} aria-hidden="true" />
            </span>
            <h3 className="text-lg font-semibold">
              {filtered ? "没有符合条件的预约" : "大厅已就绪，等你开第一局"}
            </h3>
            <p className="mb-5 mt-2 text-sm leading-6 text-zinc-400">
              {filtered
                ? "换个游戏名称、日期或状态试试。"
                : "选个游戏、定好时间，把链接发给队友。"}
            </p>
            <Button asChild variant="outline">
              <Link href={filtered ? "/" : "/reservation/new"}>
                {filtered ? "清除筛选" : "发起第一场预约"}
              </Link>
            </Button>
          </div>
        )}
      </section>
      <ReservationPagination listing={listing} />
    </div>
  );
}
