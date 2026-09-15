import { NextRequest } from "next/server";
import { body, respond } from "@/server/http";
import { joinReservation, leaveReservation } from "@/server/reservations";
type Context = { params: Promise<{ id: string }> };
export const POST = (req: NextRequest, context: Context) =>
  respond(req, async (token) =>
    joinReservation((await context.params).id, await body(req), token),
  );
export const DELETE = (req: NextRequest, context: Context) =>
  respond(req, async (token) =>
    leaveReservation((await context.params).id, token),
  );
