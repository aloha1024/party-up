import { randomUUID } from "node:crypto";
import { ReservationList } from "@/components/reservation-list";
import { InvalidReservationFilters } from "@/components/invalid-reservation-filters";
import {
  myReservationListSchema,
  type PageSearchParams,
} from "@/lib/reservation-list";
import { identity } from "@/server/http";
import { listMyReservations } from "@/server/reservation-list";

export const dynamic = "force-dynamic";

export default async function MyReservations({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const parsed = myReservationListSchema.safeParse(await searchParams);
  if (!parsed.success)
    return <InvalidReservationFilters path="/my-reservations" />;
  const token = await identity();
  return (
    <ReservationList
      listing={await listMyReservations(parsed.data, token)}
      refreshSample={randomUUID()}
      tab={parsed.data.tab}
      hasIdentity={!!token}
    />
  );
}
