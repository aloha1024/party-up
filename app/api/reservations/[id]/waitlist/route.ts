import { NextRequest } from "next/server";
import { body, respond } from "@/server/http";
import {
  joinWaitlist,
  leaveWaitlist,
  renameRosterEntry,
} from "@/server/reservations";
type Context = { params: Promise<{ id: string }> };
export const PATCH = (req: NextRequest, context: Context) =>
  respond(req, async (token) =>
    renameRosterEntry(
      (await context.params).id,
      "waitlist",
      await body(req),
      token,
    ),
  );
export const POST = (req: NextRequest, context: Context) =>
  respond(req, async (token) =>
    joinWaitlist((await context.params).id, await body(req), token),
  );
export const DELETE = (req: NextRequest, context: Context) =>
  respond(req, async (token) =>
    leaveWaitlist((await context.params).id, token),
  );
