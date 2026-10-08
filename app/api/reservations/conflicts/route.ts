import { NextRequest } from "next/server";
import { respond } from "@/server/http";
import { listReservationConflicts } from "@/server/reservation-conflicts";
import { reservationConflictsSearchParams } from "@/lib/reservation-conflicts";

export const runtime = "nodejs";
export const GET = (req: NextRequest) =>
  respond(req, (token) =>
    listReservationConflicts(
      token,
      reservationConflictsSearchParams(req.nextUrl.searchParams),
    ),
  );
