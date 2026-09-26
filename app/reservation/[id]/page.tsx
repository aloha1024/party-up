import { InvitationEntry } from "@/components/reservation-invitation";
import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { ReservationDetail } from "@/components/reservation-detail";
import { AppError, detail } from "@/server/reservations";
import { identity } from "@/server/http";
import { currentAdmin } from "@/server/admin";
import { rosterRemovals } from "@/server/roster-removals";
import { reservationHistory } from "@/server/reservation-history";
export const dynamic = "force-dynamic";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  try {
    const token = await identity();
    const admin = await currentAdmin();
    const reservation = await detail(id, token, !!admin);
    return (
      <ReservationDetail
        history={await reservationHistory(id, undefined, token, !!admin)}
        admin={!!admin}
        removals={await rosterRemovals(id, token, admin)}
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
