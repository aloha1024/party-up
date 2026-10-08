import { NextRequest } from "next/server";
import { body, respond } from "@/server/http";
import { currentAdmin } from "@/server/admin";
import { setMeeting } from "@/server/reservation-meeting";
import { detail } from "@/server/reservation-detail";
type Context = { params: Promise<{ id: string }> };
export const GET = (req: NextRequest, context: Context) =>
  respond(
    req,
    async (token) =>
      (await detail((await context.params).id, token, !!(await currentAdmin())))
        .meeting,
  );
export const PATCH = (req: NextRequest, context: Context) =>
  respond(req, async (token) =>
    setMeeting(
      (await context.params).id,
      await body(req),
      token,
      await currentAdmin(),
    ),
  );
