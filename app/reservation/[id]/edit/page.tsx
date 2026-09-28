import { notFound } from "next/navigation";
import { CreateForm } from "@/components/reservation-form";
import { detail, AppError } from "@/server/reservations";
import { pageIdentity } from "@/server/page-identity";
import { isAdmin } from "@/server/admin";
export const dynamic = "force-dynamic";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  try {
    const { id } = await params;
    const token = await pageIdentity();
    const admin = await isAdmin();
    const reservation = await detail(id, token, admin);
    if (!reservation.isHost && !admin)
      return (
        <p role="alert">
          只有发起人或已登录的管理员可以编辑。请使用创建时的浏览器或登录管理员账号。
        </p>
      );
    if (["STARTED", "CANCELLED", "ENDED"].includes(reservation.status))
      return <p role="alert">预约已开始、已结束或已取消，无法修改。</p>;
    return <CreateForm key={reservation.id} reservation={reservation} />;
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  }
}
