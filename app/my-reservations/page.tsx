import { randomUUID } from "node:crypto";
import { ReservationList } from "@/components/reservation-list";
import { InvalidReservationFilters } from "@/components/invalid-reservation-filters";
import { type PageSearchParams } from "@/lib/reservation-list";
import { pageIdentity } from "@/server/page-identity";
import { listMyReservations } from "@/server/reservation-list";
import { personalPageSchema } from "@/lib/reservation-schedule";
import { listMySchedule } from "@/server/reservation-schedule";
import { ReservationSchedule } from "@/components/reservation-schedule";
import { PersonalViewSwitch } from "@/components/personal-view-switch";

export const dynamic = "force-dynamic";

export default async function MyReservations({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const parsed = personalPageSchema.safeParse(await searchParams);
  if (!parsed.success)
    return <InvalidReservationFilters path="/my-reservations" />;
  const token = await pageIdentity();
  if (parsed.data.layout === "schedule") {
    const listing = await listMySchedule(parsed.data, token);
    return (
      <>
        <PersonalViewSwitch
          filters={{ ...parsed.data, schedulePage: listing.page }}
        />
        <ReservationSchedule
          listing={listing}
          filters={parsed.data}
          refreshSample={randomUUID()}
          hasIdentity={!!token}
        />
      </>
    );
  }
  return (
    <>
      <PersonalViewSwitch filters={parsed.data} />
      <ReservationList
        listing={await listMyReservations(parsed.data, token)}
        refreshSample={randomUUID()}
        tab={parsed.data.tab}
        hasIdentity={!!token}
      />
    </>
  );
}
