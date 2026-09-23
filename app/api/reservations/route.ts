import { creationKeySchema } from "@/lib/creation-result";
import { NextRequest } from "next/server";
import { body, respond } from "@/server/http";
import { createReservation } from "@/server/reservations";
import { listReservations } from "@/server/reservation-list";
import { listSearchParams } from "@/lib/reservation-list";
export const runtime = "nodejs";
export const GET = (req: NextRequest) =>
  respond(
    req,
    () => listReservations(listSearchParams(req.nextUrl.searchParams)),
    false,
  );
export const POST = (req: NextRequest) =>
  respond(req, async (token) => {
    const key = creationKeySchema.parse(req.headers.get("idempotency-key"));
    return createReservation(await body(req), token, key);
  });
