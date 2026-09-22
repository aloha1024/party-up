import { redirect } from "next/navigation";
import { currentAdmin, canCreateAdministrators } from "@/server/admin";
import { listDeletedReservations } from "@/server/reservations";
import { AdminPanel } from "@/components/admin-panel";
import { ReservationTrash } from "@/components/reservation-trash";
export const dynamic = "force-dynamic";
export default async function Page() {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin");
  return (
    <AdminPanel
      authenticated
      reservations={[]}
      view="trash"
      canCreateAdmins={canCreateAdministrators(admin)}
    >
      <ReservationTrash reservations={await listDeletedReservations()} />
    </AdminPanel>
  );
}
