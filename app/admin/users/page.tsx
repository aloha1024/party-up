import { redirect } from "next/navigation";
import { currentAdmin, canCreateAdministrators } from "@/server/admin";
import { listUsers } from "@/server/user-accounts";
import { AdminPanel } from "@/components/admin-panel";
import { AdminUsers } from "@/components/admin-users";
export const dynamic = "force-dynamic";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin");
  const query = await searchParams;
  if (
    (typeof query.q !== "undefined" && typeof query.q !== "string") ||
    (typeof query.page !== "undefined" && typeof query.page !== "string")
  )
    return <p role="alert">查询参数无效</p>;
  let listing;
  try {
    listing = await listUsers(query);
  } catch {
    return <p role="alert">查询参数无效，请返回普通账号管理。</p>;
  }
  return (
    <AdminPanel
      authenticated
      reservations={[]}
      view="users"
      canCreateAdmins={canCreateAdministrators(admin)}
    >
      <AdminUsers listing={listing} q={query.q || ""} />
    </AdminPanel>
  );
}
