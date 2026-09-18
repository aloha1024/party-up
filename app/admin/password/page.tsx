import { redirect } from "next/navigation";
import { currentAdmin, canCreateAdministrators } from "@/server/admin";
import { AdminPanel } from "@/components/admin-panel";

export const dynamic = "force-dynamic";

export default async function Page() {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin");
  return (
    <AdminPanel
      canCreateAdmins={canCreateAdministrators(admin)}
      authenticated
      reservations={[]}
      view="password"
    />
  );
}
