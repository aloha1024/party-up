import { currentAdmin, canCreateAdministrators } from "@/server/admin";
import { listReservations } from "@/server/reservations";
import { AdminPanel } from "@/components/admin-panel";
export const dynamic = "force-dynamic";
export default async function Page() {
  const admin = await currentAdmin();
  const authenticated = !!admin;
  return (
    <AdminPanel
      authenticated={authenticated}
      canCreateAdmins={!!admin && canCreateAdministrators(admin)}
      reservations={authenticated ? await listReservations() : []}
    />
  );
}
