import { NextRequest } from "next/server";
import { body, respond } from "@/server/http";
import { setAttendance } from "@/server/reservation-attendance";
type Context = { params: Promise<{ id: string }> };
export const PATCH = (req: NextRequest, context: Context) =>
  respond(req, async (token) =>
    setAttendance((await context.params).id, await body(req), token),
  );
