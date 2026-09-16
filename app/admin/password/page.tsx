import { redirect } from "next/navigation";
import { isAdmin } from "@/server/admin";
import { AdminPanel } from "@/components/admin-panel";

export const dynamic = "force-dynamic";

export default async function Page() {
  if (!(await isAdmin())) redirect("/admin");
  return <AdminPanel authenticated reservations={[]} view="password" />;
}
