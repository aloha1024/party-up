import { notFound } from "next/navigation";
import { ReservationDetail } from "@/components/reservations";
import { AppError, detail } from "@/server/reservations";
import { identity } from "@/server/http";
import { isAdmin } from "@/server/admin";
export const dynamic = "force-dynamic";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  try {
    return (
      <ReservationDetail
        admin={await isAdmin()}
        reservation={await detail((await params).id, await identity())}
      />
    );
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  }
}
