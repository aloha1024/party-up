import { NextRequest } from "next/server";
import { respond } from "@/server/http";
import { calendarReservation } from "@/server/reservation-calendar";
export const GET = (
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) =>
  respond(req, async (token) =>
    calendarReservation((await context.params).id, token),
  );
