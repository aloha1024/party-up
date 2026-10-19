import { NextRequest } from "next/server";
import { body, respond } from "@/server/http";
import { setScheduleConfirmation } from "@/server/reservation-schedule-confirmation";

type Context = { params: Promise<{ id: string }> };
export const PATCH = (req: NextRequest, context: Context) =>
  respond(req, async (token) =>
    setScheduleConfirmation((await context.params).id, await body(req), token),
  );
