import { NextRequest } from "next/server";
import { body, respond } from "@/server/http";
import {
  joinReservation,
  leaveReservation,
  renameRosterEntry,
} from "@/server/reservations";
type Context = { params: Promise<{ id: string }> };
export const PATCH = (req: NextRequest, context: Context) =>
  respond(req, async (token) =>
    renameRosterEntry(
      (await context.params).id,
      "participants",
      await body(req),
      token,
    ),
  );
export const POST = (req: NextRequest, context: Context) =>
  respond(req, async (token) =>
    joinReservation((await context.params).id, await body(req), token),
  );
export const DELETE = (req: NextRequest, context: Context) =>
  respond(req, async (token) =>
    leaveReservation((await context.params).id, token),
  );
