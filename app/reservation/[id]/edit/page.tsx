import { notFound } from "next/navigation";
import { CreateForm } from "@/components/reservations";
import { detail, AppError } from "@/server/reservations";
import { identity } from "@/server/http";
import { isAdmin } from "@/server/admin";
export const dynamic = "force-dynamic";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  try {
    const reservation = await detail((await params).id, await identity());
    if (!reservation.isHost && !(await isAdmin()))
      return (
        <p role="alert">
          只有发起人或已登录的管理员可以编辑。请使用创建时的浏览器或登录管理员账号。
        </p>
      );
    if (["STARTED", "CANCELLED"].includes(reservation.status))
      return <p role="alert">预约已开始或已取消，无法修改。</p>;
    return <CreateForm reservation={reservation} />;
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  }
}
