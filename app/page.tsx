import { ReservationList } from "@/components/reservations";
import { InvalidReservationFilters } from "@/components/invalid-reservation-filters";
import { listReservations } from "@/server/reservation-list";
import {
  reservationListSchema,
  type PageSearchParams,
} from "@/lib/reservation-list";
export const dynamic = "force-dynamic";
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const parsed = reservationListSchema.safeParse(await searchParams);
  if (!parsed.success) return <InvalidReservationFilters />;
  return <ReservationList listing={await listReservations(parsed.data)} />;
}
