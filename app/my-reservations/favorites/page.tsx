import { randomUUID } from "node:crypto";
import Link from "next/link";
import { ReservationList } from "@/components/reservation-list";
import { InvalidReservationFilters } from "@/components/invalid-reservation-filters";
import {
  reservationListSchema,
  type PageSearchParams,
} from "@/lib/reservation-list";
import { currentPageViewer } from "@/server/page-identity";
import { requireUser } from "@/server/user-accounts";
import { listFavorites } from "@/server/reservation-favorites";
import { AppError } from "@/server/errors";

export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const viewer = await currentPageViewer();
  try {
    requireUser(viewer);
    const parsed = reservationListSchema.safeParse(await searchParams);
    if (!parsed.success)
      return <InvalidReservationFilters path="/my-reservations/favorites" />;
    return (
      <ReservationList
        key={viewer.scope}
        listing={await listFavorites(viewer, parsed.data)}
        refreshSample={randomUUID()}
        favorites
      />
    );
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "USER_SESSION")
      throw error;
    const needsAccount = viewer.mode === "user" || viewer.mode === "invalid";
    return (
      <section className="panel mx-auto max-w-xl space-y-4 p-6">
        <h1 className="text-3xl font-bold">我的收藏</h1>
        <p role="alert">{error.message}</p>
        <p className="text-sm text-zinc-400">
          收藏仅当前账号可见，登录同一账号可跨设备查看。
        </p>
        <Link
          className="inline-block text-lime-300"
          href={
            needsAccount
              ? "/account"
              : "/account/login?returnTo=%2Fmy-reservations%2Ffavorites"
          }
        >
          {needsAccount ? "前往个人账号" : "登录账号"}
        </Link>
      </section>
    );
  }
}
