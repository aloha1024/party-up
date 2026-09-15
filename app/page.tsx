import { ReservationList } from "@/components/reservations";
import { listReservations } from "@/server/reservations";
export const dynamic = "force-dynamic";
export default async function Home() {
  return <ReservationList reservations={await listReservations()} />;
}
