import { InvitationEntry } from "@/components/reservation-invitation";
import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { ReservationDetail } from "@/components/reservation-detail";
import { AppError, reservationPageData } from "@/server/reservations";
import { pageIdentity } from "@/server/page-identity";
import { currentAdmin } from "@/server/admin";
export const dynamic = "force-dynamic";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  try {
    const token = await pageIdentity();
    const admin = await currentAdmin();
    const { reservation, history, removals } = await reservationPageData(
      id,
      token,
      admin,
    );
    return (
      <ReservationDetail
        history={history}
        admin={!!admin}
        removals={removals}
        reservation={reservation}
        refreshSample={randomUUID()}
      />
    );
  } catch (e) {
    if (e instanceof AppError && e.code === "INVITATION_REQUIRED")
      return <InvitationEntry key={id} id={id} gate />;
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  }
}
