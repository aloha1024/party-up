import { redirect } from "next/navigation";
import { currentAdmin, canCreateAdministrators } from "@/server/admin";
import { db } from "@/server/db";
import { AdminPanel } from "@/components/admin-panel";
import { AdminAccounts } from "@/components/admin-accounts";

export const dynamic = "force-dynamic";

export default async function Page() {
  const admin = await currentAdmin();
  if (!admin || !canCreateAdministrators(admin)) redirect("/admin");
  const accounts = await db.adminCredential.findMany({
    select: {
      id: true,
      username: true,
      mustChangePassword: true,
      isActive: true,
    },
    orderBy: { id: "asc" },
  });
  return (
    <AdminPanel authenticated reservations={[]} view="accounts" canCreateAdmins>
      <AdminAccounts accounts={accounts} />
    </AdminPanel>
  );
}
