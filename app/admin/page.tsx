import { currentAdmin, canCreateAdministrators } from "@/server/admin";
import { listReservations } from "@/server/reservation-list";
import { AdminPanel } from "@/components/admin-panel";
import { InvalidReservationFilters } from "@/components/invalid-reservation-filters";
import {
  reservationListSchema,
  type PageSearchParams,
} from "@/lib/reservation-list";
export const dynamic = "force-dynamic";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const admin = await currentAdmin();
  const parsed = reservationListSchema.safeParse(await searchParams);
  if (admin && !parsed.success)
    return <InvalidReservationFilters path="/admin" />;
  const listing =
    admin && parsed.success ? await listReservations(parsed.data) : undefined;
  return (
    <AdminPanel
      authenticated={!!admin}
      canCreateAdmins={!!admin && canCreateAdministrators(admin)}
      reservations={listing?.items ?? []}
      listing={listing}
    />
  );
}
