import { isAdmin } from "@/server/admin";
import { listReservations } from "@/server/reservations";
import { AdminPanel } from "@/components/admin-panel";
export const dynamic = "force-dynamic";
export default async function Page() {
  const authenticated = await isAdmin();
  return (
    <AdminPanel
      authenticated={authenticated}
      reservations={authenticated ? await listReservations() : []}
    />
  );
}
