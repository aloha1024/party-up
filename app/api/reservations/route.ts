import { NextRequest } from "next/server";
import { body, respond } from "@/server/http";
import { createReservation, listReservations } from "@/server/reservations";
export const runtime = "nodejs";
export const GET = (req: NextRequest) => respond(req, listReservations);
export const POST = (req: NextRequest) =>
  respond(req, async (token) => createReservation(await body(req), token));
