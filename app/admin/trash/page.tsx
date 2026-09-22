import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAdmin, canCreateAdministrators } from "@/server/admin";
import { listDeletedReservations } from "@/server/reservation-trash";
import { AdminPanel } from "@/components/admin-panel";
import { ReservationTrash } from "@/components/reservation-trash";
import { reservationTrashSchema } from "@/lib/reservation-trash";
import type { PageSearchParams } from "@/lib/reservation-list";
export const dynamic = "force-dynamic";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin");
  const parsed = reservationTrashSchema.safeParse(await searchParams);
  return (
    <AdminPanel
      authenticated
      reservations={[]}
      view="trash"
      canCreateAdmins={canCreateAdministrators(admin)}
    >
      {parsed.success ? (
        <ReservationTrash
          listing={await listDeletedReservations(parsed.data)}
        />
      ) : (
        <div className="panel space-y-4 p-6">
          <p role="alert">筛选条件无效，请检查搜索长度、移入日期和页码。</p>
          <Link className="text-lime-300 underline" href="/admin/trash">
            清除筛选，返回回收站
          </Link>
        </div>
      )}
    </AdminPanel>
  );
}
