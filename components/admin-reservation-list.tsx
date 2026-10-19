import Link from "next/link";
import { toast } from "sonner";
import { request } from "@/lib/client-request";
import { recruitmentClosure } from "@/lib/recruitment";
import { formatTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  ReservationFilters,
  ReservationPagination,
} from "./reservation-filters";
import { ReservationPlatform } from "./reservation-platform";
import type { ReservationSummary, ReservationPage } from "@/types/reservation";
import type { AdminOperation } from "./admin-operation";

export function AdminReservationList({
  reservations,
  listing,
  operation,
}: {
  reservations: ReservationSummary[];
  listing?: ReservationPage;
  operation: AdminOperation;
}) {
  const { pending, run, checkOnline, refreshAfterSuccess } = operation;
  const filtered = !!(
    listing &&
    (listing.filters.q ||
      listing.filters.platform ||
      listing.filters.gameServer ||
      listing.filters.date ||
      listing.filters.view !== "all")
  );

  return (
    <>
      {listing && (
        <>
          <ReservationFilters listing={listing} path="/admin" />
          {listing.filters.view === "available" && (
            <p className="text-xs text-zinc-500">空位以提交时为准</p>
          )}
        </>
      )}
      <p className="text-sm text-zinc-400">
        共 {listing?.total ?? reservations.length}{" "}
        场预约。移入回收站后不再公开展示，可在回收站恢复。
      </p>
      {reservations.map((r) => (
        <div
          className="panel flex flex-wrap items-center justify-between gap-4 p-5"
          key={r.id}
        >
          <div className="min-w-0 w-full sm:w-auto sm:flex-1">
            <Link
              className="break-all text-lg font-semibold hover:text-lime-300"
              href={`/reservation/${r.id}`}
            >
              {r.gameName}
              {r.visibility === "INVITE" && (
                <span className="ml-2 text-xs text-amber-300">邀请制</span>
              )}
            </Link>
            <p className="mt-2 text-sm text-zinc-400">
              {formatTime(r.scheduledAt)} · {r.hostName} · {r.participantCount}/
              {r.maxPlayers} 人
              {r.status === "OPEN" && !recruitmentClosure(r) && (
                <span className="ml-3 text-lime-300">
                  还可报名 {Math.max(0, r.maxPlayers - r.participantCount)} 人
                </span>
              )}
            </p>
            <ReservationPlatform
              platform={r.platform}
              gameServer={r.gameServer}
            />
          </div>
          <div className="flex gap-2">
            {!["STARTED", "CANCELLED", "ENDED"].includes(r.status) && (
              <Button asChild variant="outline">
                <Link href={`/reservation/${r.id}/edit`}>编辑预约</Link>
              </Button>
            )}
            <Button
              className="text-red-400 hover:text-red-300"
              variant="outline"
              disabled={pending}
              onClick={() => {
                if (pending || !checkOnline()) return;
                if (
                  window.confirm(
                    `确定将「${r.gameName}」移入回收站？可在回收站恢复。`,
                  )
                )
                  run(async () => {
                    await request(`/api/admin/reservations/${r.id}`, "DELETE");
                    toast.success("预约已移入回收站");
                    refreshAfterSuccess();
                  });
              }}
            >
              移入回收站
            </Button>
          </div>
        </div>
      ))}
      {listing && <ReservationPagination listing={listing} path="/admin" />}
      {!reservations.length && (
        <p className="panel p-8 text-center text-zinc-400">
          {filtered ? "没有符合条件的预约" : "暂无预约"}
        </p>
      )}
    </>
  );
}
