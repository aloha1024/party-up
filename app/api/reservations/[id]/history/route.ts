import { currentAdmin } from "@/server/admin";
import { NextRequest } from "next/server";
import { respond } from "@/server/http";
import {
  historyCursor,
  reservationHistory,
} from "@/server/reservation-history";

export const GET = (
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) =>
  respond(
    req,
    async (token) => {
      const before = historyCursor(req.nextUrl.searchParams);
      return reservationHistory(
        (await context.params).id,
        before,
        token,
        !!(await currentAdmin()),
      );
    },
    false,
  );
