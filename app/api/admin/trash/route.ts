import { NextRequest } from "next/server";
import { requireAdmin } from "@/server/admin";
import { respond } from "@/server/http";
import { listDeletedReservations } from "@/server/reservation-trash";
import { listSearchParams } from "@/lib/reservation-list";

export const GET = (req: NextRequest) =>
  respond(
    req,
    async () => {
      await requireAdmin();
      return listDeletedReservations(
        listSearchParams(req.nextUrl.searchParams),
      );
    },
    false,
  );
